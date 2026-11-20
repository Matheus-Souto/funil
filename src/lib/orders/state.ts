import { and, eq, sql } from "drizzle-orm";
import { ActionError, type Ctx } from "@/lib/actions/core";
import { orders } from "@/lib/db/schema";
import { enqueue } from "@/lib/jobs";
import { log } from "@/lib/log";

export type OrderStatus = "pending" | "paid" | "refunded" | "disputed" | "expired" | "declined";

/** Transições válidas: de -> destinos. */
export const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid", "expired", "declined"],
  paid: ["refunded", "disputed"],
  disputed: ["paid", "refunded"],
  refunded: [],
  expired: [],
  declined: [],
};

/**
 * Muda o estado do pedido com `UPDATE ... WHERE status = <from>` (sem corrida).
 * Efeitos colaterais (jobs) só saem quando uma linha foi realmente atualizada, na mesma transação.
 * Mesmo estado -> `{ changed: false }`; transição inválida -> `conflict`.
 */
export async function transitionOrder(
  ctx: Ctx,
  orderId: string, to: OrderStatus,
  reason: string,
  opts: { allowFromExpired?: boolean } = {},
): Promise<{ changed: boolean }> {
  const read = async () => {
    const [row] = await ctx.tx.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
    return row?.status as OrderStatus | undefined;
  };
  const from = await read();
  if (!from) throw new ActionError("not_found", "Pedido não encontrado");
  if (from === to) return { changed: false };
  // expired -> paid só existe para a liberação manual (comprador que pagou depois da validade); a máquina geral segue estrita.
  const manualLate = opts.allowFromExpired === true && from === "expired" && to === "paid";
  if (!manualLate && !ALLOWED[from].includes(to)) throw new ActionError("conflict", `Transição inválida: ${from} -> ${to}`);

  const updated = await ctx.tx
    .update(orders)
    .set({ status: to, ...(to === "paid" ? { paidAt: sql`coalesce(${orders.paidAt}, now())` } : {}) })
    .where(and(eq(orders.id, orderId), eq(orders.status, from)))
    .returning({ id: orders.id });

  if (updated.length === 0) {
    // Outra transação mudou o estado entre a leitura e o UPDATE: reavalia sem efeitos.
    const now = await read();
    if (now === to) return { changed: false };
    throw new ActionError("conflict", `Pedido mudou de estado: ${now ?? "?"} -> ${to} não é possível`);
  }

  const storeId = ctx.storeId;
  if (to === "paid" && from === "disputed") {
    // Chargeback revertido a favor da loja: devolve o acesso; não é uma venda nova (sem e-mail, Meta nem aviso).
    await enqueue(ctx.tx, { storeId, type: "restore_downloads", payload: { orderId } });
  } else if (to === "paid") {
    await enqueue(ctx.tx, { storeId, type: "deliver_order", payload: { orderId } });
    await enqueue(ctx.tx, { storeId, type: "meta_event", payload: { event: "Purchase", orderId } });
    await enqueue(ctx.tx, { storeId, type: "notify_seller", payload: { orderId } });
    await enqueue(ctx.tx, { storeId, type: "notify_telegram", payload: { event: "sale", orderId } });
  } else if (to === "refunded" || to === "disputed") {
    await enqueue(ctx.tx, { storeId, type: "revoke_downloads", payload: { orderId } });
  }
  log.info("pedido mudou de estado", { orderId, from, to, reason });
  return { changed: true };
}
