// O cupom no checkout: resolve o código digitado para um cupom válido para a oferta e o comprador (regra D5/D6), sob o
// lock consultivo do cupom. O desconto em si é `computeDiscount` (rules.ts), aplicado por `createOrder`.
import { and, eq, sql } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import type { Tx } from "@/lib/db/client";
import { coupon, couponOffer } from "@/lib/db/schema";
import { COUPON_INVALID_MESSAGE } from "./messages";
import { normalizeCode, type CouponRule } from "./rules";
import { couponUses, couponUsesByMailbox } from "./usage";

/** `invalid_input` no campo do cupom do checkout. */
export const couponInvalid = () =>
  new ActionError("invalid_input", COUPON_INVALID_MESSAGE, [{ path: ["couponCode"], message: COUPON_INVALID_MESSAGE }]);

/** Recusa do cupom pelo `couponInvalid` (não um erro de esquema no campo): é o que conta no balde de recusas da loja. */
export const isCouponRefusal = (e: unknown): boolean =>
  e instanceof ActionError &&
  e.code === "invalid_input" &&
  e.message === COUPON_INVALID_MESSAGE &&
  Array.isArray(e.details) &&
  e.details.some((d: { path?: unknown }) => Array.isArray(d.path) && d.path[0] === "couponCode");

/**
 * `pg_advisory_xact_lock('coupon:' || id)`, até o fim da transação. O checkout (conferência dos usos e insert do pedido)
 * e as edições do painel (`coupons.update` e `coupons.archive`) tomam o mesmo lock: um não grava no meio do outro.
 */
export async function lockCoupon(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"coupon:" + id}, 0))`);
}

export type ResolvedCoupon = CouponRule & { id: string; code: string };

/**
 * Cupom válido para a oferta agora: ativo, não arquivado, dentro da validade (`starts_at <= now < ends_at`), na lista
 * de ofertas (vazia = todas), com `usos < max_uses` (uso = regra D5, pendentes contam) e, com e-mail,
 * `compras pagas da caixa < max_per_email` (R-F1: só `paid`/`disputed`).
 * Com `lock` (padrão), toma o lock do cupom antes de contar: chamado na transação que cria o pedido, o lock vai até o
 * commit e cobre a conferência e o insert (duas compras no último uso: só uma passa). A prévia passa `lock: false`: só
 * lê, não cria pedido, e não deve enfileirar atrás de um checkout em andamento.
 */
export async function resolveCoupon(
  tx: Tx,
  storeId: string,
  q: { code: string; offerId: string; email?: string; now: Date; lock?: boolean },
): Promise<{ coupon: ResolvedCoupon } | { invalid: true }> {
  const invalid = { invalid: true as const };
  const code = normalizeCode(q.code);
  if (code === null) return invalid;
  const [found] = await tx.select({ id: coupon.id }).from(coupon).where(and(eq(coupon.storeId, storeId), eq(coupon.code, code)));
  if (!found) return invalid;
  if (q.lock !== false) await lockCoupon(tx, found.id);
  // Relido depois do lock (no checkout: o estado de agora, não o de antes de esperar).
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
