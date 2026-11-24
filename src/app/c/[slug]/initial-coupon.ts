// `?cupom=` (D9): a prévia inicial sai no servidor, para a página abrir com o cupom já aplicado. A página só passa o
// valor da URL; a regra fica em `checkout.previewCoupon` (via `runAction`). Cupom ruim na URL nunca bloqueia a compra:
// o campo abre com o código e a mensagem neutra, e a pessoa segue ou digita outro. Aplicado uma vez por carregamento.
import { ActionError, runAction } from "@/lib/actions/core";
import { checkoutPreviewCoupon, previewErrorResult } from "@/lib/checkout";
import { COUPON_UNAVAILABLE_MESSAGE } from "@/lib/coupons/messages";
import { log } from "@/lib/log";
import type { CouponState } from "./coupon-logic";

/** Mesmo teto do `code` da prévia. */
const CODE_MAX = 64;

export async function initialCoupon(storeId: string, slug: string, raw: string | string[] | undefined, clientIp: string): Promise<CouponState | null> {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const code = value?.trim().slice(0, CODE_MAX);
  if (!code) return null;
  try {
    const r = await runAction(checkoutPreviewCoupon, { storeId, actor: { kind: "public" }, origin: "public" }, { slug, code, withBump: false, clientIp });
    return r.ok ? { kind: "applied", code: r.code, discountCents: r.discountCents, totalCents: r.totalCents, withBump: false } : { kind: "open", code, message: r.message };
  } catch (e) {
    if (e instanceof ActionError) return { kind: "open", code, message: previewErrorResult(e).message };
    // Erro inesperado: só o erro vai para o log (sem IP, sem código, sem dado do comprador). A página abre normalmente.
    log.error("checkout: erro inesperado na prévia do cupom da URL", { error: e });
    return { kind: "open", code, message: COUPON_UNAVAILABLE_MESSAGE };
  }
}
