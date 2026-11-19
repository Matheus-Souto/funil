import { and, eq, lt } from "drizzle-orm";
import { db, withStore, type Tx } from "@/lib/db/client";
import { orders, store } from "@/lib/db/schema";
import { ActionError } from "@/lib/actions/core";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import { deliverOrderJob, notifySellerJob, restoreDownloadsJob, revokeDownloadsJob, sweepWatermarksJob } from "@/lib/delivery/jobs";
import { refundOrderJob } from "@/lib/payments/refund";
import { pciPageMonitorJob } from "@/lib/security/page-monitor";
import { metaEventJob } from "@/lib/tracking/meta";
import type { JobHandler, JobHandlers, JobType } from "@/lib/jobs";

/**
 * Marca como `expired` os pedidos `pending` vencidos, loja a loja (a tabela `store` não tem RLS).
 * Pedidos travados por outra transação são pulados (SKIP LOCKED) e `conflict` (ex.: virou pago) também.
 * Falha numa loja não impede as demais; ao final, se alguma falhou, o job falha para tentar de novo.
 * `beforeTransition` existe só para testes.
 */
export function createExpireOrdersHandler(beforeTransition?: (tx: Tx, orderId: string) => Promise<void>): JobHandler {
  return async () => {
    const stores = await db.select({ id: store.id }).from(store);
    let failed = 0;
    for (const { id: storeId } of stores) {
      try {
        await withStore(storeId, async (tx) => {
          const due = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(and(eq(orders.status, "pending"), lt(orders.expiresAt, new Date())))
            .for("update", { skipLocked: true });
          let expired = 0;
          for (const o of due) {
            await beforeTransition?.(tx, o.id);
            try {
              const r = await transitionOrder({ storeId, actor: { kind: "system" }, origin: "system", tx }, o.id, "expired", "expirou");
              if (r.changed) expired++;
            } catch (e) {
              if (e instanceof ActionError && e.code === "conflict") continue;
              throw e;
            }
          }
          if (expired > 0) log.info("pedidos expirados", { storeId, count: expired });
        });
      } catch (e) {
        failed++;
        log.error("falha ao expirar pedidos da loja", { storeId, error: e });
      }
    }
    if (failed > 0) throw new Error(`expire_orders falhou em ${failed} loja(s)`);
  };
}

export const expireOrdersHandler: JobHandler = createExpireOrdersHandler();

/** Registro de handlers do worker. Tasks seguintes chamam `registerHandler` (deliver_order, meta_event, ...). */
const registry: JobHandlers = {
  expire_orders: expireOrdersHandler,
  refund_order: refundOrderJob,
  deliver_order: deliverOrderJob,
  notify_seller: notifySellerJob,
  revoke_downloads: revokeDownloadsJob,
  restore_downloads: restoreDownloadsJob,
  sweep_watermarks: sweepWatermarksJob,
  meta_event: metaEventJob,
  pci_page_monitor: pciPageMonitorJob,
};

export function registerHandler(type: JobType, handler: JobHandler): void {
  registry[type] = handler;
}

export const getHandlers = (): JobHandlers => ({ ...registry });
