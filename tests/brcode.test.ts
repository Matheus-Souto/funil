import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { buildPixBrCode, sanitizeText } from "@/lib/payments/brcode";

// Referência independente: CRC16/CCITT-FALSE bit a bit (poly 0x1021, init 0xFFFF, sem reflexão, sem xorout).
function refCrc(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Lê TLV (ID de 2, tamanho de 2 dígitos); lança se a estrutura não fechar exatamente. */
function parseTlv(s: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || Number.isNaN(len)) throw new Error("tlv inválido");
    const value = s.slice(i + 4, i + 4 + len);
    if (value.length !== len) throw new Error("tlv truncado");
    out.push([id, value]);
    i += 4 + len;
  }
  return out;
}

function parse(payload: string) {
  const top = parseTlv(payload);
  const f = new Map(top);
  const mai = parseTlv(f.get("26") ?? "");
  const add = parseTlv(f.get("62") ?? "");
  return {
    ids: top.map(([id]) => id),
    gui: mai.find(([id]) => id === "00")?.[1],
    key: mai.find(([id]) => id === "01")?.[1],
    mcc: f.get("52"),
    currency: f.get("53"),
    amount: f.get("54"),
    country: f.get("58"),
    name: f.get("59"),
    city: f.get("60"),
    txid: add.find(([id]) => id === "05")?.[1],
    crc: f.get("63"),
  };
}

describe("CRC de referência", () => {
  test('vetor publicado: "123456789" -> 29B1', () => {
    expect(refCrc("123456789")).toBe("29B1");
  });
});

describe("buildPixBrCode", () => {
  const base = { key: "teste@exemplo.com", name: "Fulano", city: "SAO PAULO", amountCents: 993, txid: "PED123" };

  test("estrutura, campos e CRC do vetor fixo", () => {
    const p = buildPixBrCode(base);
    expect(p.endsWith("6304FA9D")).toBe(true);
    expect(p).toBe(
      "00020126390014br.gov.bcb.pix0117teste@exemplo.com52040000530398654049.935802BR5906Fulano6009SAO PAULO62100506PED1236304" +
        refCrc(
          "00020126390014br.gov.bcb.pix0117teste@exemplo.com52040000530398654049.935802BR5906Fulano6009SAO PAULO62100506PED1236304",
        ),
    );
    const r = parse(p);
    expect(r.ids).toEqual(["00", "26", "52", "53", "54", "58", "59", "60", "62", "63"]);
    expect(r).toMatchObject({ gui: "br.gov.bcb.pix", key: "teste@exemplo.com", mcc: "0000", currency: "986", amount: "9.93", country: "BR", name: "Fulano", city: "SAO PAULO", txid: "PED123" });
    expect(p.slice(-8, -4)).toBe("6304");
    expect(r.crc).toBe(refCrc(p.slice(0, -4)));
  });

  test("remove acentos de nome e cidade", () => {
    const r = parse(buildPixBrCode({ ...base, name: "João da Conceição", city: "São Luís" }));
    expect(r.name).toBe("Joao da Conceicao");
    expect(r.city).toBe("Sao Luis");
  });

  test("valor com duas casas e txid saneado", () => {
    expect(parse(buildPixBrCode({ ...base, amountCents: 100000 })).amount).toBe("1000.00");
    expect(parse(buildPixBrCode({ ...base, amountCents: 5 })).amount).toBe("0.05");
    expect(parse(buildPixBrCode({ ...base, txid: "ab-12_cd" })).txid).toBe("ab12cd");
    expect(parse(buildPixBrCode({ ...base, txid: "A".repeat(40) })).txid).toBe("A".repeat(25));
  });

  test("entradas inválidas são recusadas", () => {
    expect(() => buildPixBrCode({ ...base, amountCents: 0 })).toThrow();
    expect(() => buildPixBrCode({ ...base, amountCents: 1.5 })).toThrow();
    expect(() => buildPixBrCode({ ...base, key: "" })).toThrow();
    expect(() => buildPixBrCode({ ...base, key: "x".repeat(78) })).toThrow();
  });

  test("propriedade: sempre decodifica nos mesmos campos e o CRC confere", () => {
    const asciiKey = fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789@.-+_"), minLength: 1, maxLength: 77 });
    fc.assert(
      fc.property(asciiKey, fc.string({ maxLength: 60 }), fc.string({ maxLength: 40 }), fc.integer({ min: 1, max: 99_999_999 }), fc.string({ maxLength: 40 }), (key, name, city, amountCents, txid) => {
        const p = buildPixBrCode({ key, name, city, amountCents, txid });
        const r = parse(p);
        expect(r.key).toBe(key);
        expect(r.amount).toBe(`${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, "0")}`);
        expect(r.crc).toBe(refCrc(p.slice(0, -4)));
        expect(r.name).toBe(sanitizeText(name, 25, "LOJA"));
        expect(r.city).toBe(sanitizeText(city, 15, "BRASIL"));
        expect(r.name!.length).toBeLessThanOrEqual(25);
        expect(r.city!.length).toBeLessThanOrEqual(15);
        expect(r.name!.length).toBeGreaterThan(0);
        expect(/^[\x20-\x7e]+$/.test(r.name! + r.city!)).toBe(true);
        expect(r.txid!.length).toBeLessThanOrEqual(25);
        expect(/^[A-Za-z0-9*]+$/.test(r.txid!)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test("propriedade: nomes acentuados viram ASCII dentro dos limites", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(..."áàâãäéèêíïóôõöúüçñÁÃÉÇÕ abc XYZ-"), maxLength: 50 }), (s) => {
        const out = sanitizeText(s, 25, "LOJA");
        expect(/^[\x20-\x7e]+$/.test(out)).toBe(true);
        expect(out.length).toBeLessThanOrEqual(25);
      }),
    );
  });
});
