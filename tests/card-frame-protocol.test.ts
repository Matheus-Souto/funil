// Protocolo postMessage entre o checkout e o iframe do cartão: validação à mão, objeto novo só com as chaves do tipo.
import { describe, expect, test } from "bun:test";
import { CARD_MSG_PREFIX, parseFrameMsg, parseParentMsg } from "@/lib/card-frame/protocol";

const P = CARD_MSG_PREFIX;
const pay = { t: `${P}pay`, id: "a1", orderPublicId: "ord_1", ticket: "tk", buyerCpf: "12345678901" };

describe("parseParentMsg", () => {
  test("prefixo", () => expect(CARD_MSG_PREFIX).toBe("funil-card:"));

  test("tipos válidos passam", () => {
    expect(parseParentMsg({ t: `${P}config`, totalCents: 1000, maxInstallments: 3 })).toEqual({
      t: `${P}config`,
      totalCents: 1000,
      maxInstallments: 3,
    });
    expect(parseParentMsg({ t: `${P}validate`, id: "x" })).toEqual({ t: `${P}validate`, id: "x" });
    expect(parseParentMsg(pay)).toEqual(pay as never);
  });

  test("não objeto, tipo desconhecido e campo faltando dão null", () => {
    for (const v of [null, undefined, 1, "x", [], { t: "outro" }, { t: `${P}ready` }, { t: `${P}validate` }]) {
      expect(parseParentMsg(v)).toBeNull();
    }
    expect(parseParentMsg({ ...pay, ticket: undefined })).toBeNull();
  });

  test("limites de config", () => {
    const c = (totalCents: unknown, maxInstallments: unknown) =>
      parseParentMsg({ t: `${P}config`, totalCents, maxInstallments });
    expect(c(0, 1)).toBeNull();
    expect(c(100_000_001, 1)).toBeNull();
    expect(c(100_000_000, 12)).not.toBeNull();
    expect(c(10.5, 1)).toBeNull();
    expect(c(100, 0)).toBeNull();
    expect(c(100, 13)).toBeNull();
    expect(c("100", 1)).toBeNull();
  });

  test("limites de strings do pay", () => {
    expect(parseParentMsg({ ...pay, id: "" })).toBeNull();
    expect(parseParentMsg({ ...pay, id: "a".repeat(65) })).toBeNull();
    expect(parseParentMsg({ ...pay, id: "a".repeat(64) })).not.toBeNull();
    expect(parseParentMsg({ ...pay, orderPublicId: "a".repeat(65) })).toBeNull();
    expect(parseParentMsg({ ...pay, ticket: "a".repeat(2049) })).toBeNull();
    expect(parseParentMsg({ ...pay, ticket: "a".repeat(2048) })).not.toBeNull();
    expect(parseParentMsg({ ...pay, buyerCpf: "1234567890" })).toBeNull();
    expect(parseParentMsg({ ...pay, buyerCpf: "123456789012" })).toBeNull();
    expect(parseParentMsg({ ...pay, buyerCpf: "123.456.789-0" })).toBeNull();
    expect(parseParentMsg({ t: `${P}validate`, id: "a".repeat(65) })).toBeNull();
  });

  test("chaves extras (number, cvv, card) somem", () => {
    const out = parseParentMsg({ ...pay, number: "4111111111111111", cvv: "123", card: { n: 1 } });
    expect(out).toEqual(pay as never);
    expect(Object.keys(out as object).sort()).toEqual(Object.keys(pay).sort());
    const v = parseParentMsg({ t: `${P}validate`, id: "x", number: "4111" });
    expect(Object.keys(v as object).sort()).toEqual(["id", "t"]);
  });
});

describe("parseFrameMsg", () => {
  test("ready e height", () => {
    expect(parseFrameMsg({ t: `${P}ready`, number: "4" })).toEqual({ t: `${P}ready` });
    expect(parseFrameMsg({ t: `${P}height`, px: 0 })).toEqual({ t: `${P}height`, px: 0 });
    expect(parseFrameMsg({ t: `${P}height`, px: 4000 })).not.toBeNull();
    for (const px of [-1, 4001, 1.5, "10", undefined]) expect(parseFrameMsg({ t: `${P}height`, px })).toBeNull();
  });

  test("validated", () => {
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: false, fields: ["number", "cvv"], cvv: "1" })).toEqual({
      t: `${P}validated`,
      id: "x",
      ok: false,
      fields: ["number", "cvv"],
    });
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: "yes", fields: [] })).toBeNull();
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: true, fields: Array(21).fill("a") })).toBeNull();
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: true, fields: Array(20).fill("a") })).not.toBeNull();
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: true, fields: ["a".repeat(65)] })).toBeNull();
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: true, fields: [1] })).toBeNull();
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: true })).toBeNull();
  });

  test("result mínimo e completo", () => {
    expect(parseFrameMsg({ t: `${P}result`, id: "x", status: "approved", number: "4111" })).toEqual({
      t: `${P}result`,
      id: "x",
      status: "approved",
    });
    const full = {
      t: `${P}result`,
      id: "x",
      status: "declined",
      message: "Recusado",
      last4: "1234",
      fields: [["a", "b"], []],
      captcha: true,
      ticketExpired: false,
    };
    expect(parseFrameMsg({ ...full, cvv: "123" })).toEqual(full as never);
  });

  test("result: status, last4, message e fields", () => {
    const r = (extra: object) => parseFrameMsg({ t: `${P}result`, id: "x", status: "error", ...extra });
    for (const s of ["approved", "declined", "unknown", "unavailable", "error"]) {
      expect(parseFrameMsg({ t: `${P}result`, id: "x", status: s })).not.toBeNull();
    }
    expect(r({ status: "paid" })).toBeNull();
    expect(r({ last4: "12345" })).toBeNull();
    expect(r({ last4: "123" })).toBeNull();
    expect(r({ last4: "12a4" })).toBeNull();
    expect(r({ message: "a".repeat(300) })).not.toBeNull();
    expect(r({ message: "a".repeat(301) })).toBeNull();
    expect(r({ fields: Array(21).fill([]) })).toBeNull();
    expect(r({ fields: [Array(6).fill("a")] })).toBeNull();
    expect(r({ fields: [["a".repeat(65)]] })).toBeNull();
    expect(r({ fields: ["a"] })).toBeNull();
    expect(r({ captcha: "1" })).toBeNull();
    expect(r({ ticketExpired: 1 })).toBeNull();
  });

  test("opcional inválido invalida a mensagem inteira, mesmo com o resto válido", () => {
    expect(parseFrameMsg({ t: `${P}result`, id: "x", status: "approved", last4: "12345" })).toBeNull();
  });

  test("tipo desconhecido e mensagens do pai não passam como do frame", () => {
    expect(parseFrameMsg({ t: "x" })).toBeNull();
    expect(parseFrameMsg({ t: `${P}validate`, id: "x" })).toBeNull();
    expect(parseFrameMsg(null)).toBeNull();
    expect(parseParentMsg({ t: `${P}ready` })).toBeNull();
  });
});

describe("endurecimento", () => {
  test("__proto__ como chave própria é inerte", () => {
    expect(parseFrameMsg(JSON.parse('{"__proto__":{"t":"funil-card:ready"}}'))).toBeNull();
    expect(parseParentMsg(JSON.parse(`{"__proto__":{"t":"${P}validate","id":"x"}}`))).toBeNull();
    const out = parseFrameMsg(JSON.parse(`{"t":"${P}ready","__proto__":{"x":1}}`));
    expect(out).toEqual({ t: `${P}ready` });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out as object)).toEqual(["t"]);
  });

  test("NaN e Infinity em config e height", () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(parseParentMsg({ t: `${P}config`, totalCents: n, maxInstallments: 1 })).toBeNull();
      expect(parseParentMsg({ t: `${P}config`, totalCents: 100, maxInstallments: n })).toBeNull();
      expect(parseFrameMsg({ t: `${P}height`, px: n })).toBeNull();
    }
  });

  test("-0 vira 0", () => {
    const out = parseFrameMsg({ t: `${P}height`, px: -0 });
    expect(Object.is((out as { px: number }).px, 0)).toBe(true);
  });

  test("array esparso em fields", () => {
    const sparse = ["a", , "b"];
    expect(parseFrameMsg({ t: `${P}validated`, id: "x", ok: true, fields: sparse })).toBeNull();
    expect(parseFrameMsg({ t: `${P}result`, id: "x", status: "error", fields: [["a", , "b"]] })).toBeNull();
    expect(parseFrameMsg({ t: `${P}result`, id: "x", status: "error", fields: [["a"], , ["b"]] })).toBeNull();
  });

  test("new String como id e status não string", () => {
    expect(parseParentMsg({ t: `${P}validate`, id: new String("x") })).toBeNull();
    expect(parseFrameMsg({ t: `${P}result`, id: new String("x"), status: "approved" })).toBeNull();
    expect(parseFrameMsg({ t: `${P}result`, id: "x", status: 1 })).toBeNull();
    expect(parseFrameMsg({ t: `${P}result`, id: "x", status: null })).toBeNull();
    expect(parseFrameMsg({ t: `${P}result`, id: "x", status: new String("approved") })).toBeNull();
  });

  test("Object.prototype poluído não preenche campos nem o tipo", () => {
    const proto = Object.prototype as Record<string, unknown>;
    try {
      proto.status = "approved";
      proto.id = "x";
      proto.t = `${P}result`;
      expect(parseFrameMsg({ t: `${P}result`, id: "x" })).toBeNull();
      expect(parseFrameMsg({})).toBeNull();
      expect(parseParentMsg({})).toBeNull();
      proto.px = 10;
      expect(parseFrameMsg({ t: `${P}height` })).toBeNull();
      proto.message = "herdado";
      expect(parseFrameMsg({ t: `${P}result`, id: "x", status: "error" })).toEqual({
        t: `${P}result`,
        id: "x",
        status: "error",
      });
    } finally {
      for (const k of ["status", "id", "t", "px", "message"]) delete proto[k];
    }
  });

  test("getter instável é lido uma vez só", () => {
    let n = 0;
    const msg = {
      t: `${P}result`,
      id: "x",
      status: "error",
      get message() {
        return n++ === 0 ? "ok" : "a".repeat(999);
      },
    };
    expect(parseFrameMsg(msg)).toEqual({ t: `${P}result`, id: "x", status: "error", message: "ok" });
    expect(n).toBe(1);
  });
});
