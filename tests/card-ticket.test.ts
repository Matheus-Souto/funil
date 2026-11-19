// Bilhete assinado do pedido (app emite, serviço de cartão confere). Sem banco: a chave vem por parâmetro.
import { describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { CARD_TICKET_TTL_MS, issueCardTicket, verifyCardTicket } from "@/lib/payments/card-ticket";

const KEY = "k".repeat(48);
const NOW = new Date("2026-11-19T12:00:00Z");
const t = () => ({ storeId: randomUUID(), orderId: randomUUID(), publicId: "AbC_123-xyz0987654321q" });
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
/** Monta um bilhete com corpo arbitrário e assinatura válida (para testar a validação do corpo). */
const forge = (body: unknown, key = KEY) => {
  const p = b64(JSON.stringify(body));
  return `${p}.${createHmac("sha256", key).update(p).digest("base64url")}`;
};
const exp = (d: Date) => Math.floor(d.getTime() / 1000);

describe("bilhete do pedido", () => {
  test("ida e volta; TTL de 30 minutos", () => {
    const x = t();
    expect(CARD_TICKET_TTL_MS).toBe(30 * 60 * 1000);
    expect(verifyCardTicket(issueCardTicket(x, KEY, NOW), KEY, NOW)).toEqual(x);
    expect(verifyCardTicket(issueCardTicket(x, KEY, NOW), KEY, new Date(NOW.getTime() + CARD_TICKET_TTL_MS - 1000))).toEqual(x);
  });

  test("expirado em now + TTL + 1s é recusado", () => {
    const tk = issueCardTicket(t(), KEY, NOW);
    expect(verifyCardTicket(tk, KEY, new Date(NOW.getTime() + CARD_TICKET_TTL_MS + 1000))).toBeNull();
  });

  test("um caractere trocado no corpo ou na assinatura, ou outra chave → null", () => {
    const tk = issueCardTicket(t(), KEY, NOW);
    const [p, s] = tk.split(".") as [string, string];
    const flip = (v: string, i: number) => v.slice(0, i) + (v[i] === "A" ? "B" : "A") + v.slice(i + 1);
    expect(verifyCardTicket(`${flip(p, 5)}.${s}`, KEY, NOW)).toBeNull();
    expect(verifyCardTicket(`${p}.${flip(s, 5)}`, KEY, NOW)).toBeNull();
    expect(verifyCardTicket(tk, "outra-chave-".repeat(4), NOW)).toBeNull();
  });

  test("vazio, sem ponto, mais de um ponto, JSON inválido, assinatura curta", () => {
    const tk = issueCardTicket(t(), KEY, NOW);
    for (const bad of ["", ".", "semponto", `${tk}.x`, `a.${tk}`, forge("nao-objeto"), `${b64("{nope")}.${createHmac("sha256", KEY).update(b64("{nope")).digest("base64url")}`, `${tk.split(".")[0]}.abc`]) {
      expect(verifyCardTicket(bad, KEY, NOW)).toBeNull();
    }
  });

  test("mais de 2048 caracteres é recusado antes do HMAC", () => {
    const big = "a".repeat(2049);
    expect(verifyCardTicket(`${big}.${big}`, KEY, NOW)).toBeNull();
    expect(verifyCardTicket("a".repeat(2049), KEY, NOW)).toBeNull();
  });

  test("s/o que não são UUID, p fora do formato ou longo demais, e não-string → null", () => {
    const ok = { s: randomUUID(), o: randomUUID(), p: "abc123", e: exp(NOW) + 60 };
    expect(verifyCardTicket(forge(ok), KEY, NOW)).toEqual({ storeId: ok.s, orderId: ok.o, publicId: "abc123" });
    for (const bad of [
      { ...ok, s: "nao-uuid" },
      { ...ok, o: "123" },
      { ...ok, s: 1 },
      { ...ok, p: "" },
      { ...ok, p: "x".repeat(65) },
      { ...ok, p: "tem espaço" },
      { ...ok, p: 5 },
      { ...ok, e: "999999999999" },
      { ...ok, e: 1.5 + exp(NOW) },
      { ...ok, e: Number.NaN },
      { s: ok.s, o: ok.o, p: ok.p },
    ]) {
      expect(verifyCardTicket(forge(bad), KEY, NOW)).toBeNull();
    }
    expect(verifyCardTicket(forge({ ...ok, p: "x".repeat(64) }), KEY, NOW)?.publicId).toBe("x".repeat(64));
  });

  test("vencimento muito no futuro (> now + TTL + 60s) é recusado, mesmo com assinatura válida", () => {
    const base = { s: randomUUID(), o: randomUUID(), p: "abc" };
    const lim = exp(NOW) + CARD_TICKET_TTL_MS / 1000 + 60;
    expect(verifyCardTicket(forge({ ...base, e: lim }), KEY, NOW)).not.toBeNull();
    expect(verifyCardTicket(forge({ ...base, e: lim + 1 }), KEY, NOW)).toBeNull();
    expect(verifyCardTicket(forge({ ...base, e: exp(NOW) - 1 }), KEY, NOW)).toBeNull();
  });

  test("chave vazia nunca emite nem confere", () => {
    expect(() => issueCardTicket(t(), "", NOW)).toThrow();
    expect(verifyCardTicket(forge({ s: randomUUID(), o: randomUUID(), p: "a", e: exp(NOW) + 60 }, ""), "", NOW)).toBeNull();
  });

  test("assinatura só na forma canônica (43 chars base64url): padding, alfabeto padrão e lixo → null", () => {
    const tk = issueCardTicket(t(), KEY, NOW);
    const [p, sig] = tk.split(".") as [string, string];
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyCardTicket(`${p}.${sig}=`, KEY, NOW)).toBeNull();
    expect(verifyCardTicket(`${p}.${sig}==`, KEY, NOW)).toBeNull();
    expect(verifyCardTicket(`${p}.${sig.slice(0, 10)}!!${sig.slice(10)}`, KEY, NOW)).toBeNull();
    expect(verifyCardTicket(`${p}.${sig.slice(0, 10)} ${sig.slice(10)}`, KEY, NOW)).toBeNull();
    // o último caractere carrega só 4 bits úteis: variantes de bits baixos não valem o mesmo bilhete
    const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const variants = [...last].map((c) => `${p}.${sig.slice(0, 42)}${c}`).filter((v) => verifyCardTicket(v, KEY, NOW) !== null);
    expect(variants).toEqual([tk]);
  });

  test("now inválido (NaN) → null", () => {
    const tk = issueCardTicket(t(), KEY, NOW);
    expect(verifyCardTicket(tk, KEY, new Date(Number.NaN))).toBeNull();
  });
});
