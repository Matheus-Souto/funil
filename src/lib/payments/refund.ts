import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { orders, payment } from "@/lib/db/schema";
import { transitionOrder } from "@/lib/orders/state";
import { asaasClientFor } from "./asaas/client";

export const refundOrder = defineAction({
  name: "orders.refund",
  description: "Reembolsa um pedido pago (Asaas: estorna na cobrança; Pix manual: só marca, a devolução é pelo banco).",
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
      return { orderId: o.id, message: "Pedido marcado como reembolsado. Devolva o valor ao comprador pelo seu banco (o Pix manual não passa por aqui)." };
    }

    const [pay] = await ctx.tx
      .select()
      .from(payment)
      .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas")));
    if (!pay?.providerId) throw new ActionError("conflict", "Pedido sem cobrança no Asaas");
    // Se o Asaas falhar, o erro (provider_error) aborta a transação: o estado não muda.
    await (await asaasClientFor(ctx.tx, ctx.storeId)).refundPayment(pay.providerId);
    await transitionOrder(ctx, o.id, "refunded", "reembolso Asaas");
    await ctx.tx.update(payment).set({ status: "REFUNDED" }).where(eq(payment.id, pay.id));
    return { orderId: o.id, message: "Reembolso enviado ao Asaas." };
  },
});
