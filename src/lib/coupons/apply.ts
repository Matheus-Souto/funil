// O cupom no checkout: resolve o código digitado para um cupom válido para a oferta e o comprador (regra D5/D6), sob o
// lock consultivo do cupom. O desconto em si é `computeDiscount` (rules.ts), aplicado por `createOrder`.
import { and, eq, sql } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import type { Tx } from "@/lib/db/client";
import { coupon, couponOffer } from "@/lib/db/schema";
import { normalizeCode, type CouponRule } from "./rules";
import { couponUses, couponUsesByMailbox } from "./usage";

/** Mensagem neutra: nunca diz qual regra falhou (vencido, esgotado, outra oferta, já usado por esta pessoa...). */
export const COUPON_INVALID_MESSAGE = "Cupom inválido ou vencido";

/** `invalid_input` no campo do cupom do checkout. */
export const couponInvalid = () =>
  new ActionError("invalid_input", COUPON_INVALID_MESSAGE, [{ path: ["couponCode"], message: COUPON_INVALID_MESSAGE }]);

export type ResolvedCoupon = CouponRule & { id: string; code: string };

/**
 * Cupom válido para a oferta agora: ativo, não arquivado, dentro da validade (`starts_at <= now < ends_at`), na lista
 * de ofertas (vazia = todas), com `usos < max_uses` e, com e-mail, `usos da caixa < max_per_email` (uso = regra D5).
 * Toma `pg_advisory_xact_lock('coupon:' || id)` antes de contar: chamado na transação que cria o pedido, o lock vai até
 * o commit e cobre a conferência e o insert (duas compras no último uso: só uma passa).
 */
export async function resolveCoupon(
  tx: Tx,
  storeId: string,
  q: { code: string; offerId: string; email?: string; now: Date },
): Promise<{ coupon: ResolvedCoupon } | { invalid: true }> {
  const invalid = { invalid: true as const };
  const code = normalizeCode(q.code);
  if (code === null) return invalid;
  const [found] = await tx.select({ id: coupon.id }).from(coupon).where(and(eq(coupon.storeId, storeId), eq(coupon.code, code)));
  if (!found) return invalid;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"coupon:" + found.id}, 0))`);
  // Relido sob o lock (estado de agora, não o de antes de esperar).
  const [c] = await tx.select().from(coupon).where(eq(coupon.id, found.id));
  if (!c || !c.active || c.archivedAt !== null) return invalid;
  const now = q.now.getTime();
  if (c.startsAt && c.startsAt.getTime() > now) return invalid;
  if (c.endsAt && c.endsAt.getTime() <= now) return invalid;

  const offers = await tx.select({ offerId: couponOffer.offerId }).from(couponOffer).where(eq(couponOffer.couponId, c.id));
  if (offers.length > 0 && !offers.some((o) => o.offerId === q.offerId)) return invalid;

  if (c.maxUses !== null && ((await couponUses(tx, [c.id])).get(c.id) ?? 0) >= c.maxUses) return invalid;
  if (c.maxPerEmail !== null && q.email && (await couponUsesByMailbox(tx, c.id, q.email)) >= c.maxPerEmail) return invalid;

  return {
    coupon: {
      id: c.id,
      code: c.code,
      kind: c.kind as CouponRule["kind"],
      percentBp: c.percentBp,
      amountCents: c.amountCents,
      appliesTo: c.appliesTo as CouponRule["appliesTo"],
    },
  };
}
