import { and, eq, lt } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { db } from "@/lib/db/client";
import { orders, store } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import type { JobHandler, JobHandlers, JobType } from "@/lib/jobs";

/** Marca como `expired` os pedidos `pending` vencidos, loja a loja (a tabela `store` não tem RLS). */
export const expireOrdersHandler: JobHandler = async () => {
  const stores = await db.select({ id: store.id }).from(store);
  for (const { id: storeId } of stores) {
    await withStore(storeId, async (tx) => {
      const due = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.status, "pending"), lt(orders.expiresAt, new Date())));
      for (const o of due) {
        await transitionOrder({ storeId, actor: { kind: "system" }, origin: "system", tx }, o.id, "expired", "expirou");
      }
      if (due.length > 0) log.info("pedidos expirados", { storeId, count: due.length });
    });
  }
};

/** Registro de handlers do worker. Tasks seguintes chamam `registerHandler` (deliver_order, meta_event, ...). */
const registry: JobHandlers = { expire_orders: expireOrdersHandler };

export function registerHandler(type: JobType, handler: JobHandler): void {
  registry[type] = handler;
}

export const getHandlers = (): JobHandlers => ({ ...registry });
