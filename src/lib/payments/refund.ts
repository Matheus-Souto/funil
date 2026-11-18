// Reembolso. Pix manual: só marca (a devolução é pelo banco do vendedor). Asaas: ASSÍNCRONO — a ação valida, grava
// `refund_requested_at` e enfileira `refund_order`; o job fala com o Asaas FORA de transação e só depois, numa
// transação curta, muda o pedido para `refunded`. Nenhuma chamada HTTP segura trava de pedido nem conexão do pool.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { orders, payment } from "@/lib/db/schema";
import { enqueue, hasOpenJob, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import { asaasClientFor } from "./asaas/client";
import { classifyRefund, refundMarkerOf, refundStatuses, type RefundMarker } from "./asaas/refunds";
import { mapAsaasStatus } from "./asaas/webhook";

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
    "Reembolsa um pedido pago (Asaas: solicita o estorno, feito em segundo plano; Pix manual: só marca, a devolução é pelo banco).",
  input: z.object({ orderId: z.uuid() }),
  permission: "orders.refund",
  sensitive: true,
  async run(ctx, { orderId }) {
    const [o] = await ctx.tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
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
    if (!refundable(rows, false)) throw new ActionError("conflict", "Pedido sem cobrança paga no Asaas para estornar");
    const message = "Estorno solicitado. O pedido muda para reembolsado assim que o Asaas confirmar.";
    // Já há um job na fila/rodando para este pedido: não enfileira outro (o job é idempotente, mas evita ruído).
    if (await hasOpenJob(ctx.tx, "refund_order", o.id)) return { orderId: o.id, status: "refund_requested" as const, message };
    await ctx.tx.update(orders).set({ refundRequestedAt: new Date() }).where(eq(orders.id, o.id));
    await enqueue(ctx.tx, { storeId: ctx.storeId, type: "refund_order", payload: { orderId: o.id } });
    return { orderId: o.id, status: "refund_requested" as const, message };
  },
});

/**
 * Job `refund_order` {orderId}. At-least-once e idempotente:
 *  1. leitura curta: pedido ainda `paid` e com estorno pedido? (o webhook REFUNDED pode ter chegado antes, ou o estorno
 *     foi cancelado -> nada a fazer) e qual cobrança;
 *  2. fora de transação: reconsulta a cobrança no Asaas e classifica o estorno (`refunds[]` + status):
 *     em andamento -> não pede de novo; nenhum -> grava a marca `raw.refundPost` (transação curta) e pede o estorno
 *     (parcelado: o parcelamento inteiro); o estorno pedido agora terminou CANCELLED -> limpa o pedido e avisa;
 *  3. só com o estorno concluído (REFUNDED ou refunds[DONE]): transação curta, trava o pedido e, se ainda `paid`,
 *     muda para `refunded`. Estorno ainda pendente: o job termina e o webhook do Asaas conclui depois.
 * Falha do Asaas lança e o worker re-tenta pelo backoff. Queda entre o pedido do estorno e a gravação: a próxima
 * execução vê o estorno em `refunds[]` e não pede outro.
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
      .select({ id: orders.id, status: orders.status, refundRequestedAt: orders.refundRequestedAt })
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
    return { pay, providerId: pay.providerId, requestedAt: o.refundRequestedAt, client: await asaasClientFor(tx, storeId) } as const;
  });
  if ("skip" in pre) {
    log.info("refund_order: nada a estornar", { orderId, reason: pre.skip });
    return;
  }
  const { client, providerId, pay } = pre;

  // 2. HTTP fora de transação.
  const fresh = await client.getPayment(providerId);
  const status = String(fresh.status);
  let state = classifyRefund(status, refundStatuses(fresh), refundMarkerOf(pay.raw, pre.requestedAt));
  if (state === "none") {
    if (mapAsaasStatus(status) !== "paid") {
      // Ex.: chargeback em andamento. Não estorna; o webhook leva o pedido ao estado certo.
      log.warn("refund_order: cobrança não está paga no Asaas; estorno não enviado", { orderId, paymentId: providerId, status });
      return;
    }
    // Marca antes do POST: numa retentativa, os itens de refunds[] depois de `before` são deste pedido de estorno.
    const marker: RefundMarker = { at: new Date().toISOString(), before: refundStatuses(fresh).length };
    await withStore(storeId, (tx) =>
      tx
        .update(payment)
        .set({ raw: sql`coalesce(${payment.raw}, '{}'::jsonb) || ${JSON.stringify({ refundPost: marker })}::jsonb` })
        .where(eq(payment.id, pay.id)),
    );
    const installment = (pay.raw as { installment?: string } | null)?.installment;
    if (installment) await client.refundInstallment(installment);
    else await client.refundPayment(providerId);
    const after = await client.getPayment(providerId);
    state = classifyRefund(String(after.status), refundStatuses(after), marker);
  }

  if (state === "cancelled") {
    await withStore(storeId, (tx) =>
      tx
        .update(orders)
        .set({ refundRequestedAt: null })
        .where(and(eq(orders.id, orderId), eq(orders.status, "paid"))),
    );
    log.warn("estorno cancelado no Asaas; o pedido continua pago (confira no Asaas e peça de novo se for o caso)", { orderId, paymentId: providerId });
    return;
  }
  if (state !== "done") {
    log.info("refund_order: estorno pedido ao Asaas; aguardando a conclusão (webhook)", { orderId, paymentId: providerId });
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
