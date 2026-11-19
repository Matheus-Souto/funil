import fc from "fast-check";
import { log, redact } from "@/lib/log";

type Rec = Record<string, unknown>;

test("redact remove campos de cartão e PAN em texto", () => {
  const out = redact({
    creditCard: { number: "4444444444444444", ccv: "123" },
    msg: "cartão 4444 4444 4444 4444 recusado",
    name: "Ana",
  }) as Rec;
  expect(JSON.stringify(out)).not.toMatch(/4444|123/);
  expect(out.name).toBe("Ana");
});

test("redact troca valores de chaves sensíveis por [redacted]", () => {
  const out = redact({ CVV: "1", cardNumber: 1, expiryMonth: "12", expiryYear: "2030", card: { x: 1 }, ok: 1 }) as Rec;
  expect(out).toEqual({
    CVV: "[redacted]",
    cardNumber: "[redacted]",
    expiryMonth: "[redacted]",
    expiryYear: "[redacted]",
    card: "[redacted]",
    ok: 1,
  });
});

test("redact pega PAN com separadores múltiplos ou diferentes", () => {
  for (const pan of [
    "4444  4444 4444 4444",
    "4444 - 4444 - 4444 - 4444",
    "4444\t4444\t4444\t4444",
    "4444.4444.4444.4444",
    "4444\u00a04444\u00a04444\u00a04444",
    "4444 4444\n4444 4444",
  ]) {
    expect(redact(`cartão ${pan} fim`)).toBe("cartão [redacted] fim");
  }
});

test("redact preserva textos normais, trata ciclos, Error e Date", () => {
  expect(redact("pedido 123 total 4500")).toBe("pedido 123 total 4500");
  const a: Rec = { n: 1 };
  a.self = a;
  expect((redact(a) as Rec).self).toBe("[circular]");
  const e = redact(new Error("falha 4111-1111-1111-1111")) as Rec;
  expect(e.message).toBe("falha [redacted]");
  expect(redact(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
});

const digits = (n: number) => fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n }).map((d) => d.join(""));
const separator = fc.stringMatching(/^[ \t.\n\u00a0-]{1,3}$/);
const pan = fc
  .tuple(fc.integer({ min: 13, max: 19 }), fc.constantFrom("none", "mixed"))
  .chain(([n, kind]) =>
    fc
      .tuple(digits(n), fc.array(kind === "none" ? fc.constant("") : separator, { minLength: n, maxLength: n }))
      .map(([d, seps]) => [...d].map((c, i) => (i < n - 1 ? c + seps[i] : c)).join("")),
  );
const noDigitText = fc.string().map((s) => s.replace(/\d/g, "x"));
const wrapped = fc
  .tuple(noDigitText, pan, noDigitText)
  .map(([a, p, b]) => ({ p, text: `${a} ${p} ${b}` }));

test("propriedade: PAN gerado nunca sobrevive ao redact (texto, objetos e arrays aninhados)", () => {
  fc.assert(
    fc.property(wrapped, fc.integer({ min: 0, max: 3 }), ({ p, text }, shape) => {
      const input =
        shape === 0 ? text : shape === 1 ? { a: { b: [text] } } : shape === 2 ? [[{ k: text }]] : { msg: text, n: [{ deep: [text] }] };
      const json = JSON.stringify(redact(input));
      expect(json).not.toContain(p);
      expect(json.replace(/(\\n|\\t|[ .\u00a0-])/g, "")).not.toMatch(/\d{13}/);
    }),
  );
});

test("log escreve JSON em stdout já redigido", () => {
  const lines: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    log.info("cobrança", { card: { number: "4444444444444444" }, id: "p1" });
  } finally {
    process.stdout.write = orig;
  }
  const row = JSON.parse(lines.join(""));
  expect(row.level).toBe("info");
  expect(row.msg).toBe("cobrança");
  expect(row.data).toEqual({ card: "[redacted]", id: "p1" });
  expect(lines.join("")).not.toContain("4444");
});

test("hash sha256 em hex (ex.: emailHash da auditoria) não é mutilado por ter 13+ dígitos seguidos", () => {
  const h = "c3f33f3d2f3c7750cc85d2911851444941e0672c8a9c085d4759a0220784ed9d";
  expect(redact({ emailHash: h, note: `hash ${h}` })).toEqual({ emailHash: h, note: "hash c3f33f3d2f3c7750cc85d[redacted]e0672c8a9c085d4759a0220784ed9d" });
  // PAN continua mascarado em qualquer outro texto, inclusive colado em letras.
  expect(redact("a4111111111111111b")).toBe("a[redacted]b");
});
