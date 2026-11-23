// Parcelas pelo total do pedido: módulo puro compartilhado pelo servidor e pelo checkout (rótulo "Em até Nx").
import { describe, expect, test } from "bun:test";
import { installmentsFor as fromCheckout } from "@/lib/checkout";
import { MIN_INSTALLMENT_CENTS, installmentsFor } from "@/lib/payments/installments";

describe("installmentsFor", () => {
  test("limita pelo total com desconto e pela parcela mínima de R$ 5,00", () => {
    expect(MIN_INSTALLMENT_CENTS).toBe(500);
    expect([installmentsFor(5, 2200), installmentsFor(5, 2700), installmentsFor(12, 500), installmentsFor(3, 499), installmentsFor(1, 9000)]).toEqual([4, 5, 1, 1, 1]);
  });

  test("o desconto reduz as parcelas mostradas (2700 -> 5x; com cupom, 2200 -> 4x)", () => {
    expect(installmentsFor(5, 2700)).toBe(5);
    expect(installmentsFor(5, 2700 - 500)).toBe(4);
  });

  test("o servidor reexporta a mesma função", () => {
    expect(fromCheckout).toBe(installmentsFor);
  });
});
