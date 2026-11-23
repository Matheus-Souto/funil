// Cupom no formulário do checkout (D7/D9): estado e regras puras, sem React nem rede. O formulário guarda um
// `CouponState`, chama estas funções com a prévia (server action) e mostra o resultado. Assim o que a tela mostra e o
// que o envio manda saem da mesma conta: `expectedTotalCents` é sempre o total exibido (nunca um valor que o comprador
// não viu; se o servidor discordar, `PRICE_CHANGED` refaz a prévia e o envio espera um novo clique).

export const COUPON_INVALID_MESSAGE = "Cupom inválido ou vencido";
export const PRICE_CHANGED_MESSAGE = "O valor mudou: confira o resumo";
export const COUPON_EMPTY_MESSAGE = "Digite o código do cupom.";
export const COUPON_UNAVAILABLE_MESSAGE = "Não foi possível conferir o cupom agora. Tente de novo em instantes.";

export type PreviewResult = { ok: true; code: string; discountCents: number; totalCents: number } | { ok: false; message: string };
/** Prévia do servidor (`checkout.previewCoupon`); a oferta e o IP já estão presos na função. */
export type PreviewFn = (code: string, withBump: boolean) => Promise<PreviewResult>;

export type CouponState =
  /** Só o link "Tenho um cupom". */
  | { kind: "closed" }
  /** Campo aberto; `message` é o aviso neutro depois de uma prévia recusada. */
  | { kind: "open"; code: string; message: string | null }
  /** Cupom aceito pelo servidor para este valor de `withBump`. */
  | { kind: "applied"; code: string; discountCents: number; totalCents: number; withBump: boolean };

export const initialCouponState = (initial: CouponState | null | undefined): CouponState => initial ?? { kind: "closed" };

export const openCoupon = (st: CouponState): CouponState => (st.kind === "closed" ? { kind: "open", code: "", message: null } : st);

/** "Remover": volta ao preço cheio e ao link recolhido. */
export const closeCoupon = (): CouponState => ({ kind: "closed" });

function fromPreview(code: string, withBump: boolean, r: PreviewResult): CouponState {
  return r.ok
    ? { kind: "applied", code: r.code, discountCents: r.discountCents, totalCents: r.totalCents, withBump }
    : { kind: "open", code, message: r.message };
}

/** "Aplicar": confere o código no servidor. Nunca lança: falha de rede vira aviso calmo no próprio campo. */
export async function applyCoupon(preview: PreviewFn, raw: string, withBump: boolean): Promise<CouponState> {
  const code = raw.trim();
  if (code === "") return { kind: "open", code: "", message: COUPON_EMPTY_MESSAGE };
  try {
    return fromPreview(code, withBump, await preview(code, withBump));
  } catch {
    return { kind: "open", code, message: COUPON_UNAVAILABLE_MESSAGE };
  }
}

/** Bump marcado ou desmarcado: com cupom aplicado, refaz a prévia (o desconto pode depender do bump). */
export function refreshCoupon(preview: PreviewFn, st: CouponState, withBump: boolean): Promise<CouponState> {
  return st.kind === "applied" ? applyCoupon(preview, st.code, withBump) : Promise.resolve(st);
}

/** Linha do resumo ("Cupom KIDS10 −R$ 0,99"); `null` sem cupom aplicado. */
export function couponLine(st: CouponState): { code: string; discountCents: number } | null {
  return st.kind === "applied" ? { code: st.code, discountCents: st.discountCents } : null;
}

/**
 * Total mostrado. Com cupom aplicado para o mesmo `withBump`, é o total do servidor. Se o bump mudou e a prévia nova
 * ainda não voltou, estima com o desconto anterior (o envio fica travado enquanto a prévia está no ar).
 */
export function displayTotal(parts: { priceCents: number; bumpCents: number | null }, st: CouponState, withBump: boolean): number {
  const full = parts.priceCents + (withBump && parts.bumpCents !== null ? parts.bumpCents : 0);
  if (st.kind !== "applied") return full;
  return st.withBump === withBump ? st.totalCents : full - st.discountCents;
}

/** O que o envio acrescenta: com cupom aplicado, o código e o total que a tela mostra. */
export function submitCoupon(st: CouponState, shownTotalCents: number): { couponCode?: string; expectedTotalCents?: number } {
  return st.kind === "applied" ? { couponCode: st.code, expectedTotalCents: shownTotalCents } : {};
}

/** O pedaço do `StartResult` de erro que importa aqui. */
export type StartFailure = { message: string; priceChanged?: boolean; fields?: Record<string, string> };

/**
 * Resposta de erro do `checkout.start`. `handled`: o erro era do cupom ou do valor; `coupon` e `message` (aviso do topo,
 * `null` = nenhum) dizem o que mostrar. Nunca reenvia: o comprador confere o resumo e clica de novo.
 */
export async function afterStartFailure(
  preview: PreviewFn,
  st: CouponState,
  withBump: boolean,
  r: StartFailure,
): Promise<{ coupon: CouponState; message: string | null; handled: boolean }> {
  if (r.priceChanged) {
    return { coupon: await refreshCoupon(preview, st, withBump), message: PRICE_CHANGED_MESSAGE, handled: true };
  }
  const couponMessage = r.fields?.couponCode;
  if (couponMessage !== undefined) {
    const code = st.kind === "closed" ? "" : st.code;
    return { coupon: { kind: "open", code, message: couponMessage }, message: null, handled: true };
  }
  return { coupon: st, message: null, handled: false };
}
