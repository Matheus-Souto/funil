import { describe, expect, test } from "bun:test";
import { whatsappUrl } from "../src/app/admin/(panel)/contatos/whatsapp";

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
