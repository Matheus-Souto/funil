import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction, type Ctx } from "@/lib/actions/core";
import { alertSeller } from "@/lib/alerts";
import { timingSafeEqualStr } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { orders, payment } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { checkRateLimit } from "@/lib/payments/ratelimit";
import { transitionOrder, type OrderStatus } from "@/lib/orders/state";
import { asaasClientFor, reaisToCents, type AsaasClient, type AsaasPayment } from "./client";
import { classifyRefund, refundItems, refundMarkerOf, refundedCents, type RefundItem } from "./refunds";

/** Estado das cobranças Asaas abertas de uma conta anterior da loja (fora do índice de cobrança aberta). */
export const SUPERSEDED = "superseded";

export function mapAsaasStatus(s: string): OrderStatus | null {
  switch (s) {
    case "CONFIRMED":
    case "RECEIVED":
    case "RECEIVED_IN_CASH":
      return "paid";
    // REFUND_REQUESTED/REFUND_IN_PROGRESS: estorno em andamento, o dinheiro ainda não voltou (sem transição; o pedido
    // fica com o estorno solicitado). Só REFUNDED (ou refunds[DONE] cobrindo o total) conclui.
    case "REFUNDED":
      return "refunded";
    case "CHARGEBACK_REQUESTED":
    case "CHARGEBACK_DISPUTE":
    case "AWAITING_CHARGEBACK_REVERSAL":
      return "disputed";
    case "OVERDUE":
      return "expired";
    default:
      return null;
  }
}

function rawOf(installment: string | null, duplicate: boolean): Record<string, unknown> | null {
  const r = { ...(installment ? { installment } : {}), ...(duplicate ? { duplicate: true } : {}) };
  return Object.keys(r).length > 0 ? r : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = z.object({ event: z.string().optional(), payment: z.object({ id: z.string().min(1).max(100) }) });

/** Aplica o estado JÁ reconsultado no Asaas ao pedido (nunca o corpo do webhook). Idempotente. */
export const applyAsaasPayment = defineAction({
  name: "payments.applyAsaasPayment",
  description: "Aplica ao pedido o estado de uma cobrança do Asaas reconsultada pelo webhook.",
  input: z.object({
    paymentId: z.string().min(1),
    status: z.string(),
    valueCents: z.number().int(),
    externalReference: z.string().nullable(),
    /** Id do parcelamento (cartão parcelado): cada parcela é uma cobrança; `valueCents` é então o total do parcelamento. */
    installment: z.string().min(1).max(100).nullable().optional(),
    /** Itens `refunds[]` da cobrança reconsultada (status e centavos; estorno só concluído com DONE cobrindo o total). */
    refunds: z.array(z.object({ status: z.string().max(64), cents: z.number().int().min(0) })).max(50).optional(),
    /** Valor desta cobrança (centavos). Parcela de cartão parcelado: o estorno total da parcela é o valor dela. */
    chargeCents: z.number().int().optional(),
  }),
  permission: "system",
  auditInput: (i) => ({
    paymentId: i.paymentId,
    status: i.status,
    valueCents: i.valueCents,
    installment: i.installment ?? null,
    refunds: i.refunds ?? [],
    chargeCents: i.chargeCents ?? null,
  }),
  async run(ctx, input) {
    let p = input;
    if (!p.externalReference || !UUID.test(p.externalReference)) return { applied: false, reason: "sem_pedido" };
    const [o] = await ctx.tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, p.externalReference), eq(orders.storeId, ctx.storeId)))
      .for("update");
    if (!o || (o.method !== "pix_asaas" && o.method !== "card_asaas")) return { applied: false, reason: "pedido_de_outra_loja_ou_metodo" };

    const rows = await ctx.tx.select().from(payment).where(and(eq(payment.provider, "asaas"), eq(payment.orderId, o.id)));
    const [global] = await ctx.tx
      .select()
      .from(payment)
      .where(and(eq(payment.provider, "asaas"), eq(payment.providerId, p.paymentId)));
    if (global && global.orderId !== o.id) return { applied: false, reason: "pagamento_de_outro_pedido" };
    const row = rows.find((r) => r.providerId === p.paymentId);
    const installment = p.installment ?? null;
    // Outra parcela de um parcelamento que o pedido já conhece: é a mesma venda, não cobrança órfã nem em dobro.
    const sibling =
      !row && installment !== null ? rows.find((r) => (r.raw as { installment?: string } | null)?.installment === installment) : undefined;
    // Estorno: a cobrança pode seguir CONFIRMED/RECEIVED com refunds[DONE] cobrindo o total -> trata como REFUNDED.
    const fullCents = installment !== null && p.chargeCents !== undefined ? p.chargeCents : o.totalCents;
    const refund = classifyRefund(p.status, p.refunds ?? [], refundMarkerOf((row ?? sibling)?.raw, o.refundRequestedAt), fullCents);
    if (refund === "done" && mapAsaasStatus(p.status) === "paid") p = { ...p, status: "REFUNDED" };
    if (refund === "cancelled" && o.status === "paid" && o.refundRequestedAt) {
      await ctx.tx.update(orders).set({ refundRequestedAt: null }).where(eq(orders.id, o.id));
      await alertSeller(ctx.tx, ctx.storeId, "estorno_cancelado", { orderId: o.id });
      log.warn("estorno cancelado no Asaas; o pedido continua pago (confira no Asaas e peça de novo se for o caso)", {
        orderId: o.id,
        paymentId: p.paymentId,
      });
    }
    const target0 = mapAsaasStatus(p.status);
    const orphan = !row && !sibling && rows.length > 0;

    // Cobrança marcada como duplicada (pagamento em dobro): só acompanha o status da linha, nunca mexe no pedido.
    if (row && (row.raw as { duplicate?: boolean } | null)?.duplicate === true) {
      if (row.status !== p.status) await ctx.tx.update(payment).set({ status: p.status }).where(eq(payment.id, row.id));
      return { applied: false, reason: "cobranca_duplicada" };
    }

    if (orphan) {
      // Cobrança que o pedido não conhece (ex.: criada e perdida numa falha). Só importa se o dinheiro chegou.
      if (target0 !== "paid") return { applied: false, reason: "cobranca_orfa" };
      await ctx.tx
        .insert(payment)
        .values({
          storeId: ctx.storeId,
          orderId: o.id,
          provider: "asaas",
          providerId: p.paymentId,
          status: p.status,
          amountCents: p.valueCents,
          // Só é duplicada se o pedido já estava resolvido; se esta cobrança é quem paga o pedido, é a cobrança "boa".
          raw: rawOf(installment, o.status !== "pending" && o.status !== "expired"),
        })
        .onConflictDoNothing();
      if (o.status !== "pending" && o.status !== "expired") {
        log.warn("pagamento em dobro: cobrança órfã paga em pedido já resolvido; devolver ao comprador", {
          orderId: o.id,
          paymentId: p.paymentId,
          orderStatus: o.status,
        });
        return { applied: false, reason: "pagamento_em_dobro" };
      }
    } else if (!row && !sibling) {
      await ctx.tx
        .insert(payment)
        .values({
          storeId: ctx.storeId,
          orderId: o.id,
          provider: "asaas",
          providerId: p.paymentId,
          status: p.status,
          amountCents: o.totalCents,
          raw: rawOf(installment, false),
        })
        .onConflictDoNothing();
    } else if (row && row.status !== p.status) {
      await ctx.tx.update(payment).set({ status: p.status }).where(eq(payment.id, row.id));
    }

    const known = row ?? sibling;
    if (o.status === "paid" && known && refund === "requested") await noteRefundInFlight(ctx, o, known, p.refunds ?? []);
    if (o.status === "paid" && known && refund === "partial") await notePartialRefund(ctx, o.id, known, refundedCents(p.refunds ?? []));

    const target = mapAsaasStatus(p.status);
    if (!target) return { applied: false, reason: "status_ignorado" };
    if (target === "paid" && p.valueCents < o.totalCents) {
      log.warn("pagamento do Asaas abaixo do total; pedido não liberado", { orderId: o.id, paid: p.valueCents, total: o.totalCents });
      return { applied: false, reason: "valor_menor" };
    }
    try {
      // Asaas confirmou (reconsultado): um Pix pago depois de expirar o prazo local ainda libera o pedido.
      const r = await transitionOrder(ctx, o.id, target, `asaas ${p.status}`, { allowFromExpired: target === "paid" });
      return { applied: r.changed, reason: r.changed ? "ok" : "ja_processado" };
    } catch (e) {
      if (e instanceof ActionError && e.code === "conflict") return { applied: false, reason: "transicao_invalida" };
      throw e;
    }
  },
});

type PaymentRow = typeof payment.$inferSelect;

const mergeRaw = (patch: Record<string, unknown>) => sql`coalesce(${payment.raw}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;

/**
 * Estorno em andamento no Asaas (pedido pelo job ou direto no painel do Asaas): o pedido fica pago com o estorno
 * solicitado e a marca de aceite (o painel mostra "aguardando o Asaas"). Nada é revogado até o dinheiro voltar.
 */
async function noteRefundInFlight(ctx: Ctx, o: { id: string; refundRequestedAt: Date | null }, pay: PaymentRow, items: RefundItem[]): Promise<void> {
  const now = new Date();
  const marker = refundMarkerOf(pay.raw, o.refundRequestedAt);
  if (marker?.acceptedAt) return;
  if (!o.refundRequestedAt) await ctx.tx.update(orders).set({ refundRequestedAt: now }).where(eq(orders.id, o.id));
  const settled = items.filter((r) => r.status === "CANCELLED" || r.status === "DONE").length;
  const next = marker ? { ...marker, acceptedAt: now.toISOString() } : { at: now.toISOString(), before: settled, acceptedAt: now.toISOString() };
  await ctx.tx.update(payment).set({ raw: mergeRaw({ refundPost: next }) }).where(eq(payment.id, pay.id));
}

/** Estorno parcial (soma dos DONE menor que o total): registra quanto voltou e avisa o vendedor a cada valor novo. */
async function notePartialRefund(ctx: Ctx, orderId: string, pay: PaymentRow, cents: number): Promise<void> {
  if ((pay.raw as { partialRefundCents?: unknown } | null)?.partialRefundCents === cents) return;
  await ctx.tx.update(payment).set({ raw: mergeRaw({ partialRefundCents: cents }) }).where(eq(payment.id, pay.id));
  await alertSeller(ctx.tx, ctx.storeId, "estorno_parcial", { orderId, refundedCents: cents });
  log.warn("estorno parcial no Asaas; o pedido continua pago", { orderId, refundedCents: cents });
}

/**
 * Evento de uma cobrança que a chave atual não consegue reconsultar (4xx permanente: em geral, cobrança da conta Asaas
 * anterior da loja). Se for uma linha `superseded`, registra o evento nela e avisa o vendedor uma vez (pode ter havido
 * pagamento na conta anterior); PAYMENT_DELETED (o cancelamento que nós mesmos pedimos) só é registrado.
 */
export const noteUnreachableAsaasPayment = defineAction({
  name: "payments.noteUnreachableAsaasPayment",
  description: "Registra evento do Asaas de uma cobrança que não pode ser reconsultada (ex.: conta Asaas anterior da loja).",
  input: z.object({
    paymentId: z.string().min(1).max(100),
    httpStatus: z.number().int(),
    event: z.string().max(64).nullable(),
  }),
  permission: "system",
  async run(ctx, p) {
    const [row] = await ctx.tx
      .select()
      .from(payment)
      .where(and(eq(payment.provider, "asaas"), eq(payment.providerId, p.paymentId)))
      .for("update");
    if (!row || row.status !== SUPERSEDED) return { recorded: false, notified: false };
    const raw = (row.raw as Record<string, unknown> | null) ?? {};
    const notify = p.event !== "PAYMENT_DELETED" && !raw.oldAccountNotifiedAt;
    const now = new Date().toISOString();
    const patch = { oldAccountEventAt: now, oldAccountEvent: p.event, ...(notify ? { oldAccountNotifiedAt: now } : {}) };
    await ctx.tx
      .update(payment)
      .set({ raw: sql`coalesce(${payment.raw}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(payment.id, row.id));
    if (notify) {
      await alertSeller(ctx.tx, ctx.storeId, "evento_conta_asaas_anterior", { orderId: row.orderId, paymentId: p.paymentId });
    }
    return { recorded: true, notified: notify };
  },
});

/** Status HTTP do erro do Asaas (0 = rede/timeout), ou null se não for erro do cliente Asaas. */
function asaasHttpStatus(e: unknown): number | null {
  if (!(e instanceof ActionError) || e.code !== "provider_error") return null;
  const status = (e.details as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : null;
}

/** 401/403: a chave da loja foi revogada, girada ou desativada. Transitório para nós: o vendedor corrige e o Asaas reenvia. */
const KEY_REJECTED = new Set([401, 403]);

/** Erro do Asaas que não se resolve reenviando (4xx, menos 401/403/429). Rede (0), 401/403, 429 e 5xx são transitórios. */
function permanentAsaasError(e: unknown): number | null {
  const status = asaasHttpStatus(e);
  return status !== null && status >= 400 && status < 500 && status !== 429 && !KEY_REJECTED.has(status) ? status : null;
}

/** No máximo um aviso de chave recusada por loja por hora (janela fixa na tabela rate_limit, atômica). */
export const KEY_ALERT_WINDOW_SEC = 3600;

/**
 * A chave do Asaas da loja foi recusada (401/403) na reconsulta do webhook: avisa o vendedor (`notify_seller`,
 * reason `chave_asaas_invalida`) no máximo uma vez por hora por loja. Os eventos não se perdem: o webhook responde 500
 * e o Asaas reenvia (ou pausa a fila) até a chave ser corrigida.
 */
export const alertAsaasKeyRejected = defineAction({
  name: "payments.alertAsaasKeyRejected",
  description: "Avisa o vendedor (no máximo 1 vez por hora) que a chave do Asaas da loja foi recusada pelo Asaas.",
  input: z.object({ httpStatus: z.number().int() }),
  permission: "system",
  async run(ctx, { httpStatus }) {
    // Contador na transação da ação: sem segunda conexão do pool (o webhook roda isto sob carga de reenvios).
    if (!(await checkRateLimit(`asaas:key_rejected:${ctx.storeId}`, 1, KEY_ALERT_WINDOW_SEC, new Date(), ctx.tx))) return { alerted: false };
    await alertSeller(ctx.tx, ctx.storeId, "chave_asaas_invalida", { httpStatus });
    log.warn("chave do Asaas recusada; vendedor avisado para reconectar", { storeId: ctx.storeId, httpStatus });
    return { alerted: true };
  },
});

export type AsaasPaymentInput = {
  paymentId: string;
  status: string;
  valueCents: number;
  externalReference: string | null;
  installment: string | null;
  refunds: RefundItem[];
  chargeCents: number;
};

/**
 * Entrada de `applyAsaasPayment` a partir de uma cobrança JÁ reconsultada no Asaas. Cartão parcelado: cada parcela é
 * uma cobrança; o pedido é liquidado pelo total do parcelamento (também reconsultado). Faz HTTP: fora de transação.
 */
export async function asaasPaymentInput(client: AsaasClient, fresh: AsaasPayment): Promise<AsaasPaymentInput> {
  let valueCents = reaisToCents(Number(fresh.value));
  let installment: string | null = null;
  if (typeof fresh.installment === "string" && fresh.installment) {
    installment = fresh.installment;
    valueCents = reaisToCents(Number((await client.getInstallment(installment)).value));
  }
  return {
    paymentId: fresh.id,
    status: String(fresh.status),
    valueCents,
    externalReference: typeof fresh.externalReference === "string" ? fresh.externalReference : null,
    installment,
    refunds: refundItems(fresh),
    chargeCents: reaisToCents(Number(fresh.value)),
  };
}

/**
 * Webhook do Asaas. Nunca confia no corpo: valida o token da loja, reconsulta `GET /payments/{id}` e aplica o estado real.
 * 401 sem revelar se a loja existe; 200 para eventos ignorados/repetidos e para 4xx permanente na reconsulta (sem loop
 * de reenvio; ver `noteUnreachableAsaasPayment`); 500 para falha de rede, 401/403 (chave recusada: avisa o vendedor),
 * 429 ou 5xx do Asaas (para o Asaas reenviar).
 */
export async function handleAsaasWebhook(storeId: string, headers: Headers, raw: unknown): Promise<{ status: number }> {
  if (!UUID.test(storeId)) return { status: 404 };
  const conn = await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"));
  const expected = (conn?.config as { webhookToken?: string } | undefined)?.webhookToken;
  const given = headers.get("asaas-access-token") ?? "";
  // Compara sempre (mesmo sem loja/conexão) para não vazar por tempo qual caso ocorreu.
  const ok = timingSafeEqualStr(given, expected ?? "\0no-token");
  if (!conn || !expected || !given || !ok) return { status: 401 };

  const parsed = body.safeParse(raw);
  if (!parsed.success) return { status: 200 };

  let applyInput: AsaasPaymentInput;
  try {
    const client = await withStore(storeId, (tx) => asaasClientFor(tx, storeId));
    const fresh = await client.getPayment(parsed.data.payment.id);
    if (fresh.id !== parsed.data.payment.id) return { status: 200 };
    applyInput = await asaasPaymentInput(client, fresh);
  } catch (e) {
    const http = asaasHttpStatus(e);
    if (http !== null && KEY_REJECTED.has(http)) {
      // Chave revogada/girada/desativada: NUNCA descartar o evento (o comprador pode ter pago). 500 -> o Asaas reenvia.
      log.warn("webhook Asaas: chave recusada na reconsulta; evento será reenviado pelo Asaas", { storeId, httpStatus: http });
      await runAction(alertAsaasKeyRejected, { storeId, actor: { kind: "system" }, origin: "webhook" }, { httpStatus: http }).catch((err: unknown) =>
        log.error("webhook Asaas: falha ao avisar chave recusada", { storeId, error: err }),
      );
      return { status: 500 };
    }
    const permanent = permanentAsaasError(e);
    if (permanent === null) {
      log.warn("webhook Asaas: falha ao reconsultar cobrança", { storeId, error: e });
      return { status: 500 };
    }
    log.warn("webhook Asaas: cobrança não pode ser reconsultada com a chave atual (erro permanente); evento ignorado", {
      storeId,
      paymentId: parsed.data.payment.id,
      httpStatus: permanent,
    });
    try {
      await runAction(noteUnreachableAsaasPayment, { storeId, actor: { kind: "system" }, origin: "webhook" }, {
        paymentId: parsed.data.payment.id,
        httpStatus: permanent,
        event: parsed.data.event?.slice(0, 64) ?? null,
      });
    } catch (err) {
      log.error("webhook Asaas: falha ao registrar evento sem reconsulta", { storeId, error: err });
      return { status: 500 };
    }
    return { status: 200 };
  }

  try {
    await runAction(applyAsaasPayment, { storeId, actor: { kind: "system" }, origin: "webhook" }, applyInput);
  } catch (e) {
    log.error("webhook Asaas: falha ao aplicar estado", { storeId, error: e });
    return { status: 500 };
  }
  return { status: 200 };
}
