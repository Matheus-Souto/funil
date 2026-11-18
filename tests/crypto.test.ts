import fc from "fast-check";
import { createSealer, open, randomToken, seal, sha256, timingSafeEqualStr } from "@/lib/crypto";

test("seal/open ida e volta", () => {
  const s = seal("chave-asaas");
  expect(s.startsWith("v1.")).toBe(true);
  expect(s).not.toContain("chave-asaas");
  expect(open(s)).toBe("chave-asaas");
});

test("open recusa texto adulterado", () => {
  const s = seal("x");
  expect(() => open(s.slice(0, -2) + "AA")).toThrow();
});

test("open recusa formato inválido e outra chave", () => {
  expect(() => open("lixo")).toThrow();
  expect(() => open("v2.a.b.c")).toThrow();
  const outra = createSealer("outra-chave-com-pelo-menos-32-caracteres!!");
  expect(() => outra.open(seal("x"))).toThrow();
});

test("seal usa iv aleatório (mesmo texto, selos diferentes)", () => {
  expect(seal("x")).not.toBe(seal("x"));
  expect(seal("x").split(".")).toHaveLength(4);
});

test("propriedade: seal/open ida e volta para qualquer string", () => {
  const sealer = createSealer("x".repeat(32));
  fc.assert(
    fc.property(fc.oneof(fc.string({ unit: "binary" }), fc.string({ unit: "grapheme" }), fc.constant("")), (s) => {
      expect(sealer.open(sealer.seal(s))).toBe(s);
    }),
  );
});

test("randomToken, sha256 e timingSafeEqualStr", () => {
  expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(randomToken(8)).toMatch(/^[A-Za-z0-9_-]{11}$/);
  expect(randomToken()).not.toBe(randomToken());
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(timingSafeEqualStr("a", "a")).toBe(true);
  expect(timingSafeEqualStr("a", "b")).toBe(false);
  expect(timingSafeEqualStr("a", "ab")).toBe(false);
});
