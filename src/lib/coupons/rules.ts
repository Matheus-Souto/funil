// Regra pura do cupom (sem banco, sem relógio): normalização do código e cálculo do desconto. Dinheiro em centavos
// inteiros; percentual em pontos-base (1000 = 10%) com arredondamento para baixo.

export const COUPON = {
  /**
   * Piso do total com desconto, em centavos. O mínimo de cobrança do Asaas (Pix e cartão) ainda está pendente de
   * confirmação no sandbox; até lá vale R$ 5,00.
   */
  minTotalCents: 500,
  previewPerIpPerHour: 20,
  previewPerStorePerHour: 300,
  /** Cartão pendente criado há menos que isso ainda conta como uso do cupom. */
  cardPendingCountsHours: 2,
} as const;

/** Mesma regra do check `coupon_code_check` da tabela. */
const CODE_RE = /^[A-Z0-9_-]{3,32}$/;

/** Apara, põe em maiúsculas e valida; `null` se o código não for aceito. */
export function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export interface CouponRule {
  kind: "percent" | "fixed";
  percentBp: number | null;
  amountCents: number | null;
  appliesTo: "main" | "all";
}

export interface Discount {
  discountCents: number;
  mainDiscountCents: number;
  bumpDiscountCents: number;
}

/**
 * Desconto do cupom sobre as partes do pedido. A base é o principal (mais o bump se `appliesTo = 'all'`). O fixo é
 * limitado à base e o total final (principal + bump) nunca fica abaixo de `COUPON.minTotalCents`: o que passar do piso
 * é cortado. O desconto se divide entre principal e bump na proporção da base, com a sobra no principal.
 */
export function computeDiscount(c: CouponRule, parts: { mainCents: number; bumpCents: number }): Discount {
  const { mainCents, bumpCents } = parts;
  const discountsBump = c.appliesTo === "all";
  const base = mainCents + (discountsBump ? bumpCents : 0);
  const raw = c.kind === "percent" ? Math.floor((base * (c.percentBp ?? 0)) / 10_000) : (c.amountCents ?? 0);
  const room = Math.max(0, mainCents + bumpCents - COUPON.minTotalCents);
  const discountCents = Math.max(0, Math.min(raw, base, room));
  const bumpDiscountCents = discountsBump && base > 0 ? Math.floor((discountCents * bumpCents) / base) : 0;
  return { discountCents, mainDiscountCents: discountCents - bumpDiscountCents, bumpDiscountCents };
}
