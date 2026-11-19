import fc from "fast-check";
import { DrizzleQueryError } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import { errorFields, log, redact } from "@/lib/log";

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

test("hash sha256 só é poupado sob chave *Hash (emailHash, toHash, tokenHash); fora disso é texto comum", () => {
  const h = "c3f33f3d2f3c7750cc85d2911851444941e0672c8a9c085d4759a0220784ed9d";
  expect(redact({ emailHash: h, toHash: h, tokenHash: h })).toEqual({ emailHash: h, toHash: h, tokenHash: h });
  // O mesmo digest fora de uma chave *Hash: a corrida de 13 dígitos é mascarada como sempre.
  expect(redact({ note: h })).toEqual({ note: "c3f33f3d2f3c7750cc85d[redacted]e0672c8a9c085d4759a0220784ed9d" });
  expect(redact(h)).toBe("c3f33f3d2f3c7750cc85d[redacted]e0672c8a9c085d4759a0220784ed9d");
  // Formato de hash não basta: 64 dígitos, PAN repetido ou PAN + zeros são mascarados fora de *Hash.
  for (const v of ["1".repeat(64), "4111111111111111".repeat(4), "4111111111111111" + "0".repeat(48)]) {
    expect(redact(v)).toBe("[redacted]");
    expect(redact({ id: v })).toEqual({ id: "[redacted]" });
  }
  // Sob chave *Hash, só um digest sha256 hex de verdade sobrevive; PAN em texto comum sob *Hash é mascarado.
  expect(redact({ emailHash: "cartão 4111111111111111" })).toEqual({ emailHash: "cartão [redacted]" });
  expect(redact("a4111111111111111b")).toBe("a[redacted]b");
});

const hex = fc.constantFrom(..."0123456789abcdef");
/** Cadeias de 64 caracteres hex/dígitos (o formato de um sha256) com um PAN de 13 a 19 dígitos dentro. */
const panIn64 = fc
  .tuple(fc.integer({ min: 13, max: 19 }), fc.array(hex, { minLength: 64, maxLength: 64 }), fc.boolean())
  .chain(([n, filler, onlyDigits]) =>
    fc.tuple(digits(n), fc.integer({ min: 0, max: 64 - n })).map(([p, at]) => {
      const base = onlyDigits ? filler.map((c) => (/\d/.test(c) ? c : "0")) : filler;
      const chars = [...base];
      chars.splice(at, n, ...p);
      return { p, v: chars.join("") };
    }),
  );

test("propriedade: PAN dentro de 64 caracteres hex/dígitos (formato de sha256) nunca sobrevive fora de chave *Hash", () => {
  fc.assert(
    fc.property(panIn64, fc.constantFrom("id", "note", "msg", "hashes", "value"), ({ p, v }, key) => {
      expect(v).toHaveLength(64);
      for (const out of [redact(v), (redact({ [key]: v }) as Rec)[key], (redact([{ deep: v }]) as Rec[])[0]!.deep]) {
        expect(String(out)).not.toContain(p);
        expect(String(out)).not.toMatch(/\d{13}/);
      }
    }),
  );
});

test("propriedade: UUID sob chave de id (id, orderId, storeId) nunca é corrompido pela máscara", () => {
  fc.assert(
    fc.property(fc.uuid({ version: 4 }), fc.constantFrom("id", "orderId", "storeId", "offerId"), (u, key) => {
      fc.pre(/[a-f]/.test(u));
      expect(redact({ [key]: u })).toEqual({ [key]: u });
      expect(redact({ input: { [key]: u } })).toEqual({ input: { [key]: u } });
    }),
    { numRuns: 2000 },
  );
  // Caso real que a máscara corrompia (16 dígitos entre hífens no meio).
  const u = "9c6b9d0f-8741-4c47-9973-942362319cfc";
  expect(redact({ orderId: u })).toEqual({ orderId: u });
});

test("UUID só é poupado sob chave de id, inteiro, no formato e com letra hex; PAN em formato de UUID é mascarado", () => {
  const u = "9c6b9d0f-8741-4c47-9973-942362319cfc";
  // Fora de chave de id: texto comum, máscara como sempre.
  for (const key of ["note", "msg", "valid", "paid"]) expect(String((redact({ [key]: u }) as Rec)[key])).toContain("[redacted]");
  expect(redact(`pedido ${u}`)).toContain("[redacted]");
  // Sob chave de id, mas não é UUID inteiro, ou só dígitos: mascarado.
  for (const v of ["41111111-1111-4111-8111-111111111111", `${u} 4111111111111111`, "4111111111111111", "4111-1111-1111-1111"]) {
    for (const key of ["id", "orderId"]) {
      const out = String((redact({ [key]: v }) as Rec)[key]);
      expect(out).toContain("[redacted]");
      expect(out).not.toMatch(/4111[\s.-]*1111[\s.-]*1111[\s.-]*1111/);
    }
  }
});

describe("errorFields: identificação de erro para log, sem texto livre", () => {
  const PAN = "4444444444444444";
  const HOLDER = "TITULAR ERRO SIGMA";
  const leaks = (v: unknown) => JSON.stringify(redact(v));
  const pgError = (code: string) => Object.assign(new Error(`valor ${HOLDER} ${PAN} viola a restrição`), { code, severity: "ERROR", detail: HOLDER });

  test("erro do drizzle com cause do Postgres: nome e SQLSTATE; nada da SQL, dos params nem da mensagem", () => {
    const e = new DrizzleQueryError(`select * from x where nome = $1 and n = $2`, [HOLDER, PAN], pgError("23505"));
    const out = errorFields(e);
    expect(out).toEqual({ errorName: "DrizzleQueryError", sqlState: "23505" });
    expect(leaks(out)).not.toContain(HOLDER);
  });

  test("erro do Postgres direto (severity): SQLSTATE; drizzle com cause de rede: o code da causa", () => {
    expect(errorFields(pgError("40P01"))).toEqual({ errorName: "Error", sqlState: "40P01" });
    const net = Object.assign(new Error(`connect ECONNREFUSED ${HOLDER}`), { code: "ECONNREFUSED" });
    expect(errorFields(new DrizzleQueryError("select 1", [HOLDER], net))).toEqual({ errorName: "DrizzleQueryError", causeCode: "ECONNREFUSED" });
  });

  test("ActionError nosso: code, mensagem e status de details (provider_error do Asaas)", () => {
    const e = new ActionError("provider_error", "Erro no Asaas (HTTP 401)", { status: 401, errorCodes: ["invalid_access_token"] });
    expect(errorFields(e)).toEqual({ errorName: "ActionError", errorCode: "provider_error", errorMessage: "Erro no Asaas (HTTP 401)", status: 401 });
    expect(errorFields(new ActionError("conflict", "Pedido ocupado"))).toEqual({
      errorName: "ActionError",
      errorCode: "conflict",
      errorMessage: "Pedido ocupado",
    });
    // status que não é inteiro HTTP é ignorado; a mensagem passa pela máscara do log
    const odd = errorFields(new ActionError("provider_error", `falhou ${PAN}`, { status: "x" }));
    expect(odd.status).toBeUndefined();
    expect(leaks(odd)).not.toContain(PAN);
  });

  test("outros erros: nome, code e cause.code; nunca a mensagem", () => {
    const cause = Object.assign(new Error(`timeout ${HOLDER}`), { code: "ETIMEDOUT" });
    const e = Object.assign(new TypeError(`falhou com ${PAN} ${HOLDER}`, { cause }), { code: "ECONNRESET" });
    expect(errorFields(e)).toEqual({ errorName: "TypeError", errorCode: "ECONNRESET", causeCode: "ETIMEDOUT" });
    expect(errorFields(new Error(`só texto ${HOLDER}`))).toEqual({ errorName: "Error" });
    expect(errorFields(`texto ${HOLDER}`)).toEqual({ errorName: "string" });
    expect(errorFields(null)).toEqual({ errorName: "object" });
  });

  test("code ou nome fora do formato de identificador são descartados", () => {
    const e = Object.assign(new Error("x"), { code: `${HOLDER} ${PAN}`, cause: { code: "a b" } });
    e.name = `Nome com espaço ${HOLDER}`;
    expect(errorFields(e)).toEqual({ errorName: "Error" });
    expect(errorFields(Object.assign(new Error("x"), { code: 42 }))).toEqual({ errorName: "Error" });
  });
});
