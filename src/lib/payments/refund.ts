// Reembolso. Pix manual: só marca (a devolução é pelo banco do vendedor). Asaas: ASSÍNCRONO — a ação valida, grava
// `refund_requested_at` e enfileira `refund_order`; o job fala com o Asaas FORA de transação e só depois, numa
// transação curta, muda o pedido para `refunded`. Nenhuma chamada HTTP segura trava de pedido nem conexão do pool.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { alertSeller } from "@/lib/alerts";
import { withStore } from "@/lib/db/client";
import { orders, payment } from "@/lib/db/schema";
import { enqueue, hasOpenJob, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import { asaasClientFor, type AsaasPayment } from "./asaas/client";
import {
  classifyInstallmentRefund,
  classifyRefund,
  refundItems,
  refundMarkerOf,
  refundedCents,
  type RefundMarker,
  type RefundState,
} from "./asaas/refunds";
import { fetchInstallmentParcels, mapAsaasStatus } from "./asaas/webhook";

type PaymentRow = typeof payment.$inferSelect;

/** Status do Asaas em que o estorno já foi pedido/feito: não estornar de novo. */
const ALREADY_REFUNDED = new Set(["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS"]);

/**
 * A cobrança a estornar: paga e não duplicada (OVERDUE, apagada ou em dobro nunca são estornadas aqui).
 * Pela regra do webhook há no máximo uma assim: a segunda cobrança paga é marcada como duplicada.
 * Depois do estorno a linha fica REFUNDED; a releitura do job ainda a encontra.
 */
function refundable(rows: PaymentRow[], includeRefunded: boolean): PaymentRow | undefined {
  return rows.find((r) => {
    if (!r.providerId || (r.raw as { duplicate?: boolean } | null)?.duplicate === true) return false;
    return mapAsaasStatus(r.status) === "paid" || (includeRefunded && ALREADY_REFUNDED.has(r.status));
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const refundOrder = defineAction({
  name: "orders.refund",
  description:
    "Reembolsa um pedido pago, sempre o valor total (Asaas: solicita o estorno, feito em segundo plano; Pix manual: só marca, a devolução é pelo banco).",
  input: z.object({
    orderId: z.uuid(),
    // Só o total é reembolsado por aqui. O campo existe para um pedido de valor parcial ser RECUSADO, em vez de o valor
    // ser ignorado e o pedido inteiro, estornado.
    amountCents: z.number().int().positive().optional().describe("Opcional. Se informado, precisa ser o total do pedido: reembolso parcial não é feito por aqui."),
  }),
  permission: "orders.refund",
  sensitive: true,
  async run(ctx, { orderId, amountCents }) {
    const [o] = await ctx.tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    if (amountCents !== undefined && amountCents !== o.totalCents) {
      // Pedido de app: o app libera plano ou créditos pelo pedido inteiro, então o painel só o desfaz inteiro (um parcial
      // feito direto no Asaas vira `pagamento.reembolso_parcial`, e o app decide).
      throw new ActionError(
        "invalid_input",
        o.appAccount !== null
          ? "Pedido de app só aceita reembolso total."
          : "O painel só faz reembolso total. Para devolver parte do valor, use o painel do Asaas.",
      );
    }
    if (o.status !== "paid") throw new ActionError("conflict", `Só pedidos pagos podem ser reembolsados (${o.status})`);

    if (o.method === "pix_manual") {
      await transitionOrder(ctx, o.id, "refunded", "reembolso manual");
      await ctx.tx.update(payment).set({ status: "refunded" }).where(eq(payment.orderId, o.id));
      return {
        orderId: o.id,
        status: "refunded" as const,
        message: "Pedido marcado como reembolsado. Devolva o valor ao comprador pelo seu banco (o Pix manual não passa por aqui).",
      };
    }

    const rows = await ctx.tx
      .select()
      .from(payment)
      .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas")));
    if (!refundable(rows, false)) {
      // Pedido pago cuja parcela conhecida já foi estornada no painel do Asaas: o parcelamento está parcialmente estornado.
      const parcel = rows.find((r) => (r.raw as { installment?: string } | null)?.installment && ALREADY_REFUNDED.has(r.status));
      if (parcel?.status === "REFUNDED") {
        throw new ActionError("conflict", "Parte das parcelas já foi estornada no Asaas. Conclua o estorno das demais parcelas no painel do Asaas.");
      }
      if (parcel) throw new ActionError("conflict", "O estorno deste pedido já está em andamento no Asaas. Acompanhe por lá.");
      throw new ActionError("conflict", "Pedido sem cobrança paga no Asaas para estornar");
    }
    const message = "Estorno solicitado. O pedido muda para reembolsado assim que o Asaas confirmar.";
    // Já há um job na fila/rodando para este pedido: não enfileira outro (o job é idempotente, mas evita ruído).
    if (await hasOpenJob(ctx.tx, "refund_order", o.id)) return { orderId: o.id, status: "refund_requested" as const, message };
    await ctx.tx.update(orders).set({ refundRequestedAt: new Date() }).where(eq(orders.id, o.id));
    await enqueue(ctx.tx, { storeId: ctx.storeId, type: "refund_order", payload: { orderId: o.id } });
    return { orderId: o.id, status: "refund_requested" as const, message };
  },
});

/** Erro do Asaas que não se resolve re-tentando: 4xx, menos 429. Devolve status e códigos; senão `null` (transitório). */
function permanentAsaasRefusal(e: unknown): { httpStatus: number; code: string } | null {
  if (!(e instanceof ActionError) || e.code !== "provider_error") return null;
  const d = e.details as { status?: unknown; errorCodes?: unknown } | undefined;
  const status = typeof d?.status === "number" ? d.status : 0;
  if (status < 400 || status >= 500 || status === 429) return null;
  const codes = Array.isArray(d?.errorCodes) ? d.errorCodes.filter((c): c is string => typeof c === "string") : [];
  return { httpStatus: status, code: codes[0] ?? `http_${status}` };
}

/** Grava em `payment.raw` (merge jsonb), numa transação curta. */
const patchRaw = (storeId: string, paymentId: string, patch: Record<string, unknown>) =>
  withStore(storeId, (tx) =>
    tx
      .update(payment)
      .set({ raw: sql`coalesce(${payment.raw}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(payment.id, paymentId)),
  );

/**
 * O Asaas recusou o estorno de vez (4xx): o pedido continua pago, o pedido de estorno é desfeito (o vendedor pode pedir
 * de novo) e o vendedor é avisado com o código. Só quem limpou avisa (retentativa ou corrida não duplicam o aviso).
 */
async function refundRefused(storeId: string, orderId: string, paymentRowId: string, why: { httpStatus?: number; code: string }): Promise<void> {
  await withStore(storeId, async (tx) => {
    await tx
      .update(payment)
      .set({ raw: sql`coalesce(${payment.raw}, '{}'::jsonb) || ${JSON.stringify({ refundError: { at: new Date().toISOString(), ...why } })}::jsonb` })
      .where(eq(payment.id, paymentRowId));
    const cleared = await tx
      .update(orders)
      .set({ refundRequestedAt: null })
      .where(and(eq(orders.id, orderId), eq(orders.status, "paid"), isNotNull(orders.refundRequestedAt)))
      .returning({ id: orders.id });
    if (cleared.length > 0) await alertSeller(tx, storeId, "estorno_falhou", { orderId, ...why });
  });
  log.warn("estorno recusado pelo Asaas; o pedido continua pago e o vendedor foi avisado", { orderId, ...why });
}

/**
 * Job `refund_order` {orderId}. At-least-once e idempotente:
 *  1. leitura curta: pedido ainda `paid` e com estorno pedido? (o webhook REFUNDED pode ter chegado antes, ou o estorno
 *     foi cancelado -> nada a fazer) e qual cobrança;
 *  2. fora de transação: reconsulta a cobrança no Asaas e classifica o estorno (`refunds[]` + status + valores):
 *     em andamento -> não pede de novo; nenhum -> grava a marca `raw.refundPost` (transação curta) e pede o estorno
 *     (parcelado: o parcelamento inteiro); parcial (feito no painel do Asaas) -> pede só o restante (cobrança à vista;
 *     parcelado: avisa o vendedor); o estorno pedido agora terminou CANCELLED -> limpa o pedido e avisa;
 *  3. só com o estorno concluído (REFUNDED ou soma dos refunds[DONE] >= total): transação curta, trava o pedido e, se
 *     ainda `paid`, muda para `refunded`. Estorno ainda pendente: o job termina e o webhook do Asaas conclui depois.
 * A marca ganha `acceptedAt` só depois da resposta 2xx do POST (ou quando a reconsulta já mostra o estorno em
 * andamento): só assim o painel diz "aguardando o Asaas". Recusa definitiva do Asaas (4xx, menos 429), na reconsulta
 * ou no POST: não re-tenta; limpa o pedido de estorno e avisa o vendedor (`estorno_falhou`, com o código). Rede, 429
 * e 5xx lançam e o worker re-tenta pelo backoff. Queda entre o pedido do estorno e a gravação: a próxima execução vê o
 * estorno em `refunds[]` e não pede outro.
 */
export const refundOrderJob: JobHandler = async (j) => {
  const storeId = j.storeId;
  const orderId = (j.payload as { orderId?: unknown } | null)?.orderId;
  if (!storeId || typeof orderId !== "string" || !UUID.test(orderId)) {
    log.error("refund_order: payload inválido; job descartado", { id: j.id });
    return;
  }

  // 1.
  const pre = await withStore(storeId, async (tx) => {
    const [o] = await tx
      .select({ id: orders.id, status: orders.status, refundRequestedAt: orders.refundRequestedAt, totalCents: orders.totalCents })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!o || o.status !== "paid") return { skip: o?.status ?? "inexistente" } as const;
    if (!o.refundRequestedAt) return { skip: "estorno_nao_pedido_ou_cancelado" } as const;
    const rows = await tx
      .select()
      .from(payment)
      .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas")));
    const pay = refundable(rows, true);
    if (!pay?.providerId) return { skip: "sem_cobranca" } as const;
    return {
      pay,
      providerId: pay.providerId,
      requestedAt: o.refundRequestedAt,
      totalCents: o.totalCents,
      client: await asaasClientFor(tx, storeId),
    } as const;
  });
  if ("skip" in pre) {
    log.info("refund_order: nada a estornar", { orderId, reason: pre.skip });
    return;
  }
  const { client, providerId, pay } = pre;
  const installment = (pay.raw as { installment?: string } | null)?.installment;
  // Estado do estorno. Cartão parcelado: decidido por TODAS as parcelas (uma parcela estornada sozinha no painel do
  // Asaas é estorno parcial, nunca a venda estornada); a marca vale para a parcela desta linha. HTTP: fora de transação.
  const stateOf = async (p: AsaasPayment, m: RefundMarker | null): Promise<RefundState> => {
    if (!installment) return classifyRefund(String(p.status), refundItems(p), m, pre.totalCents);
    const parcels = await fetchInstallmentParcels(client, installment);
    return classifyInstallmentRefund(parcels, (id) => (id === providerId ? m : null));
  };

  // 2. HTTP fora de transação.
  let fresh: AsaasPayment;
  try {
    fresh = await client.getPayment(providerId);
  } catch (e) {
    const refused = permanentAsaasRefusal(e);
    if (!refused) throw e;
    await refundRefused(storeId, orderId, pay.id, refused);
    return;
  }
  let marker = refundMarkerOf(pay.raw, pre.requestedAt);
  let state: RefundState;
  try {
    state = await stateOf(fresh, marker);
  } catch (e) {
    const refused = permanentAsaasRefusal(e);
    if (!refused) throw e;
    await refundRefused(storeId, orderId, pay.id, refused);
    return;
  }
  if (state === "requested" && marker && !marker.acceptedAt) {
    // O POST anterior foi aceito (a resposta se perdeu): agora há prova de que o Asaas está estornando.
    marker = { ...marker, acceptedAt: new Date().toISOString() };
    await patchRaw(storeId, pay.id, { refundPost: marker });
  }
  if (state === "partial" && installment) {
    // Parcial num parcelamento (ex.: uma parcela estornada no painel do Asaas): o restante por parcela não é
    // calculável com segurança; o vendedor resolve no Asaas. Antes da checagem de "paga": a parcela desta linha pode
    // ser justamente a estornada.
    await refundRefused(storeId, orderId, pay.id, { code: "parcial_parcelado" });
    return;
  }
  if (state === "none" || state === "partial") {
    if (mapAsaasStatus(String(fresh.status)) !== "paid") {
      // Ex.: chargeback em andamento. Não estorna; o webhook leva o pedido ao estado certo.
      log.warn("refund_order: cobrança não está paga no Asaas; estorno não enviado", { orderId, paymentId: providerId, status: fresh.status });
      return;
    }
    const remaining = state === "partial" ? pre.totalCents - refundedCents(refundItems(fresh)) : undefined;
    // Marca antes do POST: numa retentativa, os itens de refunds[] depois de `before` são deste pedido de estorno.
    const posted: RefundMarker = {
      at: new Date().toISOString(),
      before: refundItems(fresh).length,
      ...(installment ? { scope: "installment" as const } : {}),
    };
    await patchRaw(storeId, pay.id, { refundPost: posted });
    try {
      if (installment) await client.refundInstallment(installment);
      else await client.refundPayment(providerId, remaining);
    } catch (e) {
      const refused = permanentAsaasRefusal(e);
      if (!refused) throw e;
      await refundRefused(storeId, orderId, pay.id, refused);
      return;
    }
    marker = { ...posted, acceptedAt: new Date().toISOString() };
    await patchRaw(storeId, pay.id, { refundPost: marker });
    state = await stateOf(await client.getPayment(providerId), marker);
  }

  if (state === "cancelled") {
    await withStore(storeId, async (tx) => {
      const cleared = await tx
        .update(orders)
        .set({ refundRequestedAt: null })
        .where(and(eq(orders.id, orderId), eq(orders.status, "paid"), isNotNull(orders.refundRequestedAt)))
        .returning({ id: orders.id });
      // Só quem limpou avisa (a retentativa do job ou o webhook que chegar depois não duplicam o aviso).
      if (cleared.length > 0) await alertSeller(tx, storeId, "estorno_cancelado", { orderId });
    });
    log.warn("estorno cancelado no Asaas; o pedido continua pago (confira no Asaas e peça de novo se for o caso)", { orderId, paymentId: providerId });
    return;
  }
  if (state !== "done") {
    log.info("refund_order: estorno pedido ao Asaas; aguardando a conclusão (webhook)", { orderId, paymentId: providerId, state });
    return;
  }

  // 3.
  await withStore(storeId, async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update");
    if (o?.status !== "paid") return;
    await transitionOrder({ storeId, actor: { kind: "system" }, origin: "system", tx }, orderId, "refunded", "reembolso Asaas");
    await tx.update(payment).set({ status: "REFUNDED" }).where(eq(payment.id, pay.id));
  });
};
