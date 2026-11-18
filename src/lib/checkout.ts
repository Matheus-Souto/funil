// Checkout público (/c/[slug]) e página do pedido (/o/[publicId]): ações públicas e a orquestração que as rodeia.
//
// - `checkout.start` cria o pedido (preços sempre do banco). CPF só quando o pagamento é pelo Asaas (Pix do Asaas ou
//   cartão); no Pix manual o CPF não é pedido nem guardado. Pix manual esgotado (ou sem chave) com Asaas conectado:
//   vira Pix do Asaas (pede CPF com `needs_cpf`).
// - Pix manual tem limites contra quem esgota os valores únicos: 5 pedidos por IP por hora e 3 pendentes (ou
//   reservados: expirados há menos de 48 h) por e-mail na loja.
// - `startCheckout` roda `checkout.start` e, no Pix do Asaas, já cria a cobrança fora da transação.
// - `getOrderPublic` é o que a página do pedido mostra: nunca e-mail, CPF, celular ou ids internos.
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { ActionError, defineAction, runAction, type ActionErrorCode, type Ctx } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { checkoutView as checkoutViewTable, customer, offer, orderItem, orders, product } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { createOrder, type Order } from "@/lib/orders/create";
import { UNAVAILABLE_MESSAGE as CARD_UNAVAILABLE_MESSAGE } from "@/lib/payments/asaas/card";
import { startAsaasPix } from "@/lib/payments/asaas/pix";
import { MANUAL_RESERVE_AFTER_EXPIRY_MS, manualPixBrCode } from "@/lib/payments/manual";
import { checkRateLimit, ipRateKey } from "@/lib/payments/ratelimit";
import { resolveStore as defaultResolveStore, type ResolvedStore } from "@/lib/stores";
import { normalizeBrMobile, onlyDigits, validCpf, validEmail } from "@/lib/validation/br";

export const CHECKOUT_LIMIT_MESSAGE = "Você já tem um Pix aguardando pagamento. Use o código anterior ou aguarde alguns minutos.";
export const PIX_UNAVAILABLE_MESSAGE = "Pix indisponível no momento, tente em alguns minutos";
export { CARD_UNAVAILABLE_MESSAGE };
/** `ActionError("conflict", NEEDS_CPF)`: Pix manual esgotado; o formulário mostra o CPF e reenvia (vira Pix do Asaas). */
export const NEEDS_CPF = "needs_cpf";
export const PIX_MANUAL_LIMITS = { perIpPerHour: 5, perEmail: 3 } as const;
/** IP sem proxy confiável (ver card-http.ts): sem limite por IP. */
const UNKNOWN_IP = "unknown";

const publicCall = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------------------------------------------
// Entrada

const touchRecord = z
  .record(z.string().max(40), z.string().max(500))
  .refine((r) => Object.keys(r).length <= 20, "Toque com campos demais");
export const touchSchema = z.object({ first: touchRecord.nullable(), last: touchRecord.nullable() });
export type CheckoutTouch = z.infer<typeof touchSchema>;

const slug = z.string().min(1).max(100);

const startInput = z.object({
  slug,
  withBump: z.boolean(),
  method: z.enum(["pix", "card"]),
  customer: z.object({
    name: z.string().trim().min(2, "Informe seu nome completo").max(120, "Nome longo demais"),
    email: z.string().trim().toLowerCase().max(254).refine(validEmail, "Confira o e-mail"),
    phone: z
      .string()
      .max(30)
      .transform((p, ctx) => {
        const n = normalizeBrMobile(p);
        if (n === null) {
          ctx.addIssue({ code: "custom", message: "Informe um celular com DDD, ex.: (11) 98765-4321" });
          return z.NEVER;
        }
        return n;
      }),
    cpf: z.string().max(20).transform(onlyDigits).optional(),
  }),
  touch: touchSchema,
  ref: z.string().max(100).optional(),
  fbc: z.string().max(500).optional(),
  fbp: z.string().max(500).optional(),
  /** Id do evento InitiateCheckout gerado na página (Meta, Task 13). */
  eventId: z.uuid().optional(),
  /** Preenchidos pela borda HTTP (nunca pelo navegador). */
  clientIp: z.string().min(1).max(64),
  userAgent: z.string().max(500),
});
export type CheckoutStartInput = z.input<typeof startInput>;

const cpfError = (message: string) => new ActionError("invalid_input", message, [{ path: ["customer", "cpf"], message }]);

/** CPF obrigatório e válido (pagamento pelo Asaas). */
function requireCpf(cpf: string | undefined): string {
  if (!cpf) throw cpfError("Informe o CPF");
  if (!validCpf(cpf)) throw cpfError("CPF inválido. Confira os 11 números.");
  return cpf;
}

// ---------------------------------------------------------------------------------------------------------------
// checkout.start

export const checkoutStart = defineAction({
  name: "checkout.start",
  description: "Cria o pedido de uma oferta pelo checkout público (Pix manual, Pix do Asaas ou cartão).",
  input: startInput,
  permission: "public",
  // LGPD: sem CPF, celular, nome nem e-mail em claro na auditoria.
  auditInput: (i) => ({ slug: i.slug, method: i.method, hasBump: i.withBump, emailHash: sha256(i.customer.email) }),
  /**
   * Limite por IP do Pix manual (5 por hora) antes da transação: o contador fica no `rate_limit` (outra conexão),
   * então não pode rodar com a transação aberta. A oferta é só lida.
   */
  async prepare(call, input) {
    if (input.method !== "pix" || input.clientIp === UNKNOWN_IP) return undefined;
    const [o] = await withStore(call.storeId, (tx) =>
      tx.select({ pixMode: offer.pixMode }).from(offer).where(and(eq(offer.slug, input.slug), eq(offer.active, true))),
    );
    if (o?.pixMode !== "manual") return undefined;
    const ok = await checkRateLimit(`pix_manual:ip:${ipRateKey(input.clientIp)}`, PIX_MANUAL_LIMITS.perIpPerHour, 3600);
    if (!ok) throw new ActionError("rate_limited", CHECKOUT_LIMIT_MESSAGE);
    return undefined;
  },
  async run(ctx, input) {
    const [o] = await ctx.tx.select().from(offer).where(and(eq(offer.slug, input.slug), eq(offer.active, true)));
    if (!o) throw new ActionError("not_found", "Oferta não encontrada");
    if (!o.methods.includes(input.method)) {
      throw new ActionError("invalid_input", "Forma de pagamento indisponível nesta oferta", [{ path: ["method"] }]);
    }
    const asaas = await getIntegration(ctx.tx, ctx.storeId, "asaas");
    const asaasOn = Boolean(asaas?.secret);
    const { cpf, ...buyer } = input.customer;
    const base = {
      offerId: o.id,
      withBump: input.withBump,
      touch: input.touch,
      ref: input.ref,
      fbc: input.fbc,
      fbp: input.fbp,
      clientIp: input.clientIp,
      userAgent: input.userAgent,
    };
    const create = (method: "pix_manual" | "pix_asaas" | "card_asaas", withCpf?: string, fallback = false) =>
      createOrder(ctx, { ...base, method, customer: withCpf ? { ...buyer, cpf: withCpf } : buyer, asaasPixFallback: fallback });

    let order: Order;
    if (input.method === "card") {
      if (!asaasOn) throw new ActionError("conflict", CARD_UNAVAILABLE_MESSAGE);
      order = await create("card_asaas", requireCpf(cpf));
    } else if (o.pixMode === "asaas") {
      if (!asaasOn) throw new ActionError("conflict", PIX_UNAVAILABLE_MESSAGE);
      order = await create("pix_asaas", requireCpf(cpf));
    } else {
      // Pix manual: CPF ignorado. Sem chave configurada ou sem valor único livre -> Asaas (se conectado).
      const hasKey = Boolean((await getIntegration(ctx.tx, ctx.storeId, "pix_manual"))?.config?.key);
      let manual: Order | null = null;
      if (hasKey) {
        // Mesmo lock da alocação do valor único (reentrante na transação): a contagem por e-mail não corre.
        await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"pix_manual:" + ctx.storeId}, 0))`);
        await enforceEmailLimit(ctx, buyer.email);
        try {
          manual = await create("pix_manual");
        } catch (e) {
          if (!(e instanceof ActionError && e.code === "conflict" && e.message === "pix_manual_exhausted")) throw e;
          log.warn("checkout: Pix manual sem valor único livre", { storeId: ctx.storeId, offerId: o.id });
        }
      }
      if (manual) order = manual;
      else {
        if (!asaasOn) throw new ActionError("conflict", PIX_UNAVAILABLE_MESSAGE);
        if (!cpf) throw new ActionError("conflict", NEEDS_CPF, [{ path: ["customer", "cpf"] }]);
        order = await create("pix_asaas", requireCpf(cpf), true);
      }
    }
    return { publicId: order.publicId, method: order.method as "pix_manual" | "pix_asaas" | "card_asaas", orderId: order.id };
  },
});

/** No máximo 3 Pix manuais pendentes ou reservados (expirados há menos de 48 h) por e-mail na loja. */
async function enforceEmailLimit(ctx: Ctx, email: string): Promise<void> {
  const reservedSince = new Date(Date.now() - MANUAL_RESERVE_AFTER_EXPIRY_MS);
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(orders)
    .innerJoin(customer, eq(customer.id, orders.customerId))
    .where(
      and(
        eq(customer.email, email),
        eq(orders.method, "pix_manual"),
        or(eq(orders.status, "pending"), and(eq(orders.status, "expired"), gt(orders.expiresAt, reservedSince))),
      ),
    );
  if ((row?.n ?? 0) >= PIX_MANUAL_LIMITS.perEmail) throw new ActionError("rate_limited", CHECKOUT_LIMIT_MESSAGE);
}

/**
 * `checkout.start` + cobrança Pix do Asaas criada na hora (HTTP fora da transação). Celular recusado pelo Asaas
 * volta como `invalid_input` para o comprador corrigir (o pedido sem cobrança expira sozinho em 24 h); outras falhas
 * do Asaas ficam para a página do pedido, que tenta de novo ao abrir.
 */
export async function startCheckout(
  call: { storeId: string },
  raw: unknown,
): Promise<{ publicId: string; method: "pix_manual" | "pix_asaas" | "card_asaas" }> {
  const out = await runAction(checkoutStart, publicCall(call.storeId), raw);
  if (out.method === "pix_asaas") {
    try {
      await startAsaasPix(call, out.orderId);
    } catch (e) {
      if (e instanceof ActionError && e.code === "invalid_input") throw e;
      log.warn("checkout: cobrança Pix do Asaas não criada agora; a página do pedido tenta de novo", { publicId: out.publicId, error: e });
    }
  }
  return { publicId: out.publicId, method: out.method };
}

// ---------------------------------------------------------------------------------------------------------------
// checkout.view

export const checkoutView = defineAction({
  name: "checkout.view",
  description: "Registra uma visita ao checkout de uma oferta (métrica de conversão).",
  input: z.object({ slug, touch: touchSchema }),
  permission: "public",
  audit: false,
  async run(ctx, input) {
    const [o] = await ctx.tx.select({ id: offer.id }).from(offer).where(and(eq(offer.slug, input.slug), eq(offer.active, true)));
    if (!o) throw new ActionError("not_found", "Oferta não encontrada");
    await ctx.tx.insert(checkoutViewTable).values({ storeId: ctx.storeId, offerId: o.id, touch: input.touch });
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Página do pedido

const publicIdInput = z.object({ publicId: z.string().min(1).max(64) });

export const orderPublicStatus = defineAction({
  name: "orders.publicStatus",
  description: "Status de um pedido pelo identificador público (polling da página do pedido).",
  input: publicIdInput,
  permission: "public",
  audit: false,
  async run(ctx, { publicId }) {
    const [o] = await ctx.tx.select({ status: orders.status }).from(orders).where(eq(orders.publicId, publicId));
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    return { status: o.status };
  },
});

/** Leitura interna da página do pedido (inclui o id, usado só no servidor para a cobrança do Asaas). */
const orderPublicView = defineAction({
  name: "orders.publicView",
  description: "Dados de um pedido para a página pública do pedido (sem dados pessoais).",
  input: publicIdInput,
  permission: "public",
  audit: false,
  async run(ctx, { publicId }) {
    const [o] = await ctx.tx.select().from(orders).where(eq(orders.publicId, publicId));
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    const [of] = await ctx.tx.select().from(offer).where(eq(offer.id, o.offerId));
    const items = await ctx.tx
      .select({ name: product.name, priceCents: orderItem.priceCents, kind: orderItem.kind })
      .from(orderItem)
      .innerJoin(product, eq(product.id, orderItem.productId))
      .where(eq(orderItem.orderId, o.id))
      .orderBy(desc(orderItem.kind), asc(orderItem.id)); // "main" antes de "bump"
    let manual: { copyPaste: string; receiver: string; txid: string } | null = null;
    if (o.method === "pix_manual" && o.status === "pending") {
      const brCode = await manualPixBrCode(ctx, o);
      const cfg = (await getIntegration(ctx.tx, ctx.storeId, "pix_manual"))?.config as { name?: string } | undefined;
      if (brCode) manual = { copyPaste: brCode, receiver: (cfg?.name ?? "").toUpperCase(), txid: txidOf(o.publicId) };
    }
    let buyerName = o.buyerName;
    if (!buyerName) {
      const [c] = await ctx.tx.select({ name: customer.name }).from(customer).where(eq(customer.id, o.customerId));
      buyerName = c?.name ?? "";
    }
    return { o, offer: of!, items, manual, buyerFirstName: (buyerName ?? "").trim().split(/\s+/)[0] ?? "" };
  },
});

/** Identificador do pedido no BR Code (campo txid): o mesmo que o vendedor procura no extrato. */
export const txidOf = (publicId: string) => publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 25);

export interface OrderPublic {
  status: string;
  method: "pix_manual" | "pix_asaas" | "card_asaas";
  totalCents: number;
  /** Valor único do Pix manual (total + 1 a 99 centavos). */
  manualAmountCents: number | null;
  /** Código curto para o comprador citar ao falar com a loja. */
  code: string;
  createdAt: string;
  paidAt: string | null;
  expiresAt: string | null;
  items: { name: string; priceCents: number }[];
  thankYouText: string | null;
  buyerFirstName: string;
  offer: { slug: string; name: string; methods: string[] };
  pix?: {
    copyPaste: string;
    /** Pix manual: QR gerado aqui (SVG). */
    qrSvg?: string;
    /** Pix do Asaas: PNG em base64 devolvido pelo Asaas. */
    qrImage?: string;
    receiver?: string;
    txid?: string;
  };
  /** Pix do Asaas pendente sem QR agora (Asaas fora do ar): a página pede para recarregar. */
  pixUnavailable?: boolean;
}

/**
 * Dados da página do pedido. `publicId` de outra loja -> `null` (RLS: a consulta roda com o `store_id` desta loja).
 * Pix do Asaas pendente: cria ou reaproveita a cobrança (fora de transação) para mostrar o QR.
 */
export async function getOrderPublic(storeId: string, publicId: string): Promise<OrderPublic | null> {
  let v: Awaited<ReturnType<typeof orderPublicView.run>>;
  try {
    v = await runAction(orderPublicView, publicCall(storeId), { publicId });
  } catch (e) {
    if (e instanceof ActionError && (e.code === "not_found" || e.code === "invalid_input")) return null;
    throw e;
  }
  const { o } = v;
  const out: OrderPublic = {
    status: o.status,
    method: o.method as OrderPublic["method"],
    totalCents: o.totalCents,
    manualAmountCents: o.manualAmountCents,
    code: txidOf(o.publicId).slice(0, 8),
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    expiresAt: o.expiresAt?.toISOString() ?? null,
    items: v.items.map((i) => ({ name: i.name, priceCents: i.priceCents })),
    thankYouText: v.offer.thankYouText,
    buyerFirstName: v.buyerFirstName,
    offer: { slug: v.offer.slug, name: v.offer.name, methods: v.offer.methods },
  };
  if (v.manual) {
    const qrSvg = await QRCode.toString(v.manual.copyPaste, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
    out.pix = { ...v.manual, qrSvg };
  } else if (o.method === "pix_asaas" && o.status === "pending") {
    try {
      const qr = await startAsaasPix({ storeId }, o.id);
      out.pix = { copyPaste: qr.copyPaste, qrImage: /^[A-Za-z0-9+/=]+$/.test(qr.qrImage) ? qr.qrImage : undefined };
    } catch (e) {
      log.warn("página do pedido: QR do Asaas indisponível", { publicId, error: e });
      out.pixUnavailable = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// GET /api/orders/[publicId]/status

const STATUS: Record<ActionErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  approval_required: 403,
  provider_error: 502,
  rate_limited: 429,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleOrderStatus(
  req: Request,
  publicId: string,
  opts: { resolveStore?: (host: string) => Promise<ResolvedStore | null> } = {},
): Promise<Response> {
  const store = await (opts.resolveStore ?? defaultResolveStore)(req.headers.get("host") ?? "");
  if (!store) return json(404, { error: "not_found" });
  try {
    const r = await runAction(orderPublicStatus, publicCall(store.id), { publicId });
    return json(200, { status: r.status });
  } catch (e) {
    if (e instanceof ActionError) return json(e.code === "invalid_input" ? 404 : STATUS[e.code], { error: e.code === "invalid_input" ? "not_found" : e.code });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Toque (UTM, indicação, Meta) na entrada do checkout. A Task 13 troca por `parseTouch` (src/lib/tracking/touch.ts).

const TOUCH_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] as const;

export function touchFromSearch(
  search: Record<string, string | string[] | undefined>,
  cookies: { fbc?: string; fbp?: string },
  nowMs: number = Date.now(),
): { touch: CheckoutTouch; ref?: string; fbc?: string; fbp?: string } {
  const one = (k: string) => {
    const v = search[k];
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === "string" && s.length > 0 ? s.slice(0, 500) : undefined;
  };
  const last: Record<string, string> = {};
  for (const k of TOUCH_KEYS) {
    const v = one(k);
    if (v) last[k] = v;
  }
  let first: Record<string, string> | null = null;
  const ft = one("ft");
  if (ft) {
    try {
      const parsed = touchRecord.safeParse(JSON.parse(Buffer.from(ft, "base64url").toString("utf8")));
      if (parsed.success) first = parsed.data;
    } catch {
      first = null;
    }
  }
  const fbclid = last.fbclid;
  return {
    touch: { first, last: Object.keys(last).length > 0 ? last : null },
    ref: one("ref")?.slice(0, 100),
    fbc: cookies.fbc?.slice(0, 500) ?? (fbclid ? `fb.1.${nowMs}.${fbclid}` : undefined),
    fbp: cookies.fbp?.slice(0, 500),
  };
}
