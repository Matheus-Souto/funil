// `?cupom=` (A4, D9): a página calcula a prévia inicial no servidor por `initialCoupon` (só `runAction`). Cupom ruim na
// URL nunca bloqueia a compra: o campo abre calmo com a mensagem neutra, ou fica recolhido se não há código.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "@/lib/actions/all";
import { initialCoupon } from "@/app/c/[slug]/initial-coupon";
import { createOffer } from "@/lib/catalog/offers";
import { runAction } from "@/lib/actions/core";
import { createCoupon } from "@/lib/coupons/actions";
import { parseTouch } from "@/lib/tracking/touch";
import { createTestDb, seedProduct, seedStore, type TestDb } from "./db";
import { panelCall } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let ipSeq = 0;
const nextIp = () => `198.19.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

async function shop() {
  const { storeId } = await seedStore("Cupom URL");
  const call = panelCall(storeId);
  const p = await seedProduct(storeId, "Almanaque PDF");
  const slug = `u-${Math.random().toString(36).slice(2, 10)}`;
  await runAction(createOffer, call, { slug, name: "Almanaque", productIds: [p.id], priceCents: 990, methods: ["pix"], pixMode: "manual" });
  await runAction(createCoupon, call, { code: "KIDS10", kind: "percent", percentBp: 1000 });
  return { storeId, slug };
}

describe("initialCoupon (?cupom=)", () => {
  test("cupom válido na URL abre aplicado, com desconto e total", async () => {
    const s = await shop();
    expect(await initialCoupon(s.storeId, s.slug, "kids10", nextIp())).toEqual({
      kind: "applied",
      code: "KIDS10",
      discountCents: 99,
      totalCents: 891,
      withBump: false,
    });
  });

  test("cupom inválido: campo aberto com o código e a mensagem neutra (a compra segue)", async () => {
    const s = await shop();
    expect(await initialCoupon(s.storeId, s.slug, "NAOEXISTE", nextIp())).toEqual({ kind: "open", code: "NAOEXISTE", message: "Cupom inválido ou vencido" });
  });

  test("sem ?cupom=, vazio ou espaços: nada (recolhido), sem consumir o limite", async () => {
    const s = await shop();
    expect(await initialCoupon(s.storeId, s.slug, undefined, nextIp())).toBeNull();
    expect(await initialCoupon(s.storeId, s.slug, "   ", nextIp())).toBeNull();
  });

  test("valor repetido na URL (?cupom=a&cupom=b): usa o primeiro", async () => {
    const s = await shop();
    expect(await initialCoupon(s.storeId, s.slug, ["kids10", "outro"], nextIp())).toMatchObject({ kind: "applied", code: "KIDS10" });
  });

  test("código longo demais: campo aberto cortado, sem chamar a ação e sem erro", async () => {
    const s = await shop();
    const r = await initialCoupon(s.storeId, s.slug, "A".repeat(200), nextIp());
    expect(r).toMatchObject({ kind: "open", message: "Cupom inválido ou vencido" });
    expect(r?.kind === "open" ? r.code.length : 0).toBe(64);
  });

  test("limite por IP estourado: não quebra a página, o campo abre com a mensagem do limite", async () => {
    const s = await shop();
    const ip = nextIp();
    for (let i = 0; i < 20; i++) await initialCoupon(s.storeId, s.slug, "KIDS10", ip);
    const r = await initialCoupon(s.storeId, s.slug, "KIDS10", ip);
    expect(r).toMatchObject({ kind: "open", code: "KIDS10" });
    expect(r?.kind === "open" ? r.message : null).toMatch(/Muitas tentativas/);
  });

  test("oferta inexistente: não quebra, o campo abre com a mensagem neutra", async () => {
    const s = await shop();
    expect(await initialCoupon(s.storeId, "nao-existe", "KIDS10", nextIp())).toMatchObject({ kind: "open" });
  });
});

describe("toque: o código do cupom entra como `cupom`", () => {
  test("?cupom= vai para o último toque (não é dado pessoal)", () => {
    const { last } = parseTouch(new URL("/c/x?cupom=KIDS10&utm_source=meta", "http://c.local"), {});
    expect(last).toEqual({ utm_source: "meta", cupom: "KIDS10" });
  });
});
