// Cupom no formulário do checkout (A4): a lógica pura de `coupon-logic.ts`, com a prévia falsa (sem Radix nem DOM).
// Foco: preço mostrado = preço enviado (`expectedTotalCents` é o total da tela), prévia refeita ao marcar o bump e
// `PRICE_CHANGED` refazendo a prévia sem reenviar.
import { describe, expect, test } from "bun:test";
import {
  COUPON_INVALID_MESSAGE,
  COUPON_UNAVAILABLE_MESSAGE,
  PRICE_CHANGED_MESSAGE,
  afterStartFailure,
  applyCoupon,
  closeCoupon,
  couponLine,
  displayTotal,
  initialCouponState,
  couponIsStale,
  openCoupon,
  reconcileCoupon,
  refreshCoupon,
  submitCoupon,
  type CouponState,
  type PreviewFn,
  type PreviewResult,
} from "@/app/c/[slug]/coupon-logic";

const PRICE = 990;
const BUMP = 1710;

/** Prévia falsa: KIDS10 dá 10% no principal (99); TUDO10 dá 10% em tudo; o resto é inválido. Guarda as chamadas. */
function fakePreview() {
  const calls: { code: string; withBump: boolean }[] = [];
  const preview: PreviewFn = async (code, withBump) => {
    calls.push({ code, withBump });
    const c = code.trim().toUpperCase();
    const bump = withBump ? BUMP : 0;
    if (c === "KIDS10") return { ok: true, code: "KIDS10", discountCents: 99, totalCents: PRICE + bump - 99 };
    if (c === "TUDO10") {
      const d = Math.floor(((PRICE + bump) * 1000) / 10000);
      return { ok: true, code: "TUDO10", discountCents: d, totalCents: PRICE + bump - d };
    }
    return { ok: false, message: COUPON_INVALID_MESSAGE };
  };
  return { preview, calls };
}

const applied = (code = "KIDS10", withBump = false): CouponState => ({
  kind: "applied",
  code,
  discountCents: 99,
  totalCents: PRICE + (withBump ? BUMP : 0) - 99,
  withBump,
});

describe("estado do cupom: abrir, aplicar, remover", () => {
  test("começa recolhido; \"Tenho um cupom\" abre o campo vazio", () => {
    expect(initialCouponState(null)).toEqual({ kind: "closed" });
    expect(openCoupon({ kind: "closed" })).toEqual({ kind: "open", code: "", message: null });
    // Já aplicado: abrir de novo não perde o cupom.
    expect(openCoupon(applied())).toEqual(applied());
  });

  test("prévia válida aplica: mostra o desconto e o total novo", async () => {
    const { preview } = fakePreview();
    const st = await applyCoupon(preview, " kids10 ", false);
    expect(st).toEqual({ kind: "applied", code: "KIDS10", discountCents: 99, totalCents: 891, withBump: false });
    expect(couponLine(st)).toEqual({ code: "KIDS10", discountCents: 99 });
    expect(displayTotal({ priceCents: PRICE, bumpCents: null }, st, false)).toBe(891);
  });

  test("prévia inválida mantém o campo aberto com a mensagem neutra e o código digitado", async () => {
    const { preview } = fakePreview();
    const st = await applyCoupon(preview, "NAOEXISTE", false);
    expect(st).toEqual({ kind: "open", code: "NAOEXISTE", message: "Cupom inválido ou vencido" });
    expect(couponLine(st)).toBeNull();
    expect(displayTotal({ priceCents: PRICE, bumpCents: null }, st, false)).toBe(990);
  });

  test("campo vazio não chama o servidor", async () => {
    const { preview, calls } = fakePreview();
    const st = await applyCoupon(preview, "   ", false);
    expect(st).toEqual({ kind: "open", code: "", message: "Digite o código do cupom." });
    expect(calls).toEqual([]);
  });

  test("falha de rede na prévia: mensagem calma, sem estourar", async () => {
    const st = await applyCoupon(() => Promise.reject(new Error("rede")), "KIDS10", false);
    expect(st).toEqual({ kind: "open", code: "KIDS10", message: COUPON_UNAVAILABLE_MESSAGE });
  });

  test("remover volta ao preço cheio e ao link recolhido", () => {
    const st = closeCoupon();
    expect(st).toEqual({ kind: "closed" });
    expect(displayTotal({ priceCents: PRICE, bumpCents: BUMP }, st, true)).toBe(2700);
    expect(submitCoupon(st, 2700)).toEqual({});
  });
});

describe("bump e cupom", () => {
  test("marcar o bump refaz a prévia com withBump e atualiza o total", async () => {
    const { preview, calls } = fakePreview();
    const st = await refreshCoupon(preview, applied("TUDO10"), true);
    expect(calls).toEqual([{ code: "TUDO10", withBump: true }]);
    expect(st).toEqual({ kind: "applied", code: "TUDO10", discountCents: 270, totalCents: 2430, withBump: true });
    expect(displayTotal({ priceCents: PRICE, bumpCents: BUMP }, st, true)).toBe(2430);
  });

  test("desmarcar o bump refaz de novo (principal só: desconto igual, total menor)", async () => {
    const { preview, calls } = fakePreview();
    const st = await refreshCoupon(preview, applied("KIDS10", true), false);
    expect(calls).toEqual([{ code: "KIDS10", withBump: false }]);
    expect(st).toMatchObject({ kind: "applied", totalCents: 891, withBump: false });
  });

  test("sem cupom aplicado não chama o servidor", async () => {
    const { preview, calls } = fakePreview();
    const open: CouponState = { kind: "open", code: "KID", message: null };
    expect(await refreshCoupon(preview, open, true)).toEqual(open);
    expect(await refreshCoupon(preview, { kind: "closed" }, true)).toEqual({ kind: "closed" });
    expect(calls).toEqual([]);
  });

  test("o cupom deixou de valer ao marcar o bump: volta a aberto com a mensagem neutra", async () => {
    const preview: PreviewFn = async () => ({ ok: false, message: COUPON_INVALID_MESSAGE });
    expect(await refreshCoupon(preview, applied(), true)).toEqual({ kind: "open", code: "KIDS10", message: COUPON_INVALID_MESSAGE });
  });

  test("enquanto a prévia do bump não volta, o total estimado tira o desconto antigo do preço cheio", () => {
    // Aplicado sem bump (desconto 99); bump marcado e prévia ainda no ar: 990 + 1710 - 99.
    expect(displayTotal({ priceCents: PRICE, bumpCents: BUMP }, applied("KIDS10", false), true)).toBe(2601);
    // Sem bump na oferta, o bump marcado não existe.
    expect(displayTotal({ priceCents: PRICE, bumpCents: null }, applied("KIDS10", false), false)).toBe(891);
  });
});

describe("bump marcado com a prévia em voo", () => {
  test("Aplicar começou sem bump, o bump foi marcado antes da resposta: refaz com o bump e o total bate", async () => {
    const { preview, calls } = fakePreview();
    let bump = false; // o checkbox de agora
    // A resposta do "Aplicar" chega depois de o comprador marcar o bump.
    const inFlight = applyCoupon(preview, "TUDO10", false);
    bump = true;
    const st = await reconcileCoupon(preview, await inFlight, () => bump);
    expect(calls).toEqual([
      { code: "TUDO10", withBump: false },
      { code: "TUDO10", withBump: true },
    ]);
    expect(st).toEqual({ kind: "applied", code: "TUDO10", discountCents: 270, totalCents: 2430, withBump: true });
    expect(couponIsStale(st, true)).toBe(false);
    expect(displayTotal({ priceCents: PRICE, bumpCents: BUMP }, st, true)).toBe(2430);
  });

  test("o bump vira e desvira durante a prévia: termina na prévia do estado final", async () => {
    const { preview, calls } = fakePreview();
    const seq = [true, false];
    let bump = false;
    const flip: PreviewFn = async (c, w) => {
      const r = await preview(c, w);
      bump = seq.shift() ?? bump; // o comprador mexe no checkbox enquanto cada prévia está no ar
      return r;
    };
    const first = await applyCoupon(flip, "KIDS10", false);
    bump = true;
    const st = await reconcileCoupon(flip, first, () => bump);
    expect(st).toMatchObject({ kind: "applied", withBump: false, totalCents: 891 });
    expect(calls.at(-1)).toEqual({ code: "KIDS10", withBump: false });
  });

  test("o cupom aplicado conferido para outro bump é velho: o Pagar espera", () => {
    expect(couponIsStale(applied("KIDS10", false), true)).toBe(true);
    expect(couponIsStale(applied("KIDS10", true), true)).toBe(false);
    expect(couponIsStale({ kind: "closed" }, true)).toBe(false);
    expect(couponIsStale({ kind: "open", code: "X", message: null }, true)).toBe(false);
  });

  test("sem divergência não chama o servidor de novo", async () => {
    const { preview, calls } = fakePreview();
    const st = applied("KIDS10", true);
    expect(await reconcileCoupon(preview, st, () => true)).toBe(st);
    expect(calls).toEqual([]);
  });
});

describe("envio: expectedTotalCents = total mostrado", () => {
  test("cupom aplicado leva o código e o total da tela", () => {
    const total = displayTotal({ priceCents: PRICE, bumpCents: BUMP }, applied("KIDS10", true), true);
    expect(submitCoupon(applied("KIDS10", true), total)).toEqual({ couponCode: "KIDS10", expectedTotalCents: 2601 });
  });

  test("sem cupom aplicado (fechado ou aberto com erro) não leva nada", () => {
    expect(submitCoupon({ kind: "closed" }, 990)).toEqual({});
    expect(submitCoupon({ kind: "open", code: "NAO", message: "x" }, 990)).toEqual({});
  });
});

describe("resposta do envio", () => {
  const failure = (o: { message: string; priceChanged?: true; fields?: Record<string, string> }) => o;

  test("PRICE_CHANGED: refaz a prévia, mostra a mensagem e não reenvia", async () => {
    // O servidor passou a dar outro desconto (ex.: o cupom foi editado): a prévia nova traz o total novo.
    const calls: string[] = [];
    const preview: PreviewFn = async (code, withBump) => {
      calls.push(`${code}:${withBump}`);
      return { ok: true, code, discountCents: 150, totalCents: 840 };
    };
    const r = await afterStartFailure(preview, applied(), false, failure({ message: PRICE_CHANGED_MESSAGE, priceChanged: true }));
    expect(calls).toEqual(["KIDS10:false"]);
    expect(r.coupon).toEqual({ kind: "applied", code: "KIDS10", discountCents: 150, totalCents: 840, withBump: false });
    expect(r.message).toBe("O valor mudou: confira o resumo");
    expect(r.handled).toBe(true);
  });

  test("PRICE_CHANGED com o cupom vencido na prévia: campo aberto com a mensagem neutra e aviso de valor", async () => {
    const preview: PreviewFn = async () => ({ ok: false, message: COUPON_INVALID_MESSAGE });
    const r = await afterStartFailure(preview, applied(), false, failure({ message: PRICE_CHANGED_MESSAGE, priceChanged: true }));
    expect(r.coupon).toEqual({ kind: "open", code: "KIDS10", message: COUPON_INVALID_MESSAGE });
    expect(r.message).toBe(PRICE_CHANGED_MESSAGE);
  });

  test("cupom recusado no envio (couponCode): campo aberto com a mensagem do servidor, sem aviso no topo", async () => {
    const { preview, calls } = fakePreview();
    const r = await afterStartFailure(preview, applied(), false, failure({ message: "Confira os campos marcados.", fields: { couponCode: COUPON_INVALID_MESSAGE } }));
    expect(r.coupon).toEqual({ kind: "open", code: "KIDS10", message: COUPON_INVALID_MESSAGE });
    expect(r.message).toBeNull();
    expect(r.handled).toBe(true);
    expect(calls).toEqual([]);
  });

  test("outro erro: não mexe no cupom e deixa o formulário tratar", async () => {
    const { preview, calls } = fakePreview();
    const r = await afterStartFailure(preview, applied(), false, failure({ message: "Confira os campos marcados.", fields: { "customer.email": "Confira o e-mail" } }));
    expect(r).toEqual({ coupon: applied(), message: null, handled: false });
    expect(calls).toEqual([]);
  });
});

describe("resultado do servidor (tipos)", () => {
  test("PreviewResult aceita os dois formatos da ação", () => {
    const a: PreviewResult = { ok: true, code: "KIDS10", discountCents: 99, totalCents: 891 };
    const b: PreviewResult = { ok: false, message: COUPON_INVALID_MESSAGE };
    expect([a.ok, b.ok]).toEqual([true, false]);
  });
});
