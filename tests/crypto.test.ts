import fc from "fast-check";
import { createAsaasSealer, createSealer, open, randomToken, seal, sha256, timingSafeEqualStr } from "@/lib/crypto";

test("seal/open ida e volta", () => {
  const s = seal("chave-asaas");
  expect(s.startsWith("v1.")).toBe(true);
  expect(s).not.toContain("chave-asaas");
  expect(open(s)).toBe("chave-asaas");
});

// Adultera de forma determinística: inverte o bit 0 do byte 0 da parte `index` (iv=1, tag=2, ciphertext=3).
function tamper(sealed: string, index: 1 | 2 | 3): string {
  const parts = sealed.split(".");
  const bytes = Buffer.from(parts[index], "base64url");
  bytes[0] ^= 1;
  parts[index] = bytes.toString("base64url");
  return parts.join(".");
}

test.each([
  ["iv", 1],
  ["tag", 2],
  ["ciphertext", 3],
] as const)("open recusa %s adulterado", (_nome, index) => {
  const s = seal("x");
  expect(tamper(s, index)).not.toBe(s);
  expect(() => open(tamper(s, index))).toThrow();
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

describe("selo próprio do Asaas (a1)", () => {
  const chave = "a".repeat(32);

  test("ida e volta a1 e formato", () => {
    const asaas = createAsaasSealer(chave);
    const s = asaas.seal("chave-asaas");
    expect(s.startsWith("a1.")).toBe(true);
    expect(s.split(".")).toHaveLength(4);
    expect(s).not.toContain("chave-asaas");
    expect(asaas.open(s)).toBe("chave-asaas");
  });

  test("a1 aberto com outra chave lança erro", () => {
    const s = createAsaasSealer(chave).seal("x");
    expect(() => createAsaasSealer("b".repeat(32)).open(s)).toThrow();
  });

  test("a1 e v1 não se abrem um pelo outro, mesmo com o mesmo segredo", () => {
    const asaas = createAsaasSealer(chave);
    const padrao = createSealer(chave);
    expect(() => padrao.open(asaas.seal("x"))).toThrow("Valor selado inválido");
    expect(() => asaas.open(padrao.seal("x"))).toThrow("Valor selado inválido");
    // Mesmo trocando o prefixo, a chave derivada (info do HKDF) é outra.
    expect(() => asaas.open(padrao.seal("x").replace(/^v1\./, "a1."))).toThrow();
  });

  test("createSealer aceita info e versão próprias; o padrão segue v1", () => {
    const s = createSealer(chave, { info: "funil:seal:outro:v1", version: "z9" });
    expect(s.seal("x").startsWith("z9.")).toBe(true);
    expect(createSealer(chave).seal("x").startsWith("v1.")).toBe(true);
    expect(() => createSealer(chave).open(s.seal("x").replace(/^z9\./, "v1."))).toThrow();
  });
});
