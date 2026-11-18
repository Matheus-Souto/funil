// Reembolso. Pix manual: só marca (a devolução é pelo banco do vendedor). Asaas: ASSÍNCRONO — a ação valida, grava
// `refund_requested_at` e enfileira `refund_order`; o job fala com o Asaas FORA de transação e só depois, numa
// transação curta, muda o pedido para `refunded`. Nenhuma chamada HTTP segura trava de pedido nem conexão do pool.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { orders, payment } from "@/lib/db/schema";
import { enqueue, hasOpenJob, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import { asaasClientFor } from "./asaas/client";
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
 *  1. leitura curta: pedido ainda `paid`? (o webhook REFUNDED pode ter chegado antes -> nada a fazer) e qual cobrança;
 *  2. fora de transação: reconsulta a cobrança no Asaas; só chama o estorno se ela ainda não foi estornada
 *     (parcelado: estorna o parcelamento inteiro, estornar só a cobrança devolveria uma parcela);
 *  3. transação curta: trava o pedido e, se ainda `paid`, muda para `refunded`.
 * Falha do Asaas lança e o worker re-tenta pelo backoff; se o processo cair entre 2 e 3, a próxima execução vê a
 * cobrança já estornada e só conclui.
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
    const [o] = await tx.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, orderId));
    if (!o || o.status !== "paid") return { skip: o?.status ?? "inexistente" } as const;
    const rows = await tx
      .select()
      .from(payment)
      .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas")));
    const pay = refundable(rows, true);
    if (!pay?.providerId) return { skip: "sem_cobranca" } as const;
    return { pay, providerId: pay.providerId, client: await asaasClientFor(tx, storeId) } as const;
  });
  if ("skip" in pre) {
    log.info("refund_order: nada a estornar", { orderId, reason: pre.skip });
    return;
  }

  // 2. HTTP fora de transação.
  const fresh = await pre.client.getPayment(pre.providerId);
  const status = String(fresh.status);
  if (!ALREADY_REFUNDED.has(status)) {
    if (mapAsaasStatus(status) !== "paid") {
      // Ex.: chargeback em andamento. Não estorna; o webhook leva o pedido ao estado certo.
      log.warn("refund_order: cobrança não está paga no Asaas; estorno não enviado", { orderId, paymentId: pre.providerId, status });
      return;
    }
    const installment = (pre.pay.raw as { installment?: string } | null)?.installment;
    if (installment) await pre.client.refundInstallment(installment);
    else await pre.client.refundPayment(pre.providerId);
  }

  // 3.
  await withStore(storeId, async (tx) => {
    const [o] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update");
    if (o?.status !== "paid") return;
    await transitionOrder({ storeId, actor: { kind: "system" }, origin: "system", tx }, orderId, "refunded", "reembolso Asaas");
    await tx.update(payment).set({ status: "REFUNDED" }).where(eq(payment.id, pre.pay.id));
  });
};
