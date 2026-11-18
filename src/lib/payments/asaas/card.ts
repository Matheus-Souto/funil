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
import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { ActionError, type Ctx } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { cardAttempt, customer, offer, orders, payment } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import { checkCardFingerprint, checkRateLimit, hadRecentEvent, recordEvent } from "@/lib/payments/ratelimit";
import { verifyTurnstile } from "@/lib/payments/turnstile";
import { asaasClientFor, asaasDueDate, centsToReais, type AsaasErrorDetails, type AsaasPayment, type CreatePaymentBody } from "./client";
import { ensureAsaasCustomer } from "./pix";
import { mapAsaasStatus } from "./webhook";

export const DECLINE_MESSAGE = "Pagamento recusado. Confira os dados ou pague com Pix.";
export const UNKNOWN_MESSAGE = "Não foi possível confirmar o pagamento. Verifique em instantes antes de tentar de novo.";
const BUSY_MESSAGE =
  "Já existe um pagamento com cartão em processamento para este pedido. Verifique em instantes antes de tentar de novo.";

const CARD_TIMEOUT_MS = 60_000;
const HOUR = 3600;
export const LIMITS = { ip: 10, email: 5, card: 3 } as const;
/** Depois de um resultado desconhecido, novas tentativas no mesmo pedido ficam bloqueadas por 2 min. */
const UNKNOWN_BLOCK_MS = 2 * 60_000;
/** Tentativa `processing` mais velha que isto é tratada como abandonada (processo caiu no meio). */
const PROCESSING_STALE_MS = 5 * 60_000;
/** Quanto uma repetição (mesma chave) espera pela tentativa original. */
const POLL_DEADLINE_MS = 65_000;

/** Códigos internos em `card_attempt.error_message` (nunca texto do Asaas). */
const NO_CHARGE = "sem_cobranca";
const UNKNOWN = "resultado_desconhecido";

export interface CardPaymentInput {
  orderPublicId: string;
  idempotencyKey: string;
  installments: number;
  card: { holderName: string; number: string; expiryMonth: string; expiryYear: string; ccv: string };
  holder: { cpf: string; postalCode: string; addressNumber: string };
  turnstileToken?: string;
  clientIp: string;
}

export type CardResult = { status: "approved"; message?: undefined } | { status: "declined" | "unknown"; message: string };

export interface CardDeps {
  /** Espera entre leituras quando outra requisição com a mesma chave está em andamento. */
  wait?: (ms: number) => Promise<void>;
  /** Relógio (limites, janela de bloqueio, dueDate e created_at da tentativa). */
  now?: () => Date;
  verifyTurnstile?: (token: string | undefined, ip: string) => Promise<boolean>;
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
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Attempt = typeof cardAttempt.$inferSelect;

/**
 * Paga um pedido `card_asaas` com o cartão digitado. Chamada só pela rota POST /api/checkout/card.
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

  // 1. Leitura curta.
  const pre = await withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.publicId, input.orderPublicId));
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    const [existing] = await tx.select().from(cardAttempt).where(eq(cardAttempt.idempotencyKey, input.idempotencyKey));
    const [of] = await tx.select({ maxInstallments: offer.maxInstallments }).from(offer).where(eq(offer.id, o.offerId));
    const [c] = await tx.select().from(customer).where(eq(customer.id, o.customerId));
    return { o, existing, maxInstallments: of?.maxInstallments ?? 1, cust: c! };
  });
  const order = pre.o;
  if (pre.existing) return awaitAttempt(storeId, pre.existing, order.id, deps);
  if (order.method !== "card_asaas") throw new ActionError("conflict", "Pedido não é de cartão");
  if (order.status === "paid") return approved();
  if (order.status !== "pending") throw new ActionError("conflict", "Pedido não está pendente");

  // 2. Parcelas, limites e Turnstile (antes de gravar a tentativa).
  if (input.installments > pre.maxInstallments) {
    throw new ActionError("invalid_input", `Esta oferta permite até ${pre.maxInstallments} parcela(s)`, [{ path: ["installments"] }]);
  }
  const t = now();
  const limited = () => new ActionError("rate_limited", "Muitas tentativas de pagamento. Aguarde e tente mais tarde ou pague com Pix.");
  if (!(await checkRateLimit(`card:ip:${ip}`, LIMITS.ip, HOUR, t))) throw limited();
  if (!(await checkRateLimit(`card:email:${sha256(pre.cust.email.toLowerCase())}`, LIMITS.email, HOUR, t))) throw limited();
  if (!checkCardFingerprint(input.card.number, LIMITS.card, HOUR, t.getTime())) throw limited();
  if (await hadRecentEvent(`card:decline:ip:${ip}`, HOUR, t)) {
    const verify = deps.verifyTurnstile ?? verifyTurnstile;
    if (!(await verify(input.turnstileToken, ip))) {
      throw new ActionError("rate_limited", "Confirme que você não é um robô e tente de novo.", { captcha: true });
    }
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
    const [busy] = await tx
      .select({ id: cardAttempt.id })
      .from(cardAttempt)
      .where(
        and(
          eq(cardAttempt.orderId, order.id),
          or(
            and(eq(cardAttempt.status, "processing"), gt(cardAttempt.createdAt, new Date(t.getTime() - PROCESSING_STALE_MS))),
            and(
              eq(cardAttempt.status, "error"),
              eq(cardAttempt.errorMessage, UNKNOWN),
              gt(cardAttempt.createdAt, new Date(t.getTime() - UNKNOWN_BLOCK_MS)),
            ),
          ),
        ),
      )
      .limit(1);
    if (busy) throw new ActionError("conflict", BUSY_MESSAGE);
    // O Asaas exige CPF/CNPJ no cliente: sem CPF no pedido, usa o do titular (não é dado do cartão).
    if (!pre.cust.cpf) {
      await tx.update(customer).set({ cpf: input.holder.cpf }).where(and(eq(customer.id, pre.cust.id), isNull(customer.cpf)));
    }
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
    asaasCustomer = await ensureAsaasCustomer({ storeId }, order.customerId);
  } catch (e) {
    // Nenhuma cobrança foi enviada: libera o pedido para nova tentativa.
    await closeAttempt(storeId, attempt.id, { status: "error", errorMessage: NO_CHARGE });
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
      phone: pre.cust.phone,
      mobilePhone: pre.cust.phone,
    },
    remoteIp: ip,
  };

  let charged: AsaasPayment;
  try {
    charged = await client.createPayment(body, { timeoutMs: CARD_TIMEOUT_MS });
  } catch (e) {
    // Só status e códigos de erro do Asaas: as descrições podem ecoar dados do cartão.
    const d = (e instanceof ActionError ? e.details : undefined) as Partial<AsaasErrorDetails> | undefined;
    const asaas = { status: d?.status ?? 0, errorCodes: d?.errorCodes ?? [] };
    if (asaas.status === 400) {
      await closeAttempt(storeId, attempt.id, { status: "declined" });
      await recordEvent(`card:decline:ip:${ip}`, t);
      log.warn("cartão recusado pelo Asaas", { orderId: order.id, attemptId: attempt.id, asaas });
      return declined();
    }
    await closeAttempt(storeId, attempt.id, { status: "error", errorMessage: UNKNOWN });
    log.warn("cartão: resultado desconhecido no Asaas; aguardando webhook", { orderId: order.id, attemptId: attempt.id, asaas });
    return unknown();
  }

  // 5. Transação curta: fecha a tentativa e aplica o resultado.
  try {
    return await withStore(storeId, (tx) => applyCharge({ storeId, actor: { kind: "public" }, origin: "public", tx }, order.id, attempt.id, charged));
  } catch (e) {
    await closeAttempt(storeId, attempt.id, { status: "error", errorMessage: UNKNOWN }).catch(() => undefined);
    throw e;
  }
}

async function applyCharge(ctx: Ctx, orderId: string, attemptId: string, charged: AsaasPayment): Promise<CardResult> {
  const { tx, storeId } = ctx;
  const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  const paid = mapAsaasStatus(String(charged.status)) === "paid";
  const installment = typeof charged.installment === "string" && charged.installment ? charged.installment : null;
  await tx
    .update(cardAttempt)
    .set({ status: paid ? "approved" : "error", asaasPaymentId: charged.id, errorMessage: paid ? null : UNKNOWN })
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

async function closeAttempt(storeId: string, id: string, set: { status: "declined" | "error"; errorMessage?: string }): Promise<void> {
  await withStore(storeId, (tx) =>
    tx
      .update(cardAttempt)
      .set({ status: set.status, errorMessage: set.errorMessage ?? null })
      .where(and(eq(cardAttempt.id, id), eq(cardAttempt.status, "processing"))),
  );
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
