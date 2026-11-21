// Checkout público (/c/[slug]) e página do pedido (/o/[publicId]): ações públicas e a orquestração que as rodeia.
//
// - `checkout.start` cria o pedido (preços sempre do banco). CPF só quando o pagamento é pelo Asaas (Pix do Asaas ou
//   cartão); no Pix manual o CPF não é pedido nem guardado. Pix manual esgotado (ou sem chave) com Asaas conectado:
//   vira Pix do Asaas (pede CPF com `needs_cpf`).
// - Limites (contam pedidos CRIADOS, não tentativas: lidos no `prepare`, somados no `afterCommit`):
//   Pix manual 5 por IP/hora e 3 pendentes (ou reservados: expirados há < 48 h) por e-mail na loja;
//   Asaas (Pix do Asaas e cartão) 10 por IP/hora e 5 por e-mail/hora na loja.
// - `startCheckout` roda `checkout.start` e, no Pix do Asaas, já cria a cobrança e guarda o QR (fora da transação).
// - `getOrderPublic` é o que a página do pedido mostra: só dados guardados (nunca chama o Asaas num GET) e nunca
//   e-mail, CPF, celular ou ids internos. QR faltando: `orders.regeneratePix` (POST, 3 por hora por pedido).
import { createHash } from "node:crypto";
import { and, count, eq, gt, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { z } from "zod";
import { ActionError, defineAction, runAction, type ActionErrorCode, type Ctx } from "@/lib/actions/core";
import { UNKNOWN_IP } from "@/lib/client-ip";
import { withStore } from "@/lib/db/client";
import { checkoutView as checkoutViewTable, customer, offer, orderItem, orders, payment, product } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { createOrder, type Order } from "@/lib/orders/create";
import { groupItems, itemOrder } from "@/lib/orders/items";
import { startAsaasPix } from "@/lib/payments/asaas/pix";
import { CARD_UNAVAILABLE_MESSAGE } from "@/lib/payments/card-messages";
import { issueCardTicket, verifyCardTicketForRenewal } from "@/lib/payments/card-ticket";
import { MANUAL_RESERVE_AFTER_EXPIRY_MS, manualPixBrCode } from "@/lib/payments/manual";
import { checkRateLimit, hitRateLimit, ipRateKey, peekRateLimit } from "@/lib/payments/ratelimit";
import { resolveStore as defaultResolveStore, type ResolvedStore } from "@/lib/stores";
import { enqueueInitiateCheckout, pixelIdFor } from "@/lib/tracking/meta";
import { META_EVENT_ID_RE, touchRecordSchema } from "@/lib/tracking/touch";
import { normalizeBrMobile, onlyDigits, validCpf, validEmail } from "@/lib/validation/br";

export const CHECKOUT_LIMIT_MESSAGE = "Você já tem um Pix aguardando pagamento. Use o código anterior ou aguarde alguns minutos.";
export const PIX_UNAVAILABLE_MESSAGE = "Pix indisponível no momento, tente em alguns minutos";
export { CARD_UNAVAILABLE_MESSAGE };
/** `ActionError("conflict", NEEDS_CPF)`: Pix manual esgotado; o formulário mostra o CPF e reenvia (vira Pix do Asaas). */
export const NEEDS_CPF = "needs_cpf";
export const ASAAS_LIMIT_MESSAGE = "Muitas compras seguidas. Aguarde alguns minutos e tente de novo.";
export const PIX_MANUAL_LIMITS = { perIpPerHour: 5, perEmail: 3 } as const;
export const ASAAS_LIMITS = { perIpPerHour: 10, perEmailPerHour: 5 } as const;
export const PIX_REGEN_PER_HOUR = 3;
export const VIEW_LIMIT_PER_HOUR = 30;
/** Toque (UTM etc.) maior que isto, serializado, é descartado: nunca grava payload grande de anônimo. */
export const TOUCH_MAX_BYTES = 2048;
const HOUR = 3600;

const manualIpKey = (ip: string) => `checkout:pix_manual:ip:${ipRateKey(ip)}`;
const asaasIpKey = (ip: string) => `checkout:asaas:ip:${ipRateKey(ip)}`;
const asaasEmailKey = (storeId: string, email: string) => `checkout:asaas:email:${storeId}:${sha256(email)}`;

const publicCall = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------------------------------------------
// Entrada

export const touchSchema = z
  .object({ first: touchRecordSchema.nullable(), last: touchRecordSchema.nullable() })
  .transform((t) => (Buffer.byteLength(JSON.stringify(t)) > TOUCH_MAX_BYTES ? { first: null, last: null } : t));
export type CheckoutTouch = z.input<typeof touchSchema>;

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
  /** Id do evento InitiateCheckout gerado na página (o Pixel usa o mesmo): UUID ou 16-64 caracteres url-safe. */
  eventId: z.string().regex(META_EVENT_ID_RE, "eventId inválido").optional(),
  /** Chave do visitante do `checkout.saveLead` (UUID): o pedido converte o contato guardado por ela. Nunca vai à auditoria. */
  leadKey: z.uuid().optional(),
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

type StartOutput = {
  publicId: string;
  method: "pix_manual" | "pix_asaas" | "card_asaas";
  orderId: string;
  totalCents: number;
  maxInstallments: number;
};

export const checkoutStart = defineAction({
  name: "checkout.start",
  description: "Cria o pedido de uma oferta pelo checkout público (Pix manual, Pix do Asaas ou cartão).",
  input: startInput,
  permission: "public",
  // LGPD: sem CPF, celular, nome nem e-mail em claro na auditoria.
  auditInput: (i) => ({ slug: i.slug, method: i.method, hasBump: i.withBump, emailHash: sha256(i.customer.email) }),
  /**
   * Só LÊ os contadores (`rate_limit`, outra conexão: fora da transação). Quem decide qual vale é `run`, pelo método do
   * pedido que vai ser criado; quem soma é `afterCommit`, só para o pedido criado.
   */
  async prepare(call, input) {
    const knownIp = input.clientIp !== UNKNOWN_IP;
    const [manualIpOk, asaasIpOk, asaasEmailOk] = await Promise.all([
      knownIp ? peekRateLimit(manualIpKey(input.clientIp), PIX_MANUAL_LIMITS.perIpPerHour, HOUR) : true,
      knownIp ? peekRateLimit(asaasIpKey(input.clientIp), ASAAS_LIMITS.perIpPerHour, HOUR) : true,
      peekRateLimit(asaasEmailKey(call.storeId, input.customer.email), ASAAS_LIMITS.perEmailPerHour, HOUR),
    ]);
    return { manualIpOk, asaasOk: asaasIpOk && asaasEmailOk };
  },
  /** Conta o pedido criado (melhor esforço; falha só vai para o log). */
  async afterCommit(call, input, out: StartOutput) {
    const knownIp = input.clientIp !== UNKNOWN_IP;
    if (out.method === "pix_manual") {
      if (knownIp) await hitRateLimit(manualIpKey(input.clientIp), HOUR);
      return;
    }
    if (knownIp) await hitRateLimit(asaasIpKey(input.clientIp), HOUR);
    await hitRateLimit(asaasEmailKey(call.storeId, input.customer.email), HOUR);
  },
  async run(ctx, input, limits): Promise<StartOutput> {
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
      leadKey: input.leadKey,
    };
    const create = (method: "pix_manual" | "pix_asaas" | "card_asaas", withCpf?: string, fallback = false) => {
      if (method === "pix_manual" ? !limits.manualIpOk : !limits.asaasOk) {
        throw new ActionError("rate_limited", method === "pix_manual" ? CHECKOUT_LIMIT_MESSAGE : ASAAS_LIMIT_MESSAGE);
      }
      return createOrder(ctx, { ...base, method, customer: withCpf ? { ...buyer, cpf: withCpf } : buyer, asaasPixFallback: fallback });
    };

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
        const valid = requireCpf(cpf);
        order = await create("pix_asaas", valid, true);
      }
    }
    // Pedido criado: InitiateCheckout do servidor com o id do navegador (na mesma transação: só sai se o pedido existir).
    await enqueueInitiateCheckout(ctx.tx, ctx.storeId, order.id, input.eventId);
    return {
      publicId: order.publicId,
      method: order.method as "pix_manual" | "pix_asaas" | "card_asaas",
      orderId: order.id,
      // O bilhete do cartão leva o total e as parcelas (o iframe confere com o que o checkout mostrou).
      totalCents: order.totalCents,
      maxInstallments: o.maxInstallments,
    };
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
 * `checkout.start` + cobrança Pix do Asaas criada na hora, com o QR guardado (HTTP fora da transação). Celular
 * recusado pelo Asaas volta como `invalid_input` para o comprador corrigir (o pedido sem cobrança expira sozinho em
 * 24 h); outras falhas deixam a página do pedido com o botão "Gerar novo código Pix" (`orders.regeneratePix`).
 * `cardTicketKey` (CARD_TICKET_KEY): pedido de cartão volta com o bilhete que o iframe do cartão apresenta. Sem ela (serviço
 * de cartão não configurado), cartão é recusado antes de criar o pedido.
 */
export async function startCheckout(
  call: { storeId: string },
  raw: unknown,
  opts: { cardTicketKey?: string; now?: Date } = {},
): Promise<{ publicId: string; method: "pix_manual" | "pix_asaas" | "card_asaas"; cardTicket?: string }> {
  const method = raw !== null && typeof raw === "object" ? (raw as { method?: unknown }).method : undefined;
  if (method === "card" && !opts.cardTicketKey) throw new ActionError("conflict", CARD_UNAVAILABLE_MESSAGE);
  const out = await runAction(checkoutStart, publicCall(call.storeId), raw);
  if (out.method === "card_asaas" && opts.cardTicketKey) {
    const cardTicket = issueCardTicket(
      { storeId: call.storeId, orderId: out.orderId, publicId: out.publicId, totalCents: out.totalCents, maxInstallments: out.maxInstallments },
      opts.cardTicketKey,
      opts.now,
    );
    return { publicId: out.publicId, method: out.method, cardTicket };
  }
  if (out.method === "pix_asaas") {
    try {
      await startAsaasPix(call, out.orderId);
    } catch (e) {
      if (e instanceof ActionError && e.code === "invalid_input") throw e;
      log.warn("checkout: cobrança/QR do Pix do Asaas não gerados agora; o comprador pode pedir um novo código", { publicId: out.publicId, error: e });
    }
  }
  return { publicId: out.publicId, method: out.method };
}

/**
 * Métodos que o checkout mostra: sem o serviço de cartão configurado, só Pix. Oferta só de cartão continua com o cartão
 * (o checkout, sem iframe, mostra o aviso de indisponível e não cria pedido; `startCheckout` também recusa).
 */
export function checkoutMethods(methods: readonly string[], cardOn: boolean): ("pix" | "card")[] {
  const known = methods.filter((m): m is "pix" | "card" => m === "pix" || m === "card");
  if (cardOn) return known;
  const pix = known.filter((m) => m === "pix");
  return pix.length > 0 ? pix : known;
}

// ---------------------------------------------------------------------------------------------------------------
// checkout.renewCardTicket

/** Mesmo formato do `publicId` dos pedidos (base64url), com teto de 64. */
const publicIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Pedido inválido");

const BAD_TICKET = "Bilhete inválido";

export const checkoutRenewCardTicket = defineAction({
  name: "checkout.renewCardTicket",
  description:
    "Emite um bilhete novo de um pedido de cartão pendente da loja para quem já tinha um bilhete do mesmo pedido (o anterior venceu ou está perto de vencer).",
  // A chave (CARD_TICKET_KEY) e a hora vêm do servidor por `call.server`, fora da entrada: não aparecem no schema, no
  // catálogo de ações nem na auditoria, e quem chama a ação não as escolhe.
  input: z.object({
    publicId: publicIdSchema,
    ticket: z.string().min(1).max(2048),
  }),
  permission: "public",
  // Anônima e repetível (o bilhete dura 30 min): sem linha de auditoria, como checkout.view.
  audit: false,
  async run(ctx, input, _prepared: undefined, server?: { ticketKey: string; now?: Date }): Promise<{ ticket: string }> {
    if (!server?.ticketKey) throw new Error("checkout.renewCardTicket sem a chave dos bilhetes (call.server.ticketKey)");
    const now = server.now ?? new Date();
    // Só quem tinha um bilhete do MESMO pedido e da MESMA loja (íntegro; vencido há no máximo 24 h): saber o
    // `publicId` não basta. Conferido antes de olhar o pedido.
    const prev = verifyCardTicketForRenewal(input.ticket, server.ticketKey, now);
    if (!prev || prev.storeId !== ctx.storeId || prev.publicId !== input.publicId) throw new ActionError("forbidden", BAD_TICKET);
    // RLS: pedido de outra loja não aparece (not_found, como um publicId inexistente).
    const [o] = await ctx.tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        method: orders.method,
        status: orders.status,
        totalCents: orders.totalCents,
        maxInstallments: offer.maxInstallments,
      })
      .from(orders)
      .innerJoin(offer, eq(offer.id, orders.offerId))
      .where(eq(orders.publicId, input.publicId));
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    if (o.method !== "card_asaas") throw new ActionError("conflict", "Pedido não é de cartão");
    if (o.status !== "pending") throw new ActionError("conflict", "Pedido não está pendente");
    if (o.id !== prev.orderId) throw new ActionError("forbidden", BAD_TICKET);
    const terms = { totalCents: o.totalCents, maxInstallments: o.maxInstallments };
    return { ticket: issueCardTicket({ storeId: ctx.storeId, orderId: o.id, publicId: o.publicId, ...terms }, server.ticketKey, now) };
  },
});

/**
 * Bilhete novo para um pedido de cartão pendente da loja (o comprador demorou ou o anterior venceu); a regra fica em
 * `checkout.renewCardTicket`. Erros: `invalid_input` (entrada), `forbidden` (bilhete), `not_found` / `conflict` (pedido).
 */
export async function renewCardTicket(call: { storeId: string }, raw: unknown, key: string, now: Date = new Date()): Promise<string> {
  const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Só os dois campos do navegador na entrada; a chave e a hora vão por `server`.
  const input = { publicId: body.publicId, ticket: body.ticket };
  return (await runAction(checkoutRenewCardTicket, { ...publicCall(call.storeId), server: { ticketKey: key, now } }, input)).ticket;
}

// ---------------------------------------------------------------------------------------------------------------
// checkout.view

export const checkoutView = defineAction({
  name: "checkout.view",
  description: "Registra uma visita ao checkout de uma oferta (métrica de conversão).",
  input: z.object({ slug, touch: touchSchema, clientIp: z.string().min(1).max(64) }),
  permission: "public",
  audit: false,
  /** Gravação anônima: no máximo 30 por IP por hora em cada oferta (IP desconhecido = uma chave só por oferta). */
  async prepare(call, input) {
    const key = `checkout:view:${call.storeId}:${input.slug}:${ipRateKey(input.clientIp)}`;
    if (!(await checkRateLimit(key, VIEW_LIMIT_PER_HOUR, HOUR))) throw new ActionError("rate_limited", "Muitas visitas");
  },
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

/**
 * "Gerar novo código Pix" (POST da página do pedido): para Pix do Asaas pendente sem QR guardado. Cria ou reaproveita
 * a cobrança e guarda o QR (`startAsaasPix`, HTTP no `prepare`: fora de transação). No máximo 3 por hora por pedido.
 */
export const regenerateOrderPix = defineAction({
  name: "orders.regeneratePix",
  description: "Gera de novo o código Pix (Asaas) de um pedido pendente, quando o QR não está disponível.",
  input: publicIdInput,
  permission: "public",
  audit: false,
  async prepare(call, { publicId }) {
    const [o] = await withStore(call.storeId, (tx) =>
      tx.select({ id: orders.id, method: orders.method, status: orders.status }).from(orders).where(eq(orders.publicId, publicId)),
    );
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    if (o.method !== "pix_asaas" || o.status !== "pending") throw new ActionError("conflict", "Este pedido não aceita um novo código Pix");
    if (!(await checkRateLimit(`checkout:pix_regen:${call.storeId}:${publicId}`, PIX_REGEN_PER_HOUR, HOUR))) {
      throw new ActionError("rate_limited", "Você já pediu vários códigos. Aguarde alguns minutos.");
    }
    await startAsaasPix({ storeId: call.storeId }, o.id);
  },
  run: async () => ({ ok: true as const }),
});

/** Leitura interna da página do pedido (inclui o id; só no servidor). Não chama o Asaas: lê o QR guardado. */
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
      .orderBy(...itemOrder);
    let manual: { copyPaste: string; receiver: string; txid: string } | null = null;
    if (o.method === "pix_manual" && o.status === "pending") {
      const brCode = await manualPixBrCode(ctx, o);
      const cfg = (await getIntegration(ctx.tx, ctx.storeId, "pix_manual"))?.config as { name?: string } | undefined;
      if (brCode) manual = { copyPaste: brCode, receiver: (cfg?.name ?? "").toUpperCase(), txid: txidOf(o.publicId) };
    }
    let asaas: { copyPaste: string; qrImage: string | null } | null = null;
    if (o.method === "pix_asaas" && o.status === "pending") {
      const [p] = await ctx.tx
        .select({ copyPaste: payment.pixCopyPaste, qrImage: payment.pixQrImage })
        .from(payment)
        .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas"), eq(payment.status, "PENDING")));
      if (p?.copyPaste) asaas = { copyPaste: p.copyPaste, qrImage: p.qrImage };
    }
    let buyerName = o.buyerName;
    if (!buyerName) {
      const [c] = await ctx.tx.select({ name: customer.name }).from(customer).where(eq(customer.id, o.customerId));
      buyerName = c?.name ?? "";
    }
    const pixelId = await pixelIdFor(ctx.tx, ctx.storeId, of?.pixelId);
    return { o, offer: of!, items, manual, asaas, pixelId, buyerFirstName: (buyerName ?? "").trim().split(/\s+/)[0] ?? "" };
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
  /** Uma linha por grupo (principal, bump) com o preço do grupo: o comprador nunca vê o preço rateado por PDF. */
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
  /** Pix do Asaas pendente sem QR guardado: a página oferece "Gerar novo código Pix". */
  pixUnavailable?: boolean;
  /** Meta Pixel da oferta (ou da loja); null = sem Pixel na página. */
  pixelId: string | null;
}

/**
 * Resumo do pedido para o comprador: uma linha por grupo (principal e bump) com o preço do grupo, nunca o preço rateado
 * de cada PDF. Grupo de 1 produto mostra o nome dele (como antes); principal com N mostra o nome da oferta; bump com N,
 * o rótulo do bump.
 */
function summaryLines(items: { name: string; priceCents: number; kind: string }[], of: { name: string; bumpLabel: string | null }): OrderPublic["items"] {
  return groupItems(items).map((g) => ({
    name: g.names.length === 1 ? g.names[0]! : g.kind === "main" ? of.name : (of.bumpLabel ?? g.names.join(" · ")),
    priceCents: g.priceCents,
  }));
}

/**
 * Dados da página do pedido. `publicId` de outra loja -> `null` (RLS: a consulta roda com o `store_id` desta loja).
 * Só leitura: nunca chama o Asaas (o QR do Pix do Asaas foi guardado no checkout ou no "Gerar novo código Pix").
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
    items: summaryLines(v.items, v.offer),
    thankYouText: v.offer.thankYouText,
    buyerFirstName: v.buyerFirstName,
    offer: { slug: v.offer.slug, name: v.offer.name, methods: v.offer.methods },
    pixelId: v.pixelId,
  };
  if (v.manual) {
    const qrSvg = await QRCode.toString(v.manual.copyPaste, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
    out.pix = { ...v.manual, qrSvg };
  } else if (o.method === "pix_asaas" && o.status === "pending") {
    if (v.asaas) {
      const img = v.asaas.qrImage && /^[A-Za-z0-9+/=]+$/.test(v.asaas.qrImage) ? v.asaas.qrImage : undefined;
      out.pix = { copyPaste: v.asaas.copyPaste, qrImage: img };
    } else out.pixUnavailable = true;
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
