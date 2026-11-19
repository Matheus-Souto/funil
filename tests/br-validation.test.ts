import { describe, expect, test } from "bun:test";
import { cardExpiryValid, normalizeBrMobile, validCpf, validEmail } from "@/lib/validation/br";

describe("validações brasileiras do checkout", () => {
  test("CPF: dígitos verificadores", () => {
    expect(validCpf("52998224725")).toBe(true);
    expect(validCpf("11144477735")).toBe(true);
    expect(validCpf("12345678900")).toBe(false);
    expect(validCpf("11111111111")).toBe(false);
    expect(validCpf("5299822472")).toBe(false);
  });

  test("celular: DDD válido, 9 + 8 dígitos, sem repetição; aceita máscara e +55", () => {
    expect(normalizeBrMobile("(11) 98765-4321")).toBe("11987654321");
    expect(normalizeBrMobile("+55 21 98765-4321")).toBe("21987654321");
    expect(normalizeBrMobile("11987654321")).toBe("11987654321");
    for (const bad of ["11999999999", "11911111111", "(20) 98765-4321", "(10) 98765-4321", "1187654321", "11887654321", "119876543210", ""]) {
      expect(normalizeBrMobile(bad)).toBeNull();
    }
  });

  test("e-mail", () => {
    expect(validEmail("maria.souza@gmail.com")).toBe(true);
    expect(validEmail("maria@")).toBe(false);
    expect(validEmail("maria@gmail")).toBe(false);
    expect(validEmail(`${"a".repeat(250)}@x.com`)).toBe(false);
  });

  test("validade do cartão: não antes do mês atual em São Paulo", () => {
    // 01/12/2026 01:00 UTC ainda é 30/11 em São Paulo.
    const now = new Date("2026-12-01T01:00:00Z");
    expect(cardExpiryValid("11", "2026", now)).toBe(true);
    expect(cardExpiryValid("11", "26", now)).toBe(true);
    expect(cardExpiryValid("10", "2026", now)).toBe(false);
    expect(cardExpiryValid("12", "2025", now)).toBe(false);
    expect(cardExpiryValid("13", "2027", now)).toBe(false);
    expect(cardExpiryValid("01", "2027", now)).toBe(true);
    expect(cardExpiryValid("01", "2060", now)).toBe(false);
    expect(cardExpiryValid("11", "2026", new Date("2026-12-01T04:00:00Z"))).toBe(false);
  });
});

describe("formatação de valores e datas (borda da UI)", () => {
  test("centavos inteiros em reais", async () => {
    const { brl, splitUniqueAmount } = await import("@/lib/format");
    expect(brl(990)).toBe("R$ 9,90");
    expect(brl(2700)).toBe("R$ 27,00");
    expect(brl(128470)).toBe("R$ 1.284,70");
    expect(brl(5)).toBe("R$ 0,05");
    expect(splitUniqueAmount(990, 993)).toEqual(["R$ 9,9", "3"]);
    expect(splitUniqueAmount(990, 1003)).toEqual(["R$ 10,", "03"]);
    expect(splitUniqueAmount(2700, 2742)).toEqual(["R$ 27,", "42"]);
  });

  test("validade em São Paulo com hoje/amanhã", async () => {
    const { dateTimeSP, validUntilSP } = await import("@/lib/format");
    const now = new Date("2026-11-18T17:56:00Z");
    expect(dateTimeSP(now)).toBe("18/11/2026 às 14:56");
    expect(validUntilSP(new Date("2026-11-19T17:52:00Z"), now)).toBe("amanhã, 19/11 às 14:52");
    expect(validUntilSP(new Date("2026-11-18T20:00:00Z"), now)).toBe("hoje, 18/11 às 17:00");
  });
});
