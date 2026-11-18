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
const pan = fc
  .tuple(fc.integer({ min: 13, max: 19 }), fc.constantFrom("", " ", "-"))
  .chain(([n, sep]) =>
    digits(n).map((d) => (sep === "" ? d : (d.match(/.{1,4}/g) as string[]).join(sep))),
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
      expect(json.replace(/[ -]/g, "")).not.toMatch(/\d{13}/);
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
