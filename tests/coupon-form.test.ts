import { describe, expect, test } from "bun:test";
import { amountToCents, couponStatus, centsToAmountInput, dateInputOf, endOfDateInput, percentToInput, percentToBp, startOfDateInput } from "@/lib/coupons/form";

describe("percentual digitado -> pontos-base", () => {
  test("inteiro e com vírgula ou ponto, até 2 casas", () => {
    expect(percentToBp("10")).toEqual({ ok: true, value: 1000 });
    expect(percentToBp("12,5")).toEqual({ ok: true, value: 1250 });
    expect(percentToBp("12.5")).toEqual({ ok: true, value: 1250 });
    expect(percentToBp(" 0,01 ")).toEqual({ ok: true, value: 1 });
    expect(percentToBp("7,25%")).toEqual({ ok: true, value: 725 });
    expect(percentToBp("90")).toEqual({ ok: true, value: 9000 });
    expect(percentToBp("0,1")).toEqual({ ok: true, value: 10 });
  });
  test("nada de ponto flutuante: 0,29 e 1,15 dão pontos-base exatos", () => {
    expect(percentToBp("0,29")).toEqual({ ok: true, value: 29 });
    expect(percentToBp("1,15")).toEqual({ ok: true, value: 115 });
  });
  test("recusa mais de 2 casas, acima de 90%, zero, vazio e lixo", () => {
    for (const bad of ["12,555", "0,001", "90,01", "91", "100", "0", "0,00", "", "abc", "-5", "1,2,3", "1e2", ","]) {
      expect(percentToBp(bad).ok).toBe(false);
    }
    expect(percentToBp("12,555")).toMatchObject({ ok: false, error: expect.stringContaining("2 casas") });
    expect(percentToBp("91")).toMatchObject({ ok: false, error: expect.stringContaining("90%") });
  });
  test("pontos-base -> texto do campo", () => {
    expect(percentToInput(1000)).toBe("10");
    expect(percentToInput(1250)).toBe("12,5");
    expect(percentToInput(725)).toBe("7,25");
    expect(percentToInput(1)).toBe("0,01");
    expect(percentToInput(9000)).toBe("90");
  });
});

describe("valor fixo em reais -> centavos", () => {
  test("string para centavos inteiros", () => {
    expect(amountToCents("5")).toEqual({ ok: true, value: 500 });
    expect(amountToCents("R$ 9,90")).toEqual({ ok: true, value: 990 });
    expect(amountToCents("1.284,70")).toEqual({ ok: true, value: 128470 });
    expect(amountToCents("0,10")).toEqual({ ok: true, value: 10 });
  });
  test("recusa zero, vazio, negativo, mais de 2 casas e lixo", () => {
    for (const bad of ["0", "0,00", "", "abc", "-5", "1,234", "1,2,3"]) expect(amountToCents(bad).ok).toBe(false);
  });
  test("centavos -> texto do campo", () => {
    expect(centsToAmountInput(990)).toBe("9,90");
    expect(centsToAmountInput(500)).toBe("5,00");
  });
});

describe("datas do campo (horário de São Paulo)", () => {
  test("início é a meia-noite e o fim é o último segundo do dia, em São Paulo", () => {
    expect(startOfDateInput("2026-12-01").toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(endOfDateInput("2026-12-31").toISOString()).toBe("2027-01-01T02:59:59.000Z");
  });
  test("data do campo a partir do instante (dia de São Paulo)", () => {
    expect(dateInputOf(new Date("2027-01-01T02:59:59.000Z"))).toBe("2026-12-31");
    expect(dateInputOf(new Date("2026-12-01T03:00:00.000Z"))).toBe("2026-12-01");
    expect(dateInputOf(null)).toBe("");
  });
});

describe("situação do cupom", () => {
  const now = new Date("2026-12-10T12:00:00Z");
  const base = { active: true, archivedAt: null, startsAt: null, endsAt: null };
  test("arquivado vence tudo; depois desligado, agendado, vencido e valendo", () => {
    expect(couponStatus({ ...base, archivedAt: now, active: false }, now)).toBe("archived");
    expect(couponStatus({ ...base, active: false }, now)).toBe("inactive");
    expect(couponStatus({ ...base, startsAt: new Date("2026-12-11T00:00:00Z") }, now)).toBe("scheduled");
    expect(couponStatus({ ...base, endsAt: new Date("2026-12-10T12:00:00Z") }, now)).toBe("expired");
    expect(couponStatus({ ...base, startsAt: new Date("2026-12-01T00:00:00Z"), endsAt: new Date("2026-12-31T00:00:00Z") }, now)).toBe("active");
    expect(couponStatus(base, now)).toBe("active");
  });
});
