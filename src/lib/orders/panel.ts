// Leituras de pedidos do painel: lista com filtros (50 por página), contagens, detalhe completo e exportação CSV.
// CPF nunca sai na lista nem no CSV; no detalhe só mascarado.
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { auditLog, customer, downloadLink, emailLog, offer, orderItem, orders, payment, product } from "@/lib/db/schema";
import { brl, orderCode } from "@/lib/format";
import { getIntegration } from "@/lib/integrations";
import { maskCpf, maskCpfStrict } from "@/lib/privacy";
import { hasOpenJob } from "@/lib/jobs";
import { refundMarkerOf } from "@/lib/payments/asaas/refunds";
import { hasOldAccountEvent } from "@/lib/payments/asaas/webhook";
import { groupItems, itemOrder } from "./items";
import { METHOD_LABEL, ORDER_METHODS, ORDER_STATUSES, STATUS_LABEL, type OrderMethod, type OrderStatus, type RefundState } from "./labels";

export { allowedOrderActions } from "./labels";
export { maskCpf };

export const PAGE_SIZE = 50;
const EXPORT_MAX = 10_000;
/** Estorno pedido ao Asaas sem confirmação depois disto: o painel sugere conferir e pedir de novo. */
const REFUND_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const status = z.enum(ORDER_STATUSES as [OrderStatus, ...OrderStatus[]]);
const method = z.enum(ORDER_METHODS as [OrderMethod, ...OrderMethod[]]);
// `status`/`method`: um valor (MCP e chamadas antigas). `statuses`/`methods`: vários de uma vez (filtros do painel).
const filters = {
  status: status.optional(),
  method: method.optional(),
  statuses: z.array(status).max(ORDER_STATUSES.length).optional(),
  methods: z.array(method).max(ORDER_METHODS.length).optional(),
  q: z.string().trim().max(100).optional(),
};

/** Texto da busca como literal do LIKE (%, _ e \ não são curingas). */
const likeLiteral = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const buyerName = sql<string>`coalesce(${orders.buyerName}, ${customer.name})`;

function where(
  f: { status?: OrderStatus; method?: OrderMethod; statuses?: OrderStatus[]; methods?: OrderMethod[]; q?: string },
  withStatus: boolean,
): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  if (withStatus && f.statuses?.length) parts.push(inArray(orders.status, f.statuses));
  else if (withStatus && f.status) parts.push(eq(orders.status, f.status));
  if (f.methods?.length) parts.push(inArray(orders.method, f.methods));
  else if (f.method) parts.push(eq(orders.method, f.method));
  if (f.q) {
    const like = likeLiteral(f.q);
    parts.push(or(ilike(buyerName, like), ilike(customer.email, like)));
  }
  return and(...parts);
}

export const listOrders = defineAction({
  name: "orders.list",
  description: "Lista pedidos (50 por página, mais recentes primeiro) com filtros de status e método e busca por e-mail ou nome.",
  input: z.object({ ...filters, page: z.number().int().min(1).max(10_000).default(1) }),
  permission: "orders.read",
  audit: false,
  async run(ctx, input) {
    const base = () => ctx.tx.select({ n: count().mapWith(Number) }).from(orders).innerJoin(customer, eq(customer.id, orders.customerId));
    const [total] = await base().where(where(input, true));
    const byStatus = await ctx.tx
      .select({ status: orders.status, n: count().mapWith(Number) })
      .from(orders)
      .innerJoin(customer, eq(customer.id, orders.customerId))
      .where(where(input, false))
      .groupBy(orders.status);
    const counts: Record<OrderStatus | "all", number> = { all: 0, pending: 0, paid: 0, refunded: 0, disputed: 0, expired: 0, declined: 0 };
    for (const r of byStatus) {
      counts[r.status as OrderStatus] = r.n;
      counts.all += r.n;
    }
    const rows = await ctx.tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        createdAt: orders.createdAt,
        status: orders.status,
        method: orders.method,
        totalCents: orders.totalCents,
        manualAmountCents: orders.manualAmountCents,
        hasBump: orders.hasBump,
        expiresAt: orders.expiresAt,
        paidAt: orders.paidAt,
        refundRequestedAt: orders.refundRequestedAt,
        buyerName,
        email: customer.email,
        offerName: offer.name,
      })
      .from(orders)
      .innerJoin(customer, eq(customer.id, orders.customerId))
      .innerJoin(offer, eq(offer.id, orders.offerId))
      .where(where(input, true))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(PAGE_SIZE)
      .offset((input.page - 1) * PAGE_SIZE);
    return {
      items: rows.map(({ publicId, ...r }) => ({ ...r, code: orderCode(publicId) })),
      total: total?.n ?? 0,
      page: input.page,
      pageSize: PAGE_SIZE,
      counts,
    };
  },
});

export const orderCounts = defineAction({
  name: "orders.counts",
  description: "Quantos pedidos de Pix manual aguardam o vendedor conferir o extrato e liberar.",
  input: z.object({}),
  permission: "orders.read",
  audit: false,
  async run(ctx) {
    const [r] = await ctx.tx
      .select({ n: count().mapWith(Number) })
      .from(orders)
      .where(
        and(eq(orders.method, "pix_manual"), eq(orders.status, "pending"), or(isNull(orders.expiresAt), gt(orders.expiresAt, new Date()))),
      );
    return { pendingManual: r?.n ?? 0 };
  },
});

export type PaymentFlag = "duplicate" | "superseded" | "old_account_event";

async function refundState(ctx: Ctx, o: { id: string; status: string; refundRequestedAt: Date | null }, payments: { raw: unknown }[]) {
  if (o.status !== "paid" || !o.refundRequestedAt) return { state: "none" as RefundState, requestedAt: o.refundRequestedAt };
  if (await hasOpenJob(ctx.tx, "refund_order", o.id)) return { state: "processing" as RefundState, requestedAt: o.refundRequestedAt };
  // "Aguardando o Asaas" só com a marca de aceite (POST respondido com 2xx ou estorno visto em andamento no Asaas).
  const sent = payments.some((p) => refundMarkerOf(p.raw, o.refundRequestedAt)?.acceptedAt !== undefined);
  const fresh = Date.now() - o.refundRequestedAt.getTime() < REFUND_STALE_MS;
  return { state: (sent && fresh ? "awaiting_provider" : "stale") as RefundState, requestedAt: o.refundRequestedAt };
}

const AUDIT_LABEL: Record<string, string> = {
  "orders.release": "Liberado manualmente",
  "orders.refund": "Reembolso solicitado",
  "orders.resend": "Acesso reenviado",
};
const EMAIL_LABEL: Record<string, [string, string]> = {
  delivery: ["E-mail de acesso enviado", "Falha ao enviar o e-mail de acesso (nova tentativa automática)"],
  seller_notice: ["Aviso enviado ao vendedor", "Falha ao enviar o aviso ao vendedor"],
};

export interface TimelineEntry {
  at: Date;
  kind: string;
  label: string;
  detail?: string;
  actorRole?: string;
}

export const getOrderDetail = defineAction({
  name: "orders.get",
  description: "Detalhe de um pedido: comprador (CPF mascarado), itens, pagamentos, links de download, e-mails, estorno e histórico.",
  input: z.object({ id: z.uuid() }),
  permission: "orders.read",
  audit: false,
  async run(ctx, { id }) {
    const [row] = await ctx.tx
      .select({ o: orders, c: customer, offerName: offer.name, offerSlug: offer.slug })
      .from(orders)
      .innerJoin(customer, eq(customer.id, orders.customerId))
      .innerJoin(offer, eq(offer.id, orders.offerId))
      .where(eq(orders.id, id));
    if (!row) throw new ActionError("not_found", "Pedido não encontrado");
    const { o, c } = row;

    const items = await ctx.tx
      .select({ name: product.name, kind: orderItem.kind, priceCents: orderItem.priceCents })
      .from(orderItem)
      .innerJoin(product, eq(product.id, orderItem.productId))
      .where(eq(orderItem.orderId, o.id))
      .orderBy(...itemOrder)
      // Uma linha de preço por grupo (principal, bump) com os nomes: o preço rateado por PDF não sai do servidor.
      .then(groupItems);
    const pays = await ctx.tx.select().from(payment).where(eq(payment.orderId, o.id)).orderBy(asc(payment.id));
    const links = await ctx.tx
      .select({
        id: downloadLink.id,
        productName: product.name,
        expiresAt: downloadLink.expiresAt,
        downloads: downloadLink.downloads,
        maxDownloads: downloadLink.maxDownloads,
        revokedAt: downloadLink.revokedAt,
        revokedReason: downloadLink.revokedReason,
        lastDownloadAt: downloadLink.lastDownloadAt,
        createdAt: downloadLink.createdAt,
      })
      .from(downloadLink)
      .innerJoin(product, eq(product.id, downloadLink.productId))
      // Os links de uma entrega nascem na mesma transação (mesmo created_at): desempata pela ordem dos itens do pedido.
      .innerJoin(orderItem, and(eq(orderItem.orderId, downloadLink.orderId), eq(orderItem.productId, downloadLink.productId)))
      .where(eq(downloadLink.orderId, o.id))
      .orderBy(asc(downloadLink.createdAt), ...itemOrder);
    const emails = await ctx.tx
      .select({ kind: emailLog.kind, status: emailLog.status, deliveryStatus: emailLog.deliveryStatus, error: emailLog.error, at: emailLog.at })
      .from(emailLog)
      .where(and(eq(emailLog.orderId, o.id), inArray(emailLog.kind, ["delivery", "seller_notice"])))
      .orderBy(asc(emailLog.at), asc(emailLog.id));
    const audits = await ctx.tx
      .select({ action: auditLog.action, actor: auditLog.actor, input: auditLog.input, at: auditLog.at })
      .from(auditLog)
      .where(and(eq(auditLog.ok, true), sql`${auditLog.input}->>'orderId' = ${o.id}`))
      .orderBy(asc(auditLog.at))
      .limit(100);

    let pix: { key: string; receiver: string; amountCents: number | null } | null = null;
    if (o.method === "pix_manual") {
      const cfg = (await getIntegration(ctx.tx, ctx.storeId, "pix_manual"))?.config as { key?: string; name?: string } | undefined;
      pix = { key: cfg?.key ?? "", receiver: cfg?.name ?? "", amountCents: o.manualAmountCents };
    }

    const timeline: TimelineEntry[] = [
      { at: o.createdAt, kind: "created", label: `Pedido criado pela oferta “${row.offerName}”`, detail: METHOD_LABEL[o.method as OrderMethod] },
    ];
    if (o.paidAt) timeline.push({ at: o.paidAt, kind: "paid", label: "Pagamento confirmado" });
    if (o.status === "expired" && o.expiresAt) timeline.push({ at: o.expiresAt, kind: "expired", label: "Pix expirou sem pagamento" });
    for (const a of audits) {
      const actor = a.actor as { kind?: string; role?: string };
      const renew = (a.input as { renew?: boolean }).renew === true;
      timeline.push({
        at: a.at,
        kind: a.action,
        label: (AUDIT_LABEL[a.action] ?? a.action) + (renew ? " com links novos" : ""),
        ...(actor.kind === "user" && actor.role ? { actorRole: actor.role } : {}),
      });
    }
    for (const e of emails) {
      const l = EMAIL_LABEL[e.kind];
      if (l) timeline.push({ at: e.at, kind: `email.${e.status}`, label: e.status === "sent" ? l[0] : l[1] });
    }
    timeline.sort((a, b) => b.at.getTime() - a.at.getTime());

    const snapshot = o.buyerName !== null;
    // Só usuário do painel: o erro cru do SMTP costuma trazer o e-mail do comprador, e um token MCP nunca o recebe.
    const seesConnections = ctx.actor.kind === "user" && hasPermission(ctx.actor.role, "connections.read");
    return {
      id: o.id,
      code: orderCode(o.publicId),
      publicId: o.publicId,
      identifier: o.publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 25),
      status: o.status as OrderStatus,
      method: o.method as OrderMethod,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      expiresAt: o.expiresAt,
      subtotalCents: o.subtotalCents,
      totalCents: o.totalCents,
      manualAmountCents: o.manualAmountCents,
      hasBump: o.hasBump,
      offer: { id: o.offerId, name: row.offerName, slug: row.offerSlug },
      buyer: {
        name: o.buyerName ?? c.name,
        email: c.email,
        phone: o.buyerPhone ?? c.phone,
        // Token MCP: só os 2 últimos dígitos (a máscara do painel mostra os do meio; uma não se deriva da outra).
        cpfMasked: (ctx.actor.kind === "token" ? maskCpfStrict : maskCpf)(snapshot ? o.buyerCpf : c.cpf),
      },
      items,
      payments: pays.map((p) => {
        const raw = (p.raw ?? {}) as { duplicate?: boolean };
        const flags: PaymentFlag[] = [];
        if (raw.duplicate === true) flags.push("duplicate");
        if (p.status === "superseded") flags.push("superseded");
        if (hasOldAccountEvent(p.raw)) flags.push("old_account_event");
        return { id: p.id, provider: p.provider, providerId: p.providerId, status: p.status, amountCents: p.amountCents, flags };
      }),
      links,
      // O texto do erro do SMTP (servidor, porta, motivo) só para quem vê as conexões; os demais veem que falhou.
      emails: emails.map((e) => ({ ...e, error: e.error === null || seesConnections ? e.error : "falha no envio" })),
      refund: await refundState(ctx, o, pays),
      attribution: { firstTouch: o.firstTouch as Record<string, string> | null, lastTouch: o.lastTouch as Record<string, string> | null, ref: o.ref, hasFbc: o.fbc !== null },
      pix,
      timeline,
    };
  },
});

export type OrderDetail = Awaited<ReturnType<typeof getOrderDetail.run>>;

export const exportOrders = defineAction({
  name: "orders.export",
  description: "Pedidos para a planilha CSV (sem CPF): data, status, método, produtos, valor, comprador e origem.",
  input: z.object(filters),
  permission: "orders.export",
  async run(ctx, input) {
    const rows = await ctx.tx
      .select({
        id: orders.id,
        createdAt: orders.createdAt,
        status: orders.status,
        method: orders.method,
        totalCents: orders.totalCents,
        name: buyerName,
        email: customer.email,
        phone: sql<string>`coalesce(${orders.buyerPhone}, ${customer.phone})`,
        lastTouch: orders.lastTouch,
        ref: orders.ref,
      })
      .from(orders)
      .innerJoin(customer, eq(customer.id, orders.customerId))
      .where(where(input, true))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(EXPORT_MAX);
    const ids = rows.map((r) => r.id);
    const items = ids.length
      ? await ctx.tx
          .select({ orderId: orderItem.orderId, name: product.name, kind: orderItem.kind })
          .from(orderItem)
          .innerJoin(product, eq(product.id, orderItem.productId))
          .where(inArray(orderItem.orderId, ids))
          .orderBy(...itemOrder)
      : [];
    const names = new Map<string, string[]>();
    for (const i of items) names.set(i.orderId, [...(names.get(i.orderId) ?? []), i.name]);
    return rows.map(({ id: orderId, lastTouch, ...r }) => {
      const t = (lastTouch ?? {}) as Record<string, string>;
      return { ...r, products: names.get(orderId) ?? [], utmSource: t.utm_source ?? "", utmCampaign: t.utm_campaign ?? "", ref: r.ref ?? "" };
    });
  },
});

const SP = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Célula CSV: SEMPRE entre aspas (vírgula e ponto e vírgula nunca viram separador, seja qual for a configuração do
 * Excel) e com apóstrofo na frente quando pode virar fórmula: começa com =, +, -, @, tab ou CR, ou tem um desses logo
 * depois de vírgula ou ponto e vírgula (se o arquivo for aberto partindo por vírgula, o pedaço viraria célula própria).
 */
export function csvCell(v: string): string {
  const risky = /^[=+\-@\t\r]/.test(v) || /[,;]\s*[=+\-@\t\r]/.test(v);
  return `"${(risky ? `'${v}` : v).replace(/"/g, '""')}"`;
}

/** CSV (separador `;`, CRLF, BOM fica na rota) no formato do Excel em português. */
export function ordersCsv(rows: Awaited<ReturnType<typeof exportOrders.run>>): string {
  const header = ["data", "status", "método", "produto(s)", "valor", "nome", "e-mail", "telefone", "utm_source", "utm_campaign", "ref"];
  const lines = rows.map((r) =>
    [
      SP.format(r.createdAt).replace(",", ""),
      STATUS_LABEL[r.status as OrderStatus] ?? r.status,
      METHOD_LABEL[r.method as OrderMethod] ?? r.method,
      r.products.join(" + "),
      brl(r.totalCents).replace("R$ ", ""),
      r.name,
      r.email,
      r.phone,
      r.utmSource,
      r.utmCampaign,
      r.ref,
    ]
      .map((v) => csvCell(String(v)))
      .join(";"),
  );
  return [header.map(csvCell).join(";"), ...lines].join("\r\n") + "\r\n";
}
