// Cartão de crédito Asaas digitado no próprio checkout ("transparente"), com proteção contra teste de cartão.
//
// DADOS DO CARTÃO: só existem em `input.card` (variável local desta requisição) e no corpo enviado ao Asaas.
// Nunca vão para log, auditoria, fila, banco ou mensagem de erro. Por isso `payWithCard` NÃO é uma ação registrada
// (runAction gravaria a entrada na auditoria) e nenhuma chamada de `log` recebe `input` ou o corpo da cobrança.
//
// Fluxo (nenhum HTTP externo dentro de transação; pool de 5 conexões):
//   1. leitura curta: pedido da loja, tentativa com a mesma chave (repetição -> espera o resultado dela), oferta;
//   2. parcelas, limites (IP, e-mail, cartão) e Turnstile, antes de gravar qualquer coisa;
//   3. transação curta: trava o pedido, recusa se houver tentativa em andamento, grava `card_attempt` (processing);
//   4. fora de transação: cliente no Asaas + cobrança CREDIT_CARD (timeout 60 s, remoteIp do comprador);
//   5. transação curta: fecha a tentativa, grava `payment` e, aprovado, `transitionOrder("paid")`.
// Timeout/erro de rede em 4: o resultado é desconhecido (o Asaas pode ter cobrado). Não dizemos "recusado":
// a tentativa vira `error` e o webhook (externalReference = id do pedido) liquida o pedido.
// Contra cobrança em dobro: nos 2 min seguintes uma nova tentativa é recusada (atalho); depois disso, antes de
// permitir, conferimos no Asaas (GET /payments?externalReference=<pedido>): paga -> liquida pelo caminho do webhook;
// em análise -> recusa; nenhuma -> segue; consulta falhou -> recusa (fail closed).
import { createHash } from "node:crypto";
import { and, eq, gt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { alertSeller } from "@/lib/alerts";
import { ActionError, runAction, type Ctx } from "@/lib/actions/core";
import { UNKNOWN_IP } from "@/lib/client-ip";
import { withStore, type Tx } from "@/lib/db/client";
import { cardAttempt, customer, integration, offer, orders, payment } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { IntegrationSecretUnreadable } from "@/lib/integrations";
import { enqueue } from "@/lib/jobs";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import { cardBreakerKey, cardDeclineIpKey } from "@/lib/payments/card-keys";
import { CARD_UNAVAILABLE_MESSAGE } from "@/lib/payments/card-messages";
import { checkCardFingerprint, checkRateLimit, countRecentEvents, hadRecentEvent, ipRateKey, recordEvent } from "@/lib/payments/ratelimit";
import { checkoutHostnames, verifyTurnstile, type TurnstileDeps } from "@/lib/payments/turnstile";
import { storeCheckoutOrigins } from "@/lib/stores";
import { cardExpiryValid } from "@/lib/validation/br";
import { luhnValid, SANDBOX_TEST_CARD } from "@/lib/validation/card-number";
import { asaasClientFor, asaasDueDate, centsToReais, type AsaasErrorDetails, type AsaasPayment, type CreatePaymentBody } from "./client";
import { buyerOf, ensureAsaasCustomer } from "./pix";
import { applyAsaasPayment, asaasPaymentInput, mapAsaasStatus } from "./webhook";

/** IP desconhecido (sem proxy confiável o X-Forwarded-For não é lido): sem limite por IP; valem e-mail e cartão. */
export { UNKNOWN_IP };
export const UNAVAILABLE_MESSAGE = CARD_UNAVAILABLE_MESSAGE;
export const DECLINE_MESSAGE = "Pagamento recusado. Confira os dados ou pague com Pix.";
export const UNKNOWN_MESSAGE = "Não foi possível confirmar o pagamento. Verifique em instantes antes de tentar de novo.";
export const ANALYSIS_MESSAGE = "Já existe um pagamento em análise para este pedido. Aguarde alguns minutos.";
/** Cobrança no Asaas ainda sem desfecho (cartão em análise/autorizado): uma nova tentativa poderia cobrar em dobro. */
const OPEN_STATUSES = new Set(["PENDING", "AUTHORIZED", "AWAITING_RISK_ANALYSIS"]);
export const BUSY_MESSAGE =
  "Já existe um pagamento com cartão em processamento para este pedido. Verifique em instantes antes de tentar de novo.";

const CARD_TIMEOUT_MS = 60_000;
const HOUR = 3600;
export const LIMITS = { ip: 10, email: 5, card: 3 } as const;
/**
 * Disjuntor por loja: ≥ 10 recusas de cartão em 15 min ⇒ por 1 h toda tentativa de cartão da loja exige Turnstile.
 * Sem Turnstile configurado: no máximo 3 tentativas por hora por origem (IP, agrupado por /64; IP desconhecido: e-mail)
 * na loja. Um teto global da loja seria consumido pelo próprio atacante e desligaria o cartão para todos.
 */
export const BREAKER = { declines: 10, windowSec: 15 * 60, holdSec: 3600, capPerSourceWithoutTurnstile: 3 } as const;
/** Códigos de erro do Asaas que significam recusa do cartão (doc: "invalid_creditCard"). Os demais: integração. */
const DECLINE_CODES = new Set(["invalid_creditCard"]);
/** HTTP em que o Asaas rejeitou a requisição sem processá-la (sem cobrança): erro de integração/configuração. */
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 422, 429]);
/** Depois de um resultado desconhecido, novas tentativas no mesmo pedido ficam bloqueadas por 2 min (contados do fim). */
const UNKNOWN_BLOCK_MS = 2 * 60_000;
/** Tentativa `processing` mais velha que isto é tratada como abandonada (processo caiu no meio). */
const PROCESSING_STALE_MS = 5 * 60_000;
/** Quanto uma repetição (mesma chave) espera pela tentativa original. */
const POLL_DEADLINE_MS = 65_000;

/** Códigos internos em `card_attempt.error_message` (nunca texto do Asaas). */
const NO_CHARGE = "sem_cobranca";
const UNKNOWN = "resultado_desconhecido";
const INTEGRATION = "erro_integracao";

export interface CardPaymentInput {
  orderPublicId: string;
  idempotencyKey: string;
  installments: number;
  card: { holderName: string; number: string; expiryMonth: string; expiryYear: string; ccv: string };
  holder: { cpf: string; postalCode: string; addressNumber: string };
  turnstileToken?: string;
  clientIp: string;
}

export type CardResult =
  | { status: "approved"; message?: undefined }
  | { status: "declined" | "unknown" | "unavailable"; message: string };

export interface CardDeps {
  /** Espera entre leituras quando outra requisição com a mesma chave está em andamento. */
  wait?: (ms: number) => Promise<void>;
  /** Relógio (limites, janela de bloqueio, dueDate e created_at da tentativa). */
  now?: () => Date;
  verifyTurnstile?: (token: string | undefined, ip: string) => Promise<boolean>;
  /** Sem `verifyTurnstile`: segredo e fetch do siteverify (testes); os hosts são sempre os do checkout da loja. */
  turnstile?: TurnstileDeps;
  /** Turnstile está configurado (padrão: TURNSTILE_SECRET definido). Decide o que o disjuntor da loja exige. */
  turnstileConfigured?: boolean;
}

const digits = (s: string) => s.replace(/\D/g, "");
const schema = z.object({
  orderPublicId: z.string().min(1).max(64),
  idempotencyKey: z.uuid(),
  installments: z.number().int().min(1).max(12),
  card: z.object({
    holderName: z.string().trim().min(2).max(100),
    number: z
      .string()
      .max(40)
      .transform((s) => s.replace(/[\s.-]/g, ""))
      .pipe(z.string().regex(/^\d{13,19}$/)),
    expiryMonth: z.coerce
      .string()
      .regex(/^(0?[1-9]|1[0-2])$/)
      .transform((m) => m.padStart(2, "0")),
    expiryYear: z.coerce
      .string()
      .regex(/^(\d{2}|\d{4})$/)
      .transform((y) => (y.length === 2 ? `20${y}` : y)),
    ccv: z.string().regex(/^\d{3,4}$/),
  }),
  holder: z.object({
    cpf: z.string().max(20).transform(digits).pipe(z.string().regex(/^(\d{11}|\d{14})$/)),
    postalCode: z.string().max(12).transform(digits).pipe(z.string().regex(/^\d{8}$/)),
    addressNumber: z.string().trim().min(1).max(20),
  }),
  turnstileToken: z.string().max(4096).optional(),
  clientIp: z.string().min(1).max(64),
});

const approved = (): CardResult => ({ status: "approved" });
const declined = (): CardResult => ({ status: "declined", message: DECLINE_MESSAGE });
const unknown = (): CardResult => ({ status: "unknown", message: UNKNOWN_MESSAGE });
const unavailable = (): CardResult => ({ status: "unavailable", message: UNAVAILABLE_MESSAGE });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Attempt = typeof cardAttempt.$inferSelect;

/**
 * Paga um pedido `card_asaas` com o cartão digitado. Chamada só pelo serviço de cartão isolado (POST /api/card).
 * Erros: `invalid_input`, `not_found`, `conflict`, `rate_limited` (details `{ captcha: true }` quando falta o Turnstile).
 */
export async function payWithCard(call: { storeId: string }, raw: CardPaymentInput, deps: CardDeps = {}): Promise<CardResult> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Só os caminhos dos campos: nunca valores (seriam dados do cartão).
    throw new ActionError("invalid_input", "Dados de pagamento inválidos", parsed.error.issues.map((i) => ({ path: i.path.map(String) })));
  }
  const input = parsed.data;
  const { storeId } = call;
  const now = deps.now ?? (() => new Date());
  const ip = input.clientIp;
  const t = now();
  // Validade antes do mês atual (São Paulo) é erro de digitação: não vira cobrança recusada nem erro de integração.
  if (!cardExpiryValid(input.card.expiryMonth, input.card.expiryYear, t)) {
    throw new ActionError("invalid_input", "Cartão vencido ou validade inválida", [{ path: ["card", "expiryMonth"] }]);
  }

  // 1. Leitura curta.
  const pre = await withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.publicId, input.orderPublicId));
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    const [existing] = await tx.select().from(cardAttempt).where(eq(cardAttempt.idempotencyKey, input.idempotencyKey));
    const [of] = await tx.select({ maxInstallments: offer.maxInstallments }).from(offer).where(eq(offer.id, o.offerId));
    const [c] = await tx.select().from(customer).where(eq(customer.id, o.customerId));
    // Tentativa anterior de desfecho desconhecido, já fora da janela de bloqueio: exige conferir no Asaas.
    const [unresolved] = await tx
      .select({ id: cardAttempt.id })
      .from(cardAttempt)
      .where(
        and(
          eq(cardAttempt.orderId, o.id),
          or(
            and(eq(cardAttempt.status, "error"), eq(cardAttempt.errorMessage, UNKNOWN)),
            and(eq(cardAttempt.status, "processing"), lte(cardAttempt.createdAt, new Date(t.getTime() - PROCESSING_STALE_MS))),
          ),
        ),
      )
      .limit(1);
    const [conn] = await tx
      .select({ config: integration.config })
      .from(integration)
      .where(and(eq(integration.storeId, storeId), eq(integration.kind, "asaas")));
    const sandbox = (conn?.config as { env?: unknown } | undefined)?.env !== "production";
    return { o, existing, maxInstallments: of?.maxInstallments ?? 1, cust: c!, unresolved: unresolved !== undefined, sandbox };
  });
  const order = pre.o;
  if (pre.existing) return awaitAttempt(storeId, pre.existing, order.id, deps);
  if (order.method !== "card_asaas") throw new ActionError("conflict", "Pedido não é de cartão");
  if (order.status === "paid") return approved();
  if (order.status !== "pending") throw new ActionError("conflict", "Pedido não está pendente");
  // Luhn antes de qualquer limite ou chamada ao Asaas: erro de digitação (ou número aleatório de quem quer derrubar o
  // cartão da loja) não vira recusa, não conta nos limites nem no disjuntor.
  if (!luhnValid(input.card.number) && !(pre.sandbox && input.card.number === SANDBOX_TEST_CARD)) {
    throw new ActionError("invalid_input", "Número do cartão inválido. Confira os dígitos.", [{ path: ["card", "number"] }]);
  }

  // 2. Parcelas, limites e Turnstile (antes de gravar a tentativa).
  if (input.installments > pre.maxInstallments) {
    throw new ActionError("invalid_input", `Esta oferta permite até ${pre.maxInstallments} parcela(s)`, [{ path: ["installments"] }]);
  }
  const limited = () => new ActionError("rate_limited", "Muitas tentativas de pagamento. Aguarde e tente mais tarde ou pague com Pix.");
  const knownIp = ip !== UNKNOWN_IP;
  // IPv6 agrupado por /64: trocar de endereço dentro da mesma rede não escapa do limite.
  const ipKey = ipRateKey(ip);
  const emailHash = sha256(pre.cust.email.toLowerCase());
  const breakerKey = cardBreakerKey(storeId);
  // IP desconhecido (sem proxy confiável): uma chave única para todos seria um limite global; vale só e-mail e cartão.
  if (knownIp && !(await checkRateLimit(`card:ip:${ipKey}`, LIMITS.ip, HOUR, t))) throw limited();
  if (!(await checkRateLimit(`card:email:${emailHash}`, LIMITS.email, HOUR, t))) throw limited();
  if (!checkCardFingerprint(input.card.number, LIMITS.card, HOUR, t.getTime())) throw limited();
  const breakerOn = await hadRecentEvent(breakerKey, BREAKER.holdSec, t);
  const turnstileOn = deps.turnstileConfigured ?? Boolean(env.TURNSTILE_SECRET);
  if (breakerOn && !turnstileOn) {
    // Teto por origem (IP /64; sem IP conhecido, o e-mail), nunca global: o atacante só esgota o próprio teto.
    const source = knownIp ? `ip:${ipKey}` : `email:${emailHash}`;
    if (!(await checkRateLimit(`card:store:${storeId}:${source}`, BREAKER.capPerSourceWithoutTurnstile, HOUR, t))) throw limited();
  }
  const recentDecline =
    (knownIp && (await hadRecentEvent(cardDeclineIpKey(ipKey), HOUR, t))) || (await hadRecentEvent(`card:decline:email:${emailHash}`, HOUR, t));
  if (recentDecline || (breakerOn && turnstileOn)) {
    const verify =
      deps.verifyTurnstile ??
      (async (tok: string | undefined, at: string) =>
        verifyTurnstile(tok, at, { hosts: checkoutHostnames(await storeCheckoutOrigins(storeId)), ...deps.turnstile }));
    if (!(await verify(input.turnstileToken, ip))) {
      throw new ActionError("rate_limited", "Confirme que você não é um robô e tente de novo.", { captcha: true });
    }
  }

  // 2b. Tentativa anterior de desfecho desconhecido: confere no Asaas antes de arriscar uma segunda cobrança.
  if (pre.unresolved) {
    if (await recentlyBusy(storeId, order.id, t)) throw new ActionError("conflict", BUSY_MESSAGE);
    if ((await reconcileWithAsaas(storeId, order.id)) === "paid") return approved();
  }

  // 3. Transação curta: trava o pedido e grava a tentativa.
  type Step = { replay: Attempt } | { paid: true } | { attempt: Attempt };
  const step = await withStore(storeId, async (tx): Promise<Step> => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, order.id)).for("update");
    const byKey = async () => (await tx.select().from(cardAttempt).where(eq(cardAttempt.idempotencyKey, input.idempotencyKey)))[0];
    const again = await byKey();
    if (again) return { replay: again };
    if (o!.status === "paid") return { paid: true };
    if (o!.status !== "pending") throw new ActionError("conflict", "Pedido não está pendente");
    const [busy] = await tx.select({ id: cardAttempt.id }).from(cardAttempt).where(busyWhere(order.id, t)).limit(1);
    if (busy) throw new ActionError("conflict", BUSY_MESSAGE);
    const [created] = await tx
      .insert(cardAttempt)
      .values({ storeId, orderId: order.id, idempotencyKey: input.idempotencyKey, status: "processing", createdAt: t })
      .onConflictDoNothing()
      .returning();
    if (created) return { attempt: created };
    const raced = await byKey();
    if (raced) return { replay: raced };
    // A chave existe, mas não é visível (RLS: outra loja).
    throw new ActionError("conflict", "Chave de pagamento já usada");
  });
  if ("replay" in step) return awaitAttempt(storeId, step.replay, order.id, deps);
  if ("paid" in step) return approved();
  const attempt = step.attempt;

  // 4. Fora de transação: cliente e cobrança no Asaas.
  let client: Awaited<ReturnType<typeof asaasClientFor>>;
  let asaasCustomer: string;
  try {
    client = await withStore(storeId, (tx) => asaasClientFor(tx, storeId));
    asaasCustomer = await ensureAsaasCustomer({ storeId }, order.customerId, buyerOf(order));
  } catch (e) {
    // Nenhuma cobrança foi enviada: libera o pedido para nova tentativa.
    await closeAttempt(storeId, attempt.id, { status: "error", errorMessage: NO_CHARGE }, now());
    if (e instanceof IntegrationSecretUnreadable) {
      // Chave do Asaas da loja que este processo não abre (no serviço de cartão: conexão ainda em v1). Configuração,
      // não o comprador: "indisponível" (o iframe não trava o cartão) e o operador vê no log.
      log.error("cartão: a conexão Asaas da loja não pode ser aberta; confira a ASAAS_SEAL_KEY e a re-selagem", { storeId, orderId: order.id, attemptId: attempt.id });
      return unavailable();
    }
    throw e;
  }

  const total = order.totalCents;
  const body: CreatePaymentBody = {
    customer: asaasCustomer,
    billingType: "CREDIT_CARD",
    // Parcelado: installmentCount + totalValue (o Asaas divide e põe a diferença de arredondamento na última parcela).
    ...(input.installments > 1 ? { installmentCount: input.installments, totalValue: centsToReais(total) } : { value: centsToReais(total) }),
    dueDate: asaasDueDate(t),
    externalReference: order.id,
    creditCard: {
      holderName: input.card.holderName,
      number: input.card.number,
      expiryMonth: input.card.expiryMonth,
      expiryYear: input.card.expiryYear,
      ccv: input.card.ccv,
    },
    creditCardHolderInfo: {
      name: input.card.holderName,
      email: pre.cust.email,
      cpfCnpj: input.holder.cpf,
      postalCode: input.holder.postalCode,
      addressNumber: input.holder.addressNumber,
      phone: order.buyerPhone ?? pre.cust.phone,
      mobilePhone: order.buyerPhone ?? pre.cust.phone,
    },
    // Asaas exige remoteIp; sem proxy confiável não sabemos o IP real (configuração de produção exige TRUST_PROXY).
    remoteIp: knownIp ? ip : "0.0.0.0",
  };

  let charged: AsaasPayment;
  try {
    charged = await client.createPayment(body, { timeoutMs: CARD_TIMEOUT_MS });
  } catch (e) {
    // Só status e códigos de erro do Asaas: as descrições podem ecoar dados do cartão.
    const d = (e instanceof ActionError ? e.details : undefined) as Partial<AsaasErrorDetails> | undefined;
    const asaas = { status: d?.status ?? 0, errorCodes: d?.errorCodes ?? [] };
    if (asaas.status === 400 && asaas.errorCodes.some((c) => DECLINE_CODES.has(c))) {
      await closeAttempt(storeId, attempt.id, { status: "declined" }, now(), (tx) => enqueueDeclineNotice(tx, storeId, order.id, attempt.id));
      if (knownIp) await recordEvent(cardDeclineIpKey(ipKey), t);
      await recordEvent(`card:decline:email:${emailHash}`, t);
      await countStoreDecline(storeId, t);
      log.warn("cartão recusado pelo Asaas", { orderId: order.id, attemptId: attempt.id, asaas });
      return declined();
    }
    if (REJECTED_STATUSES.has(asaas.status)) {
      // O Asaas rejeitou sem processar (sem cobrança): problema de integração/configuração da loja, não do cartão.
      // Não conta como recusa (sem Turnstile nem disjuntor); fica visível para o vendedor no log, só com códigos.
      await closeAttempt(storeId, attempt.id, { status: "error", errorMessage: INTEGRATION }, now());
      log.error("cartão: erro de integração com o Asaas; confira a conexão da loja", {
        storeId,
        orderId: order.id,
        attemptId: attempt.id,
        asaas,
      });
      return unavailable();
    }
    await closeAttempt(storeId, attempt.id, { status: "error", errorMessage: UNKNOWN }, now());
    log.warn("cartão: resultado desconhecido no Asaas; aguardando webhook", { orderId: order.id, attemptId: attempt.id, asaas });
    return unknown();
  }

  // 5. Transação curta: fecha a tentativa e aplica o resultado.
  try {
    const resolvedAt = now();
    return await withStore(storeId, (tx) =>
      applyCharge({ storeId, actor: { kind: "public" }, origin: "public", tx }, order.id, attempt.id, charged, resolvedAt),
    );
  } catch (e) {
    await closeAttempt(storeId, attempt.id, { status: "error", errorMessage: UNKNOWN }, now()).catch(() => undefined);
    throw e;
  }
}

/** Tentativa em andamento (< 5 min) ou de desfecho desconhecido há menos de 2 min: atalho que recusa sem consultar. */
function busyWhere(orderId: string, t: Date) {
  return and(
    eq(cardAttempt.orderId, orderId),
    or(
      and(eq(cardAttempt.status, "processing"), gt(cardAttempt.createdAt, new Date(t.getTime() - PROCESSING_STALE_MS))),
      and(
        eq(cardAttempt.status, "error"),
        eq(cardAttempt.errorMessage, UNKNOWN),
        // Conta do FIM da tentativa (a resposta pode ter demorado até 60 s); linhas antigas sem resolved_at: do início.
        sql`coalesce(${cardAttempt.resolvedAt}, ${cardAttempt.createdAt}) > ${new Date(t.getTime() - UNKNOWN_BLOCK_MS).toISOString()}::timestamptz`,
      ),
    ),
  );
}

async function recentlyBusy(storeId: string, orderId: string, t: Date): Promise<boolean> {
  const rows = await withStore(storeId, (tx) => tx.select({ id: cardAttempt.id }).from(cardAttempt).where(busyWhere(orderId, t)).limit(1));
  return rows.length > 0;
}

/**
 * Consulta no Asaas as cobranças do pedido (fora de transação). Paga -> aplica pelo mesmo caminho do webhook
 * (`applyAsaasPayment`: grava `payment` e `transitionOrder("paid")`) e devolve "paid"; em análise -> `conflict`;
 * nenhuma -> "none". Qualquer falha -> `conflict` com a mensagem de "verifique em instantes" (fail closed).
 */
async function reconcileWithAsaas(storeId: string, orderId: string): Promise<"paid" | "none"> {
  const failClosed = (e: unknown): never => {
    if (e instanceof ActionError && e.code === "conflict") throw e;
    log.warn("cartão: conferência no Asaas falhou; nova tentativa recusada", { orderId, error: e });
    throw new ActionError("conflict", UNKNOWN_MESSAGE);
  };
  let charges: AsaasPayment[];
  let client: Awaited<ReturnType<typeof asaasClientFor>>;
  try {
    client = await withStore(storeId, (tx) => asaasClientFor(tx, storeId));
    charges = await client.listPaymentsByExternalReference(orderId);
  } catch (e) {
    return failClosed(e);
  }
  const paid = charges.find((c) => mapAsaasStatus(String(c.status)) === "paid");
  if (paid) {
    try {
      const applyInput = await asaasPaymentInput(client, paid);
      await runAction(applyAsaasPayment, { storeId, actor: { kind: "system" }, origin: "system" }, applyInput);
      const [o] = await withStore(storeId, (tx) => tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)));
      if (o?.status === "paid") {
        log.info("cartão: cobrança de tentativa anterior estava paga; pedido liquidado pela conferência", { orderId, paymentId: paid.id });
        return "paid";
      }
    } catch (e) {
      return failClosed(e);
    }
    // Paga, mas o pedido não liberou (ex.: valor menor): não arrisca outra cobrança.
    throw new ActionError("conflict", UNKNOWN_MESSAGE);
  }
  if (charges.some((c) => OPEN_STATUSES.has(String(c.status)))) throw new ActionError("conflict", ANALYSIS_MESSAGE);
  return "none";
}

/** Conta uma recusa na loja; na 10ª em 15 min liga o disjuntor por 1 h e avisa o vendedor (log e e-mail via notify_seller). */
async function countStoreDecline(storeId: string, t: Date): Promise<void> {
  const key = `card:decline:store:${storeId}`;
  const breakerKey = cardBreakerKey(storeId);
  await recordEvent(key, t);
  const n = await countRecentEvents(key, BREAKER.windowSec, t);
  if (n < BREAKER.declines || (await hadRecentEvent(breakerKey, BREAKER.holdSec, t))) return;
  await recordEvent(breakerKey, t);
  // Aviso por e-mail ao vendedor (no máximo 1 por disparo: o disjuntor fica ligado 1 h). Falha aqui não muda a recusa.
  await withStore(storeId, (tx) => alertSeller(tx, storeId, "disjuntor_cartao")).catch((e: unknown) =>
    log.error("falha ao enfileirar o aviso do disjuntor de cartão", { storeId, error: e }),
  );
  log.warn("loja com muitas recusas de cartão (possível teste de cartão): verificação anti-robô exigida por 1 h", {
    storeId,
    declines: n,
    windowMin: BREAKER.windowSec / 60,
  });
}

async function applyCharge(ctx: Ctx, orderId: string, attemptId: string, charged: AsaasPayment, resolvedAt: Date): Promise<CardResult> {
  const { tx, storeId } = ctx;
  const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  const paid = mapAsaasStatus(String(charged.status)) === "paid";
  const installment = typeof charged.installment === "string" && charged.installment ? charged.installment : null;
  await tx
    .update(cardAttempt)
    .set({ status: paid ? "approved" : "error", asaasPaymentId: charged.id, errorMessage: paid ? null : UNKNOWN, resolvedAt })
    .where(eq(cardAttempt.id, attemptId));

  const rows = await tx.select().from(payment).where(and(eq(payment.orderId, orderId), eq(payment.provider, "asaas")));
  // O webhook pode ter chegado antes e gravado esta cobrança (ou outra parcela do mesmo parcelamento).
  const known = rows.some(
    (r) => r.providerId === charged.id || (installment !== null && (r.raw as { installment?: string } | null)?.installment === installment),
  );
  // Pedido já pago por outra cobrança (ex.: uma tentativa anterior de resultado desconhecido): pagamento em dobro.
  const duplicate = paid && !known && o!.status !== "pending";
  if (!known) {
    const rawInfo = { ...(installment ? { installment } : {}), ...(duplicate ? { duplicate: true } : {}) };
    await tx
      .insert(payment)
      .values({
        storeId,
        orderId,
        provider: "asaas",
        providerId: charged.id,
        status: String(charged.status),
        amountCents: o!.totalCents,
        raw: Object.keys(rawInfo).length > 0 ? rawInfo : null,
      })
      .onConflictDoNothing();
  }
  if (duplicate) {
    log.warn("pagamento em dobro: cartão aprovado em pedido já resolvido; devolver ao comprador", {
      orderId,
      paymentId: charged.id,
      orderStatus: o!.status,
    });
    return approved();
  }
  if (!paid) return unknown();
  try {
    await transitionOrder(ctx, orderId, "paid", "cartão aprovado no Asaas");
  } catch (e) {
    if (!(e instanceof ActionError && e.code === "conflict")) throw e;
    log.warn("cartão aprovado em pedido que não aceita pagamento", { orderId, orderStatus: o!.status });
  }
  return approved();
}

/** Fecha a tentativa ainda em andamento; `onClosed` roda na mesma transação, só se o UPDATE mudou a linha. */
async function closeAttempt(
  storeId: string,
  id: string,
  set: { status: "declined" | "error"; errorMessage?: string },
  resolvedAt: Date,
  onClosed?: (tx: Tx) => Promise<void>,
): Promise<void> {
  await withStore(storeId, async (tx) => {
    const closed = await tx
      .update(cardAttempt)
      .set({ status: set.status, errorMessage: set.errorMessage ?? null, resolvedAt })
      .where(and(eq(cardAttempt.id, id), eq(cardAttempt.status, "processing")))
      .returning({ id: cardAttempt.id });
    if (closed.length > 0 && onClosed) await onClosed(tx);
  });
}

/**
 * Aviso "cartão recusado" no Telegram da loja: só na primeira recusa do pedido (um teste de cartões com muitas recusas
 * gera no máximo um job por pedido; a marca em `telegram_notice` garante um envio). Vai sempre para a fila: o papel
 * `card` não lê a conexão do Telegram, e o job confere no envio se o evento está ligado e se o pedido segue sem pagar.
 * Num savepoint: se o enfileiramento falhar (ex.: política antiga do `job` enquanto o app não aplicou o rls.sql), a
 * recusa continua registrada e contada; só o aviso se perde, com log.
 */
async function enqueueDeclineNotice(tx: Tx, storeId: string, orderId: string, attemptId: string): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      const [earlier] = await sp
        .select({ id: cardAttempt.id })
        .from(cardAttempt)
        .where(and(eq(cardAttempt.orderId, orderId), eq(cardAttempt.status, "declined"), ne(cardAttempt.id, attemptId)))
        .limit(1);
      if (earlier) return;
      await enqueue(sp as Tx, { storeId, type: "notify_telegram", payload: { event: "card_declined", orderId } });
    });
  } catch (error) {
    log.error("aviso do Telegram não enfileirado", { orderId, event: "card_declined", error });
  }
}

function resultOf(a: Attempt): CardResult {
  if (a.status === "approved") return approved();
  if (a.status === "declined") return declined();
  return unknown();
}

/** Repetição com a mesma chave: devolve o resultado da tentativa original, esperando-a se ainda estiver em andamento. */
async function awaitAttempt(storeId: string, first: Attempt, orderId: string, deps: CardDeps): Promise<CardResult> {
  if (first.orderId !== orderId) throw new ActionError("conflict", "Chave de pagamento já usada em outro pedido");
  const wait = deps.wait ?? defaultWait;
  const started = Date.now();
  let a = first;
  for (let i = 0; a.status === "processing"; i++) {
    if (Date.now() - started > POLL_DEADLINE_MS) return unknown();
    await wait(Math.min(250 * 2 ** i, 2000));
    const [row] = await withStore(storeId, (tx) => tx.select().from(cardAttempt).where(eq(cardAttempt.id, a.id)));
    if (!row) return unknown();
    a = row;
  }
  return resultOf(a);
}
