import { describe, expect, test } from "bun:test";
import { META_EVENT_ID_RE, fbcFromFbclid, parseTouch, trackingSnippet } from "@/lib/tracking/touch";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

describe("parseTouch (entrada do checkout)", () => {
  test("?utm_source=ig&ref=joao&fbclid=abc preenche last e ref; fbc derivado começa com fb.1.", () => {
    const t = parseTouch(new URL("https://loja.example/c/x?utm_source=ig&ref=joao&fbclid=abc"), {}, 1_700_000_000_000);
    expect(t.last).toEqual({ utm_source: "ig", fbclid: "abc" });
    expect(t.first).toBeNull();
    expect(t.ref).toBe("joao");
    expect(t.fbc).toBe("fb.1.1700000000000.abc");
    expect(t.fbc!.startsWith("fb.1.")).toBe(true);
    expect(t.fbp).toBeUndefined();
  });

  test("cookies _fbc/_fbp prevalecem sobre o fbclid", () => {
    const t = parseTouch(new URL("https://loja.example/c/x?fbclid=abc"), { _fbc: "fb.1.1.cookie", _fbp: "fb.1.2.3" });
    expect(t.fbc).toBe("fb.1.1.cookie");
    expect(t.fbp).toBe("fb.1.2.3");
  });

  test("ft (primeiro toque em base64url) vira first; chaves desconhecidas e valores longos são descartados", () => {
    const ft = b64({ utm_source: "google", utm_campaign: "natal", ref: "ana", lixo: "x", utm_term: "y".repeat(600) });
    const t = parseTouch(new URL(`https://loja.example/c/x?utm_source=ig&ft=${ft}`), {});
    expect(t.first).toEqual({ utm_source: "google", utm_campaign: "natal", ref: "ana", utm_term: "y".repeat(500) });
    expect(t.last).toEqual({ utm_source: "ig" });
  });

  test("ft inválido ou maior que 1 KB é ignorado; sem parâmetros: toque vazio", () => {
    expect(parseTouch(new URL("https://loja.example/c/x?ft=%%%"), {}).first).toBeNull();
    expect(parseTouch(new URL(`https://loja.example/c/x?ft=${b64(["a"])}`), {}).first).toBeNull();
    expect(parseTouch(new URL(`https://loja.example/c/x?ft=${b64({ utm_source: "z".repeat(1200) })}`), {}).first).toBeNull();
    const empty = parseTouch(new URL("https://loja.example/c/x"), {});
    expect(empty).toEqual({ first: null, last: null });
  });

  test("ref só com caracteres seguros e até 100", () => {
    expect(parseTouch(new URL("https://loja.example/c/x?ref=" + "a".repeat(150)), {}).ref).toBe("a".repeat(100));
    expect(parseTouch(new URL("https://loja.example/c/x?ref=%20"), {}).ref).toBeUndefined();
  });

  test("fbcFromFbclid", () => {
    expect(fbcFromFbclid("abc", 5)).toBe("fb.1.5.abc");
    expect(fbcFromFbclid(undefined, 5)).toBeUndefined();
  });
  test("cupom: entra em maiúsculas pela regra do código; valor fora da regra é descartado (URL e primeiro toque)", () => {
    expect(parseTouch(new URL("https://loja.example/c/x?cupom=kids_10-a"), {}).last).toEqual({ cupom: "KIDS_10-A" });
    for (const bad of ["ab", "KIDS%2010", "%3Cscript%3E", "A".repeat(33)]) {
      expect(parseTouch(new URL(`https://loja.example/c/x?cupom=${bad}`), {}).last).toBeNull();
    }
    const ft = Buffer.from(JSON.stringify({ cupom: "kids10", utm_source: "ig" })).toString("base64url");
    expect(parseTouch(new URL(`https://loja.example/c/x?ft=${ft}`), {}).first).toEqual({ cupom: "KIDS10", utm_source: "ig" });
    const bad = Buffer.from(JSON.stringify({ cupom: "a b" })).toString("base64url");
    expect(parseTouch(new URL(`https://loja.example/c/x?ft=${bad}`), {}).first).toBeNull();
  });
});

test("event id do Meta: UUID ou 16-64 caracteres url-safe", () => {
  expect(META_EVENT_ID_RE.test("6f1c1f5e-3c55-4a43-9a7b-0d6a3f1f2b11")).toBe(true);
  expect(META_EVENT_ID_RE.test("a".repeat(16))).toBe(true);
  expect(META_EVENT_ID_RE.test("a".repeat(15))).toBe(false);
  expect(META_EVENT_ID_RE.test("a".repeat(65))).toBe(false);
  expect(META_EVENT_ID_RE.test("purchase:abcdefghijklmnop")).toBe(false);
});

test("trackingSnippet: script do t.js com o host do checkout", () => {
  expect(trackingSnippet("https://pay.loja.com.br")).toBe('<script src="https://pay.loja.com.br/t.js" data-checkout="pay.loja.com.br" defer></script>');
  expect(trackingSnippet("http://127.0.0.1:3000/")).toBe('<script src="http://127.0.0.1:3000/t.js" data-checkout="127.0.0.1:3000" defer></script>');

});
