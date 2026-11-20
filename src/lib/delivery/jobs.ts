// Handlers da fila para entrega e avisos, e a ação `orders.resend`.
// At-least-once: todo handler é idempotente e decide pelo estado ATUAL do pedido (insensível à ordem dos jobs);
// re-escopa com withStore(job.storeId); nenhuma rede (SMTP) dentro de transação; respeita o AbortSignal do worker.
import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { TELEGRAM_MIGRATED } from "@/lib/alerts";
import { txidOf } from "@/lib/checkout";
import { db, withStore, type Tx } from "@/lib/db/client";
import { customer, downloadLink, emailLog, offer, orderItem, orders, product, store } from "@/lib/db/schema";
import { brl, dateTimeSP } from "@/lib/format";
import { enqueue, hasOpenJob, type Job, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { limitResend } from "@/lib/mcp/limits";
import { groupItems, itemOrder } from "@/lib/orders/items";
import { LINK_TTL_MS, MAX_DOWNLOADS, deliveryLinks, newTokens, restoreLinks, revokeLinks, saveTokens, storeBaseUrl } from "./links";
import { logEmail, sendMail, type EmailProvider } from "./mailer";
import { deliveryEmail, methodLabel, sellerEmail } from "./templates";
import { deleteWatermarks, ensureWatermarkedPdf, watermarkText } from "./watermark";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Payload = {
  orderId?: unknown;
  reason?: unknown;
  resend?: unknown;
  httpStatus?: unknown;
  paymentId?: unknown;
  code?: unknown;
  refundedCents?: unknown;
  page?: unknown;
};
const payloadOf = (j: Job) => (j.payload ?? {}) as Payload;

/** storeId e orderId (opcional) válidos do job, ou null (payload inválido: o job é descartado com log). */
function target(j: Job, needsOrder: boolean): { storeId: string; orderId: string | null } | null {
  const orderId = payloadOf(j).orderId;
  const okOrder = typeof orderId === "string" && UUID.test(orderId);
  if (!j.storeId || (needsOrder && !okOrder) || (orderId !== undefined && !okOrder)) {
    log.error("job com payload inválido; descartado", { id: j.id, type: j.type });
    return null;
  }
  return { storeId: j.storeId, orderId: okOrder ? (orderId as string) : null };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("job cancelado");
}

async function alreadySent(tx: Tx, where: ReturnType<typeof and>): Promise<boolean> {
  const [row] = await tx.select({ id: emailLog.id }).from(emailLog).where(and(eq(emailLog.status, "sent"), where)).limit(1);
  return row !== undefined;
}

const orderCode = (publicId: string) => txidOf(publicId).slice(0, 8);

// ---- deliver_order ---------------------------------------------------------------------------------------------

/**
 * `deliver_order` {orderId, resend?}: só com o pedido `paid`. Emite (ou reaproveita) os links e manda "Seu acesso".
 * Marca de idempotência: entrega inicial = já existe e-mail `delivery` enviado para o pedido; reenvio
 * (`orders.resend`) = já existe e-mail enviado por ESTE job. Falha no SMTP grava `email_log` `failed` e lança
 * (a fila re-tenta pelo backoff); o pedido continua pago. Depois do envio, deixa os PDFs carimbados no cache.
 */
export const deliverOrderJob: JobHandler = async (j, signal) => {
  const tg = target(j, true);
  if (!tg) return;
  const { storeId } = tg;
  const orderId = tg.orderId!;
  const resend = payloadOf(j).resend === true;

  const prep = await withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!o || o.status !== "paid") return { skip: o?.status ?? "inexistente" } as const;
    const marker = resend ? eq(emailLog.jobId, j.id) : and(eq(emailLog.orderId, o.id), eq(emailLog.kind, "delivery"));
    if (await alreadySent(tx, marker)) return { skip: "ja_enviado" } as const;
    const [c] = await tx.select().from(customer).where(eq(customer.id, o.customerId));
    const [s] = await tx.select().from(store).where(eq(store.id, storeId));
    if (!c || !s) throw new Error("pedido sem cliente ou loja");
    const [of] = await tx.select({ name: offer.name }).from(offer).where(eq(offer.id, o.offerId));
    const links = await deliveryLinks(tx, { id: o.id, storeId });
    const files = links.length
      ? await tx
          .select({ id: product.id, fileKey: product.fileKey, fileSha256: product.fileSha256 })
          .from(product)
          .where(inArray(product.id, links.map((l) => l.productId)))
      : [];
    return { o, c, s, offerName: of?.name ?? s.name, links, files } as const;
  });
  if ("skip" in prep) {
    log.info("deliver_order: nada a enviar", { orderId, reason: prep.skip });
    return;
  }
  const { o, c, s, files } = prep;
  throwIfAborted(signal);
  // Tokens só em memória até o e-mail sair: SMTP falhando (ou caindo no meio) não muda nem invalida nada.
  const links = newTokens(prep.links, storeBaseUrl(s));

  const buyerName = o.buyerName ?? c.name;
  const mail = deliveryEmail({
    storeName: s.name,
    brandColor: s.brandColor,
    buyerName,
    orderCode: orderCode(o.publicId),
    paidAt: o.paidAt ?? new Date(),
    method: o.method,
    totalCents: o.totalCents,
    offerName: prep.offerName,
    items: links.map((l) => ({ name: l.productName, kind: l.kind, url: l.url })),
    maxDownloads: MAX_DOWNLOADS,
    ttlDays: Math.round(LINK_TTL_MS / 86_400_000),
  });
  const logRow = { storeId, orderId, jobId: j.id, to: c.email, kind: "delivery" as const };
  let provider: EmailProvider | null = null;
  let sent: Awaited<ReturnType<typeof sendMail>>;
  try {
    sent = await sendMail(storeId, { to: c.email, ...mail }, { signal, idempotencyKey: j.id, onProvider: (p) => (provider = p) });
  } catch (e) {
    await withStore(storeId, (tx) => logEmail(tx, { ...logRow, status: "failed", error: e, provider })).catch((logErr: unknown) =>
      log.error("falha ao registrar e-mail não enviado", { orderId, error: logErr }),
    );
    throw e;
  }
  await withStore(storeId, async (tx) => {
    await saveTokens(tx, storeId, links);
    await logEmail(tx, { ...logRow, status: "sent", provider: sent.provider, messageId: sent.messageId });
  });

  // PDFs carimbados para o cache (fora do caminho da requisição de download). Melhor esforço: o link gera se faltar.
  const text = watermarkText(buyerName, c.email);
  for (const l of links) {
    if (signal.aborted) break;
    const file = files.find((f) => f.id === l.productId);
    if (!file) continue;
    try {
      await ensureWatermarkedPdf({ orderId, productId: l.productId, fileKey: file.fileKey, fileSha256: file.fileSha256, text });
    } catch (e) {
      log.warn("não foi possível pré-gerar o PDF carimbado; será gerado no download", { orderId, productId: l.productId, error: e });
    }
  }
};

// ---- revoke_downloads / restore_downloads -----------------------------------------------------------------------

/** `revoke_downloads` {orderId}: só se o pedido está AGORA reembolsado ou contestado. */
export const revokeDownloadsJob: JobHandler = async (j) => {
  const tg = target(j, true);
  if (!tg) return;
  const revoked = await withStore(tg.storeId, async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, tg.orderId!)).for("update");
    if (o?.status !== "refunded" && o?.status !== "disputed") {
      log.info("revoke_downloads: pedido não está reembolsado/contestado; nada a revogar", { orderId: tg.orderId, status: o?.status });
      return false;
    }
    const rows = await revokeLinks(tx, tg.orderId!, "order_status");
    log.info("links de download revogados", { orderId: tg.orderId, count: rows.length });
    return true;
  });
  // Cópias carimbadas saem do disco (um restore gera de novo sob demanda). Depois do commit; idempotente.
  if (revoked) await deleteWatermarks(tg.orderId!);
};

/**
 * `restore_downloads` {orderId}: só se o pedido está AGORA pago; desfaz só a revogação por status (sem e-mail). Se o
 * comprador nunca recebeu o e-mail de acesso (a entrega falhou ou foi pulada enquanto o pedido estava contestado),
 * enfileira a entrega, uma vez (não há outra na fila).
 */
export const restoreDownloadsJob: JobHandler = async (j) => {
  const tg = target(j, true);
  if (!tg) return;
  const orderId = tg.orderId!;
  await withStore(tg.storeId, async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update");
    if (o?.status !== "paid") {
      log.info("restore_downloads: pedido não está pago; nada a restaurar", { orderId, status: o?.status });
      return;
    }
    const n = await restoreLinks(tx, orderId);
    log.info("links de download restaurados", { orderId, count: n });
    const delivered = await alreadySent(tx, and(eq(emailLog.orderId, orderId), eq(emailLog.kind, "delivery")));
    if (!delivered && !(await hasOpenJob(tx, "deliver_order", orderId))) {
      await enqueue(tx, { storeId: tg.storeId, type: "deliver_order", payload: { orderId } });
      log.info("restore_downloads: acesso nunca enviado; entrega enfileirada", { orderId });
    }
  });
};

// ---- notify_seller ---------------------------------------------------------------------------------------------

type Notice = { subject: string; heading: string; paragraphs: string[] };
const safeId = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null);

/** Texto do aviso por motivo (payload sem pedido ou evento do pagamento). Motivo desconhecido: aviso genérico. */
export function noticeFor(reason: string, p: Payload, code: string | null): Notice {
  const pedido = code ? ` do pedido #${code}` : "";
  switch (reason) {
    case "chave_asaas_invalida": {
      const status = typeof p.httpStatus === "number" ? ` (HTTP ${p.httpStatus})` : "";
      return {
        subject: "Asaas recusou a chave da sua loja — pagamentos sem confirmação",
        heading: "A chave de API do Asaas foi recusada",
        paragraphs: [
          `O Asaas recusou a chave de API da loja${status} quando fomos conferir um pagamento. Enquanto isso não for resolvido, os pagamentos pelo Asaas não são confirmados aqui e os compradores não recebem o acesso.`,
          "1. Gere uma nova chave de API no painel do Asaas e salve-a em Conexões, no painel da loja.",
          "2. Depois de corrigir a chave, reative a fila de webhooks no painel do Asaas (Integrações > Webhooks). O Asaas pausa a fila depois de falhas seguidas e só reenvia os pagamentos pendentes quando ela é reativada.",
        ],
      };
    }
    case "evento_conta_asaas_anterior":
    case "asaas_conta_antiga": {
      const pay = safeId(p.paymentId);
      return {
        subject: "Asaas: movimento numa cobrança da conta anterior",
        heading: "Evento de uma cobrança da conta Asaas anterior",
        paragraphs: [
          `Recebemos do Asaas um evento de uma cobrança${pay ? ` (${pay})` : ""}${pedido} criada na conta Asaas que a loja usava antes da troca.`,
          "Essa cobrança foi descartada quando a conta foi trocada. Confira na conta anterior do Asaas se o comprador chegou a pagar.",
          "Se pagou, abra o pedido no painel e use o botão “Liberar pedido” (o comprador recebe o acesso), ou devolva o valor pela conta anterior.",
        ],
      };
    }
    case "estorno_cancelado":
      return {
        subject: `Estorno cancelado no Asaas${pedido}`,
        heading: "O estorno foi cancelado no Asaas",
        paragraphs: [
          `O estorno${pedido} foi cancelado no Asaas e o pedido continua pago (o comprador mantém o acesso).`,
          "Confira no Asaas o motivo e peça o reembolso de novo no painel, se for o caso.",
        ],
      };
    case "estorno_falhou": {
      const code = safeId(p.code);
      return {
        subject: `O Asaas recusou o estorno${pedido}`,
        heading: "O estorno não foi feito",
        paragraphs: [
          `O Asaas recusou o estorno${pedido}${code ? ` (motivo: ${code})` : ""}. O pedido continua pago e o comprador mantém o acesso.`,
          "Confira no Asaas o saldo da conta, se a chave de API ainda vale e se a cobrança ainda pode ser estornada. Depois, peça o reembolso de novo no painel.",
        ],
      };
    }
    case "estorno_parcial": {
      const cents = typeof p.refundedCents === "number" && Number.isInteger(p.refundedCents) && p.refundedCents > 0 ? p.refundedCents : null;
      return {
        subject: `Estorno parcial no Asaas${pedido}`,
        heading: "Parte do valor foi devolvida",
        paragraphs: [
          `O Asaas devolveu ${cents !== null ? brl(cents) : "parte do valor"}${pedido} ao comprador. O pedido continua pago e o comprador mantém o acesso.`,
          "Para devolver o restante e encerrar o acesso, use “Reembolsar” no pedido, no painel.",
        ],
      };
    }
    case "monitor_pagina_pagamento": {
      const page = p.page === "/c" || p.page === "/o" || p.page === "/form" ? p.page : null;
      const where = page === "/o" ? "do pedido" : page === "/form" ? "do formulário do cartão" : "do checkout";
      const code = safeId(p.code);
      return {
        subject: "A página de pagamento da sua loja mudou",
        heading: "Mudança na página de pagamento",
        paragraphs: [
          `A verificação semanal encontrou na página ${where} um cabeçalho de segurança ou scripts diferentes do esperado${code ? ` (${code})` : ""}.`,
          "Se você não atualizou o sistema nem mudou a configuração, trate como incidente: confira o servidor antes de continuar vendendo com cartão (docs/seguranca-pagamento.md).",
        ],
      };
    }
    case "telegram_falhou":
      if (p.code === TELEGRAM_MIGRATED.code) return { subject: TELEGRAM_MIGRATED.title, heading: TELEGRAM_MIGRATED.title, paragraphs: [TELEGRAM_MIGRATED.body] };
      return {
        subject: "O Telegram recusou o aviso da loja",
        heading: "O Telegram recusou o aviso da loja",
        paragraphs: ["Os avisos pararam de chegar ao Telegram. Confira o token do bot e se ele ainda está no grupo, salve em Conexões e use “Enviar teste”."],
      };
    case "disjuntor_cartao":
      return {
        subject: "Muitas recusas de cartão na sua loja",
        heading: "Muitas recusas de cartão em pouco tempo",
        paragraphs: [
          "Houve muitas recusas de cartão em 15 minutos, um sinal comum de teste de cartões roubados.",
          "Por 1 hora, as compras com cartão passam a exigir a verificação anti-robô (ou ficam limitadas, se ela não estiver configurada). Se continuar acontecendo, considere desligar o cartão na oferta por um tempo.",
        ],
      };
    default:
      return {
        subject: "Aviso da sua loja",
        heading: "Há um aviso sobre a sua loja",
        paragraphs: [`Algo${pedido} precisa da sua atenção. Confira o painel da loja.`],
      };
  }
}

/**
 * `notify_seller`: com `reason`, aviso operacional (chave do Asaas recusada, conta anterior, estorno cancelado,
 * disjuntor do cartão; desconhecido = genérico); sem `reason` e com `orderId`, aviso de venda (produto, valor,
 * método). Loja sem `notify_email`: concluído com log (não é falha). Idempotente pelo id do job.
 */
export const notifySellerJob: JobHandler = async (j, signal) => {
  const tg = target(j, false);
  if (!tg) return;
  const { storeId, orderId } = tg;
  const p = payloadOf(j);
  const reason = typeof p.reason === "string" ? p.reason : null;

  const prep = await withStore(storeId, async (tx) => {
    const [s] = await tx.select().from(store).where(eq(store.id, storeId));
    if (!s?.notifyEmail) return { skip: "sem_notify_email" } as const;
    if (await alreadySent(tx, eq(emailLog.jobId, j.id))) return { skip: "ja_enviado" } as const;
    const [o] = orderId ? await tx.select().from(orders).where(eq(orders.id, orderId)) : [];
    if (!reason) {
      if (!o) return { skip: "pedido_inexistente" } as const;
      const items = await tx
        .select({ name: product.name, kind: orderItem.kind, priceCents: orderItem.priceCents })
        .from(orderItem)
        .innerJoin(product, eq(product.id, orderItem.productId))
        .where(eq(orderItem.orderId, o.id))
        .orderBy(...itemOrder);
      const [c] = await tx.select().from(customer).where(eq(customer.id, o.customerId));
      const [of] = await tx.select({ name: offer.name }).from(offer).where(eq(offer.id, o.offerId));
      return { s, o, items, offerName: of?.name ?? s.name, buyer: { name: o.buyerName ?? c?.name ?? "", email: c?.email ?? "" } } as const;
    }
    return { s, o: o ?? null, items: null, offerName: null, buyer: null } as const;
  });
  if ("skip" in prep) {
    log.info("notify_seller: nada a enviar", { storeId, orderId, reason: prep.skip });
    return;
  }
  const { s, o, items, offerName, buyer } = prep;
  const code = o ? orderCode(o.publicId) : null;
  let notice: Notice;
  if (reason) notice = noticeFor(reason, p, code);
  else {
    // Mesmo critério do assunto do comprador: 1 principal -> o produto; mais de 1 -> a oferta.
    const mains = items!.filter((i) => i.kind === "main");
    const main = mains.length > 1 ? offerName! : (mains[0]?.name ?? items![0]?.name ?? "pedido");
    notice = {
      subject: `Nova venda: ${main} — ${brl(o!.totalCents)}`,
      heading: `Nova venda de ${brl(o!.totalCents)}`,
      paragraphs: [
        `Pedido #${code} pago com ${methodLabel(o!.method)}${o!.paidAt ? ` em ${dateTimeSP(o!.paidAt)}` : ""}.`,
        // Uma linha de preço por grupo com os nomes (nunca o preço rateado de cada PDF).
        ...groupItems(items!).map((g) => `${g.names.join(" + ")}${g.kind === "bump" ? " (acréscimo)" : ""}: ${brl(g.priceCents)}`),
        `Total: ${brl(o!.totalCents)}`,
        `Comprador: ${buyer!.name}${buyer!.email ? ` (${buyer!.email})` : ""}`,
      ],
    };
  }
  throwIfAborted(signal);
  const mail = sellerEmail({ storeName: s.name, brandColor: s.brandColor, ...notice });
  const logRow = { storeId, orderId: o?.id ?? null, jobId: j.id, to: s.notifyEmail!, kind: "seller_notice" as const };
  let provider: EmailProvider | null = null;
  let sent: Awaited<ReturnType<typeof sendMail>>;
  try {
    sent = await sendMail(storeId, { to: s.notifyEmail!, ...mail }, { signal, idempotencyKey: j.id, onProvider: (p) => (provider = p) });
  } catch (e) {
    await withStore(storeId, (tx) => logEmail(tx, { ...logRow, status: "failed", error: e, provider })).catch((logErr: unknown) =>
      log.error("falha ao registrar e-mail não enviado", { storeId, error: logErr }),
    );
    throw e;
  }
  await withStore(storeId, (tx) => logEmail(tx, { ...logRow, status: "sent", provider: sent.provider, messageId: sent.messageId }));
};

// ---- sweep_watermarks -----------------------------------------------------------------------------------------

export const SWEEP_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Links mais velhos que isto já venceram (30 dias) e foram varridos antes. */
const SWEEP_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * `sweep_watermarks` (global, diário): apaga as cópias carimbadas de itens cujo link não serve mais (vencido, revogado
 * ou esgotado) ou sem download há 7 dias (sem download: 7 dias desde a criação). Um link ativo e recente do mesmo item
 * mantém a cópia. Loja a loja (RLS); falha numa loja não impede as outras, mas o job falha no fim para tentar de novo.
 */
export function createSweepWatermarksHandler(now: () => Date = () => new Date()): JobHandler {
  return async (_j, signal) => {
    const t = now();
    const stores = await db.select({ id: store.id }).from(store);
    let failed = 0;
    let swept = 0;
    for (const { id: storeId } of stores) {
      if (signal.aborted) break;
      try {
        const rows = await withStore(storeId, (tx) =>
          tx
            .select({
              orderId: downloadLink.orderId,
              productId: downloadLink.productId,
              revokedAt: downloadLink.revokedAt,
              expiresAt: downloadLink.expiresAt,
              downloads: downloadLink.downloads,
              maxDownloads: downloadLink.maxDownloads,
              lastDownloadAt: downloadLink.lastDownloadAt,
              createdAt: downloadLink.createdAt,
            })
            .from(downloadLink)
            .where(gte(downloadLink.createdAt, new Date(t.getTime() - SWEEP_LOOKBACK_MS))),
        );
        const keep = new Set<string>();
        const all = new Map<string, { orderId: string; productId: string }>();
        for (const r of rows) {
          const item = `${r.orderId}/${r.productId}`;
          all.set(item, { orderId: r.orderId, productId: r.productId });
          const active = !r.revokedAt && r.expiresAt > t && r.downloads < r.maxDownloads;
          const recent = (r.lastDownloadAt ?? r.createdAt).getTime() >= t.getTime() - SWEEP_IDLE_MS;
          if (active && recent) keep.add(item);
        }
        for (const [item, { orderId, productId }] of all) {
          if (keep.has(item)) continue;
          await deleteWatermarks(orderId, productId);
          swept++;
        }
      } catch (e) {
        failed++;
        log.error("falha ao varrer cópias carimbadas da loja", { storeId, error: e });
      }
    }
    log.info("varredura de cópias carimbadas", { items: swept });
    if (failed > 0) throw new Error(`sweep_watermarks falhou em ${failed} loja(s)`);
  };
}

export const sweepWatermarksJob: JobHandler = createSweepWatermarksHandler();

// ---- orders.resend ---------------------------------------------------------------------------------------------

export const resendOrder = defineAction({
  name: "orders.resend",
  description: "Reenvia o e-mail de acesso de um pedido pago. Com renew, revoga os links atuais e emite novos (validade e downloads renovados).",
  input: z.object({ orderId: z.uuid(), renew: z.boolean().optional() }),
  permission: "orders.resend",
  // Direto, mas com limite para token (o painel segue sem): o e-mail vai sempre ao comprador do pedido.
  async prepare(call, { orderId }) {
    await limitResend(call.actor, call.storeId, orderId);
  },
  async run(ctx, { orderId, renew }) {
    const [o] = await ctx.tx.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    if (o.status !== "paid") throw new ActionError("conflict", `Só pedidos pagos têm acesso para reenviar (${o.status})`);
    const revoked = renew ? (await revokeLinks(ctx.tx, o.id, "renewed")).length : 0;
    // Já há entrega na fila: ela sai com os links atuais (ou novos, se renew acabou de revogar).
    if (await hasOpenJob(ctx.tx, "deliver_order", o.id)) return { orderId: o.id, queued: false, revoked };
    await enqueue(ctx.tx, { storeId: ctx.storeId, type: "deliver_order", payload: { orderId: o.id, resend: true } });
    return { orderId: o.id, queued: true, revoked };
  },
  async afterCommit(_call, _input, out) {
    if (out.revoked > 0) await deleteWatermarks(out.orderId);
  },
});
