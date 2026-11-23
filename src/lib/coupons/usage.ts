// Contagem de usos do cupom (spec D5), numa regra só: `coupons.list` mostra o número e o `resolveCoupon` (checkout)
// confere o limite com a mesma condição. Relógio do banco (`now()`), como o resto dos prazos de pedido.
import { and, count, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { orders } from "@/lib/db/schema";
import { COUPON } from "./rules";

/**
 * Pedido que conta como uso de um cupom: `paid` ou `disputed`, mais os pendentes que ainda podem ser pagos (Pix não
 * vencido; cartão criado há menos de `COUPON.cardPendingCountsHours`). `refunded`, `expired` e `declined` não contam.
 * Combine com `eq(orders.couponId, ...)` (e, para o limite por pessoa, com o filtro da caixa de e-mail).
 */
export function countsAsCouponUse(): SQL {
  return or(
    inArray(orders.status, ["paid", "disputed"]),
    and(
      eq(orders.status, "pending"),
      or(
        and(inArray(orders.method, ["pix_asaas", "pix_manual"]), sql`${orders.expiresAt} > now()`),
        and(eq(orders.method, "card_asaas"), sql`${orders.createdAt} > now() - make_interval(hours => ${COUPON.cardPendingCountsHours})`),
      ),
    ),
  )!;
}

/** Usos por cupom (cupom sem uso fica com 0). */
export async function couponUses(tx: Tx, couponIds: string[]): Promise<Map<string, number>> {
  const uses = new Map<string, number>(couponIds.map((id) => [id, 0]));
  if (couponIds.length === 0) return uses;
  const rows = await tx
    .select({ couponId: orders.couponId, n: count() })
    .from(orders)
    .where(and(inArray(orders.couponId, couponIds), countsAsCouponUse()))
    .groupBy(orders.couponId);
  for (const r of rows) if (r.couponId) uses.set(r.couponId, r.n);
  return uses;
}
