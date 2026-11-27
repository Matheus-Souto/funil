import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction, type Ctx } from "@/lib/actions/core";
import { alertSeller } from "@/lib/alerts";
import { enqueueAppNotice } from "@/lib/apps/events";
import { timingSafeEqualStr } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { orders, payment } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { checkRateLimit } from "@/lib/payments/ratelimit";
import { transitionOrder, type OrderStatus } from "@/lib/orders/state";
import { asaasClientFor, reaisToCents, type AsaasClient, type AsaasPayment } from "./client";
import {
  classifyInstallmentRefund,
  classifyRefund,
  installmentParcels,
  installmentRefundedCents,
  refundItems,
  refundMarkerOf,
  refundedCents,
  type InstallmentParcel,
  type RefundItem,
} from "./refunds";

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
    /**
     * Parcelado: todas as parcelas do parcelamento, reconsultadas. O estorno da venda é decidido pelo conjunto (uma
     * parcela estornada sozinha é estorno parcial). Ausente num parcelado: estorno nunca conclui por esta cobrança.
     */
    parcels: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          status: z.string().max(64),
          refunds: z.array(z.object({ status: z.string().max(64), cents: z.number().int().min(0) })).max(50),
          cents: z.number().int().min(0),
        }),
      )
      .max(24)
      .optional(),
    /** Parcelado com estorno à vista, mas a listagem das parcelas falhou de vez (4xx) ou veio incompleta. */
    parcelsUnavailable: z.boolean().optional(),
    /** Valor desta cobrança (centavos); numa parcela, o valor da parcela. */
    chargeCents: z.number().int().min(0).optional(),
  }),
  permission: "system",
  auditInput: (i) => ({
    paymentId: i.paymentId,
    status: i.status,
    valueCents: i.valueCents,
    installment: i.installment ?? null,
    refunds: i.refunds ?? [],
    parcels: i.parcels?.map((x) => ({ id: x.id, status: x.status, cents: x.cents, refunds: x.refunds })) ?? null,
    parcelsUnavailable: i.parcelsUnavailable ?? false,
    chargeCents: i.chargeCents ?? null,
  }),
  // Duas lojas na mesma conta Asaas recebem cada evento nos dois webhooks: na loja que não tem o pedido (ou sem pedido
  // nosso), nada muda e a auditoria não guarda dados da cobrança alheia (id, valor, status, estornos, parcelas).
  auditSuccess: (out: { applied: boolean; reason?: string }) => out.reason !== "sem_pedido" && out.reason !== "pedido_de_outra_loja",
  async run(ctx, input) {
    let p = input;
    // Fora da auditoria (ver `auditSuccess`), mas com rastro para o operador: só a loja e o motivo, nada da cobrança.
    if (!p.externalReference || !UUID.test(p.externalReference)) {
      log.info("evento do Asaas ignorado", { storeId: ctx.storeId, reason: "sem_pedido" });
      return { applied: false, reason: "sem_pedido" };
    }
    const [o] = await ctx.tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, p.externalReference), eq(orders.storeId, ctx.storeId)))
      .for("update");
    if (!o) {
      log.info("evento do Asaas ignorado", { storeId: ctx.storeId, reason: "pedido_de_outra_loja" });
      return { applied: false, reason: "pedido_de_outra_loja" };
    }
    if (o.method !== "pix_asaas" && o.method !== "card_asaas") return { applied: false, reason: "metodo_nao_asaas" };

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
    const known = row ?? sibling;
    const marker = refundMarkerOf(known?.raw, o.refundRequestedAt);
    // Parcelado: o estorno é da venda inteira só quando TODAS as parcelas voltaram (a marca do pedido de estorno fica
    // na linha da parcela que o pedido conhece). Sem a lista de parcelas, nunca conclui por uma parcela só.
    const parcels: InstallmentParcel[] | null = installment !== null ? (p.parcels ?? []) : null;
    // Estorno: a cobrança pode seguir CONFIRMED/RECEIVED com refunds[DONE] cobrindo o total -> trata como REFUNDED.
    const refund = parcels
      ? classifyInstallmentRefund(parcels, (id) => (id === known?.providerId ? marker : null))
      : classifyRefund(p.status, p.refunds ?? [], marker, o.totalCents);
    if (refund === "done" && mapAsaasStatus(p.status) === "paid") p = { ...p, status: "REFUNDED" };
    // Parcela estornada (REFUNDED) sem o parcelamento inteiro: a linha acompanha o status, o pedido continua pago.
    const parcelOnly = parcels !== null && refund !== "done" && mapAsaasStatus(p.status) === "refunded";
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

    // Parcelado: os itens e o valor devolvido são os da parcela que o pedido conhece / do parcelamento inteiro.
    const knownItems = parcels ? (parcels.find((x) => x.id === known?.providerId)?.refunds ?? []) : (p.refunds ?? []);
    const back = parcels ? installmentRefundedCents(parcels) : refundedCents(p.refunds ?? []);
    if (installment !== null && p.parcelsUnavailable) {
      // Estorno numa parcela, sem como conferir o parcelamento: não decide o estorno e avisa o vendedor uma vez por
      // valor; "Reembolsar" no painel conclui pelo job, que re-tenta com espera crescente. Pagamento e chargeback da
      // parcela seguem o fluxo normal (só a decisão de estorno depende das parcelas).
      const own = mapAsaasStatus(p.status) === "refunded" ? (p.chargeCents ?? 0) : refundedCents(p.refunds ?? []);
      if (o.status === "paid" && known && own > 0) await notePartialRefund(ctx, o.id, known, own);
      const t = mapAsaasStatus(p.status);
      if (t !== "paid" && t !== "disputed") return { applied: false, reason: "parcelas_indisponiveis" };
    }
    if (o.status === "paid" && known && refund === "requested") await noteRefundInFlight(ctx, o, known, knownItems);
    if (o.status === "paid" && known && refund === "partial") await notePartialRefund(ctx, o.id, known, back);
    if (parcelOnly) return { applied: false, reason: refund === "requested" ? "estorno_parcelado_em_andamento" : "estorno_parcial_parcelado" };

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
  // Pedido de app: o app também fica sabendo (`valor_estornado_centavos` = a soma devolvida até agora) e decide o que
  // fazer. Um evento por valor novo, na mesma transação da marca acima (o mesmo valor não avisa de novo).
  const [o] = await ctx.tx.select({ appAccount: orders.appAccount }).from(orders).where(eq(orders.id, orderId));
  if (o && o.appAccount !== null) await enqueueAppNotice(ctx.tx, ctx.storeId, orderId, "pagamento.reembolso_parcial");
  log.warn("estorno parcial no Asaas; o pedido continua pago", { orderId, refundedCents: cents });
}

/**
 * Evento de uma cobrança que a chave atual não consegue reconsultar (4xx permanente: em geral, cobrança da conta Asaas
 * anterior da loja). Se for uma linha `superseded`, registra o evento nela e avisa o vendedor uma vez (pode ter havido
 * pagamento na conta anterior). PAYMENT_DELETED (o cancelamento que nós mesmos pedimos na troca de conta) não é
 * movimento de dinheiro: fica só em `oldAccountDeletedAt`, sem aviso, sem selo no painel e sem abrir a liberação manual,
 * e nunca apaga um evento real registrado antes.
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
  // Cobrança que não é de uma conta anterior desta loja (ex.: de outra loja na mesma conta Asaas): nada a registrar.
  auditSuccess: (out: { recorded: boolean }) => out.recorded,
  async run(ctx, p) {
    const [row] = await ctx.tx
      .select()
      .from(payment)
      .where(and(eq(payment.provider, "asaas"), eq(payment.providerId, p.paymentId)))
      .for("update");
    if (!row || row.status !== SUPERSEDED) return { recorded: false, notified: false };
    const raw = (row.raw as Record<string, unknown> | null) ?? {};
    const deleted = p.event === OUR_CLEANUP_EVENT;
    const notify = !deleted && !raw.oldAccountNotifiedAt;
    const now = new Date().toISOString();
    const patch = deleted
      ? { oldAccountDeletedAt: now }
      : { oldAccountEventAt: now, oldAccountEvent: p.event, ...(notify ? { oldAccountNotifiedAt: now } : {}) };
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

/** Status do Asaas de cobrança com estorno pedido, em andamento ou concluído. */
const REFUND_STATUSES = new Set(["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS"]);

/** Código do erro de listagem de parcelas vazia/incompleta (status 0: transitório para o job, que re-tenta). */
const PARCELS_INCOMPLETE = "parcelas_incompletas";

/**
 * Todas as parcelas de um parcelamento (HTTP: fora de transação). A listagem precisa trazer exatamente
 * `installmentCount` parcelas (sem `count` válido, busca o parcelamento): vazia ou incompleta lança erro transitório
 * (decidir estorno com parte das parcelas poderia concluir cedo demais ou nunca).
 */
export async function fetchInstallmentParcels(client: AsaasClient, installment: string, count?: number): Promise<InstallmentParcel[]> {
  const expected = count !== undefined && Number.isInteger(count) && count > 0 ? count : Number((await client.getInstallment(installment)).installmentCount);
  const parcels = installmentParcels(await client.listInstallmentPayments(installment), installment);
  if (!Number.isInteger(expected) || expected < 1 || parcels.length !== expected) {
    log.warn("Asaas: listagem de parcelas incompleta; estorno não decidido agora", { installment, expected, got: parcels.length });
    throw new ActionError("provider_error", "Parcelas do parcelamento incompletas no Asaas", { status: 0, errorCodes: [PARCELS_INCOMPLETE] });
  }
  return parcels;
}

/** A listagem de parcelas não vai se resolver reenviando o webhook (4xx permanente ou listagem incompleta)? */
function parcelsUnavailableError(e: unknown): boolean {
  if (permanentAsaasError(e) !== null) return true;
  if (!(e instanceof ActionError) || e.code !== "provider_error") return false;
  const d = e.details as { status?: unknown; errorCodes?: unknown } | undefined;
  // 200 com corpo inválido (listagem sem `data`): reenviar não resolve.
  if (d?.status === 200) return true;
  return Array.isArray(d?.errorCodes) && d.errorCodes.includes(PARCELS_INCOMPLETE);
}

/** Evento que a limpeza da troca de conta gera (DELETE da cobrança aberta): nunca indica pagamento. */
export const OUR_CLEANUP_EVENT = "PAYMENT_DELETED";

/**
 * A linha `superseded` recebeu evento real da conta Asaas anterior (o comprador pode ter pago lá)? Linhas antigas
 * gravadas com PAYMENT_DELETED em `oldAccountEvent` (antes desta regra) não contam.
 */
export function hasOldAccountEvent(raw: unknown): boolean {
  const r = raw as { oldAccountEventAt?: unknown; oldAccountEvent?: unknown; oldAccountNotifiedAt?: unknown } | null;
  // `oldAccountNotifiedAt` só é gravado por evento real (inclusive nas linhas antigas em que um DELETED posterior
  // sobrescreveu `oldAccountEvent`).
  if (typeof r?.oldAccountNotifiedAt === "string") return true;
  return typeof r?.oldAccountEventAt === "string" && r.oldAccountEvent !== OUR_CLEANUP_EVENT;
}

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
  parcels?: InstallmentParcel[];
  parcelsUnavailable?: boolean;
  chargeCents: number;
};

/**
 * Entrada de `applyAsaasPayment` a partir de uma cobrança JÁ reconsultada no Asaas. Cartão parcelado: cada parcela é
 * uma cobrança; o pedido é liquidado pelo total do parcelamento (também reconsultado). Faz HTTP: fora de transação.
 */
export async function asaasPaymentInput(client: AsaasClient, fresh: AsaasPayment): Promise<AsaasPaymentInput> {
  let valueCents = reaisToCents(Number(fresh.value));
  let installment: string | null = null;
  let parcels: InstallmentParcel[] | undefined;
  let parcelsUnavailable = false;
  if (typeof fresh.installment === "string" && fresh.installment) {
    installment = fresh.installment;
    const inst = await client.getInstallment(installment);
    valueCents = reaisToCents(Number(inst.value));
    // Todas as parcelas, só quando a parcela mostra estorno: a confirmação de pagamento nunca depende desta listagem.
    // Rede, 429, 5xx e chave recusada: o erro sobe (webhook 500, o Asaas reenvia). 4xx permanente ou listagem
    // incompleta não se resolvem reenviando: segue sem decidir o estorno (`parcelsUnavailable`), sem loop de 500 que
    // pausaria a fila de webhooks da loja.
    if (REFUND_STATUSES.has(String(fresh.status)) || refundItems(fresh).length > 0) {
      try {
        parcels = await fetchInstallmentParcels(client, installment, Number(inst.installmentCount));
      } catch (e) {
        if (!parcelsUnavailableError(e)) throw e;
        parcelsUnavailable = true;
      }
    }
  }
  return {
    paymentId: fresh.id,
    status: String(fresh.status),
    valueCents,
    externalReference: typeof fresh.externalReference === "string" ? fresh.externalReference : null,
    installment,
    refunds: refundItems(fresh),
    ...(parcels ? { parcels } : {}),
    ...(parcelsUnavailable ? { parcelsUnavailable } : {}),
    chargeCents: Math.max(0, reaisToCents(Number(fresh.value) || 0)),
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
