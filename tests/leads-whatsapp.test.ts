import { describe, expect, test } from "bun:test";
import { whatsappUrl } from "../src/app/admin/(panel)/contatos/whatsapp";
import { remindedLabel } from "../src/app/admin/(panel)/contatos/reminded";

describe("whatsappUrl", () => {
  test("celular de 11 dígitos ganha o 55 e usa só os dígitos", () => {
    expect(whatsappUrl("11987654321")).toBe("https://wa.me/5511987654321");
    expect(whatsappUrl("(11) 98765-4321 <b>x</b>")).toBe("https://wa.me/5511987654321");
  });
  test("fixo de 10 dígitos ganha o 55; já com o 55 não duplica", () => {
    expect(whatsappUrl("1134567890")).toBe("https://wa.me/551134567890");
    expect(whatsappUrl("5511987654321")).toBe("https://wa.me/5511987654321");
  });
  test("vazio ou fora do tamanho não vira link", () => {
    expect(whatsappUrl(null)).toBeNull();
    expect(whatsappUrl("")).toBeNull();
    expect(whatsappUrl("12345")).toBeNull();
    expect(whatsappUrl("441234567890123")).toBeNull();
  });
});

describe("remindedLabel (Contatos)", () => {
  // 21/11 12:00 em São Paulo (15:00 UTC).
  const now = new Date("2026-11-21T15:00:00Z");
  test("hoje e ontem sem o \"em\"; data absoluta com \"em\" e o formato do shortWhenSP", () => {
    expect(remindedLabel(new Date("2026-11-21T17:30:00Z"), now)).toBe("Lembrete enviado hoje, 14:30");
    expect(remindedLabel(new Date("2026-11-20T17:30:00Z"), now)).toBe("Lembrete enviado ontem, 14:30");
    expect(remindedLabel(new Date("2026-11-18T17:30:00Z"), now)).toBe("Lembrete enviado em 18/11, 14:30");
  });
});
