// Parcelas pelo total do pedido: módulo puro compartilhado pelo servidor e pelo checkout (rótulo "Em até Nx").
import { describe, expect, test } from "bun:test";
import { installmentsFor as fromCheckout } from "@/lib/checkout";
import { MIN_INSTALLMENT_CENTS, installmentsFor } from "@/lib/payments/installments";

describe("installmentsFor", () => {
  const coupon = { discounted: true };
  const plain = { discounted: false };

  test("com cupom: limita pelo total com desconto e pela parcela mínima de R$ 5,00", () => {
    expect(MIN_INSTALLMENT_CENTS).toBe(500);
    const r = [installmentsFor(5, 2200, coupon), installmentsFor(5, 2700, coupon), installmentsFor(12, 500, coupon), installmentsFor(3, 499, coupon), installmentsFor(1, 9000, coupon)];
    expect(r).toEqual([4, 5, 1, 1, 1]);
  });

  test("o cupom reduz as parcelas mostradas (Completo 2700 em até 5x; com fixo de 500, 2200 -> 4x)", () => {
    expect(installmentsFor(5, 2700 - 500, coupon)).toBe(4);
  });

  test("sem cupom: o máximo da oferta, como antes (R-V1: R$ 9,90 em até 3x -> 3x)", () => {
    expect([installmentsFor(3, 990, plain), installmentsFor(5, 2700, plain), installmentsFor(12, 500, plain), installmentsFor(1, 9000, plain)]).toEqual([3, 5, 12, 1]);
  });

  test("o servidor reexporta a mesma função", () => {
    expect(fromCheckout).toBe(installmentsFor);
  });
});
