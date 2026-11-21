// Conferências da recuperação usadas na varredura (`scan.ts`) e de novo no envio (`send.ts`): a fila pode rodar bem depois
// da varredura, e o envio refaz as mesmas consultas com o estado atual. Todas dentro de `withStore` (RLS da loja).
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { customer, emailOptout, orders } from "@/lib/db/schema";
import { RECOVERY } from "./rules";

const DAY_MS = 86_400_000;

/** Pedido que já foi pago em algum momento (pago, contestado ou reembolsado). */
export const WAS_PAID = ["paid", "disputed", "refunded"];

/** O e-mail (pelo sha256) está em `email_optout` da loja. */
export async function optedOut(tx: Tx, storeId: string, emailHash: string): Promise<boolean> {
  const [row] = await tx
    .select({ h: emailOptout.emailHash })
    .from(emailOptout)
    .where(and(eq(emailOptout.storeId, storeId), eq(emailOptout.emailHash, emailHash)));
  return row !== undefined;
}

/**
 * Já comprou a mesma oferta com o mesmo e-mail (pedido pago, contestado ou reembolsado, pago ou criado nos últimos 30
 * dias). O `customer.email` é gravado minúsculo; único por loja e e-mail.
 */
export async function alreadyBought(tx: Tx, offerId: string, email: string, t: Date): Promise<boolean> {
  const since = new Date(t.getTime() - RECOVERY.boughtLookbackDays * DAY_MS).toISOString();
  const [row] = await tx
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(customer, eq(customer.id, orders.customerId))
    .where(
      and(
        eq(orders.offerId, offerId),
        eq(customer.email, email.trim().toLowerCase()),
        inArray(orders.status, WAS_PAID),
        sql`coalesce(${orders.paidAt}, ${orders.createdAt}) > ${since}::timestamptz`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Há pedido mais novo do mesmo cliente na mesma oferta (o lembrete vai só para o mais novo). */
export async function hasNewerOrder(tx: Tx, o: { id: string; customerId: string; offerId: string; createdAt: Date }): Promise<boolean> {
  const [row] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.customerId, o.customerId), eq(orders.offerId, o.offerId), ne(orders.id, o.id), gt(orders.createdAt, o.createdAt)))
    .limit(1);
  return row !== undefined;
}
