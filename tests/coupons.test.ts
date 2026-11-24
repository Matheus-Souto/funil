// Cupom (A1): regra pura do desconto, normalização do código, isolamento por loja (RLS), FKs compostas e o check do
// pedido (`total = subtotal - desconto`); ações do painel (A2); cupom no pedido, prévia e checkout.start (A3).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import "@/lib/actions/all";
import { ActionError, runAction } from "@/lib/actions/core";
import { registry } from "@/lib/actions/registry";
import { installmentsFor, previewErrorResult, renewCardTicket, startCheckout } from "@/lib/checkout";
import { BUMP_UNAVAILABLE } from "@/lib/orders/create";
import { verifyCardTicket } from "@/lib/payments/card-ticket";
import { createOffer } from "@/lib/catalog/offers";
import { archiveCoupon, createCoupon, getCoupon, listCoupons, updateCoupon } from "@/lib/coupons/actions";
import { ownerDb, withStore } from "@/lib/db/client";
import { auditLog, coupon, couponOffer, offer, orderItem, orders, rateLimit } from "@/lib/db/schema";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { savePixManual } from "@/lib/payments/manual";
import { COUPON, computeDiscount, normalizeCode } from "@/lib/coupons/rules";
import { HEAVY_TEST_MS, createTestDb, seedProduct, seedStore, type TestDb } from "./db";
import type { FakeAsaas } from "./fakes/asaas";
import { newAsaasOrder, createFakeAsaas, seedAsaasStore } from "./asaas-helpers";
import { panelCall, seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const pct = (percentBp: number, appliesTo: "main" | "all" = "main") => ({ kind: "percent" as const, percentBp, amountCents: null, appliesTo });
const fixed = (amountCents: number, appliesTo: "main" | "all" = "main") => ({ kind: "fixed" as const, percentBp: null, amountCents, appliesTo });

describe("computeDiscount", () => {
  test("percentual só no principal: 10% de 990 = 99", () => {
    expect(computeDiscount(pct(1000), { mainCents: 990, bumpCents: 0 })).toEqual({ discountCents: 99, mainDiscountCents: 99, bumpDiscountCents: 0 });
  });

  test("com bump e applies_to main o bump não entra na base", () => {
    expect(computeDiscount(pct(1000), { mainCents: 990, bumpCents: 1710 })).toEqual({ discountCents: 99, mainDiscountCents: 99, bumpDiscountCents: 0 });
  });

  test("applies_to all: 10% de 990 + 1710 = 270 (99 + 171)", () => {
    expect(computeDiscount(pct(1000, "all"), { mainCents: 990, bumpCents: 1710 })).toEqual({
      discountCents: 270,
      mainDiscountCents: 99,
      bumpDiscountCents: 171,
    });
  });

  test("percentual arredonda para baixo", () => {
    expect(computeDiscount(pct(1000), { mainCents: 995, bumpCents: 0 }).discountCents).toBe(99);
  });

  test("fixo de 2000 em 990 corta para 490 (total 500)", () => {
    const r = computeDiscount(fixed(2000), { mainCents: 990, bumpCents: 0 });
    expect(r.discountCents).toBe(490);
    expect(990 - r.discountCents).toBe(COUPON.minTotalCents);
  });

  test("percentual de 9000 bp em 600 deixa o total em 500", () => {
    const r = computeDiscount(pct(9000), { mainCents: 600, bumpCents: 0 });
    expect(r.discountCents).toBe(100);
    expect(600 - r.discountCents).toBe(500);
  });

  test("o piso vale sobre o total do pedido (principal + bump), não só sobre a base", () => {
    // Base 600 (principal); o bump de 1710 fica fora do desconto, então o total 2310 comporta o desconto cheio de 540.
    expect(computeDiscount(pct(9000), { mainCents: 600, bumpCents: 1710 }).discountCents).toBe(540);
  });

  test("com applies_to all o desconto é rateado na proporção da base, com a sobra no principal", () => {
    const r = computeDiscount(fixed(100, "all"), { mainCents: 500, bumpCents: 1000 });
    expect(r).toEqual({ discountCents: 100, mainDiscountCents: 34, bumpDiscountCents: 66 });
  });

  test("total já no piso ou abaixo: desconto zero, nunca negativo", () => {
    for (const main of [0, 100, 500]) {
      const r = computeDiscount(fixed(300), { mainCents: main, bumpCents: 0 });
      expect(r).toEqual({ discountCents: 0, mainDiscountCents: 0, bumpDiscountCents: 0 });
    }
  });

  test("propriedade: nada negativo, soma das partes = desconto, total >= piso quando o total original já era", () => {
    for (let main = 500; main <= 5000; main += 137) {
      for (const bump of [0, 333, 1710]) {
        for (const c of [pct(1), pct(1000), pct(9000), fixed(1), fixed(777), fixed(100_000)]) {
          for (const appliesTo of ["main", "all"] as const) {
            const r = computeDiscount({ ...c, appliesTo }, { mainCents: main, bumpCents: bump });
            expect(r.discountCents).toBeGreaterThanOrEqual(0);
            expect(r.mainDiscountCents).toBeGreaterThanOrEqual(0);
            expect(r.bumpDiscountCents).toBeGreaterThanOrEqual(0);
            expect(r.mainDiscountCents + r.bumpDiscountCents).toBe(r.discountCents);
            expect(main + bump - r.discountCents).toBeGreaterThanOrEqual(COUPON.minTotalCents);
            expect(r.mainDiscountCents).toBeLessThanOrEqual(main);
            expect(r.bumpDiscountCents).toBeLessThanOrEqual(bump);
          }
        }
      }
    }
  });
});

describe("normalizeCode", () => {
  test("apara e põe em maiúsculas", () => {
    expect(normalizeCode(" kids10 ")).toBe("KIDS10");
  });
  test("recusa curto, com espaço ou com caractere fora de A-Z 0-9 _ -", () => {
    expect(normalizeCode("a")).toBeNull();
    expect(normalizeCode("KIDS 10")).toBeNull();
    expect(normalizeCode("KIDS10<")).toBeNull();
    expect(normalizeCode("A".repeat(33))).toBeNull();
    expect(normalizeCode("")).toBeNull();
  });
  test("aceita _ e - e o limite de 32", () => {
    expect(normalizeCode("kids_10-a")).toBe("KIDS_10-A");
    expect(normalizeCode("a".repeat(32))).toBe("A".repeat(32));
  });
});

describe("tabelas", () => {
  const baseCoupon = (storeId: string, code: string) => ({ storeId, code, kind: "percent", percentBp: 1000 });

  test("cupom de outra loja não aparece (RLS)", async () => {
    const a = await seedStore("A");
    const b = await seedStore("B");
    await withStore(b.storeId, (tx) => tx.insert(coupon).values(baseCoupon(b.storeId, "KIDS10")));
    expect(await withStore(a.storeId, (tx) => tx.select().from(coupon))).toHaveLength(0);
    expect(await withStore(b.storeId, (tx) => tx.select().from(coupon))).toHaveLength(1);
  });

  test("o código é único por loja, mas pode repetir em lojas diferentes", async () => {
    const a = await seedStore("A");
    const b = await seedStore("B");
    await withStore(a.storeId, (tx) => tx.insert(coupon).values(baseCoupon(a.storeId, "UNICO")));
    await withStore(b.storeId, (tx) => tx.insert(coupon).values(baseCoupon(b.storeId, "UNICO")));
    await expect(withStore(a.storeId, (tx) => tx.insert(coupon).values(baseCoupon(a.storeId, "UNICO")))).rejects.toThrow();
  });

  test("checks do cupom: código, tipo/valor, janela, limites", async () => {
    const { storeId } = await seedStore("Checks");
    const ins = (v: Record<string, unknown>) => withStore(storeId, (tx) => tx.insert(coupon).values({ storeId, code: "CHECK1", ...v } as never));
    await expect(ins({ code: "minusc", kind: "percent", percentBp: 1000 })).rejects.toThrow();
    await expect(ins({ kind: "percent", percentBp: 9001 })).rejects.toThrow();
    await expect(ins({ kind: "percent", percentBp: 0 })).rejects.toThrow();
    await expect(ins({ kind: "percent", percentBp: 1000, amountCents: 100 })).rejects.toThrow();
    await expect(ins({ kind: "fixed", amountCents: 0 })).rejects.toThrow();
    await expect(ins({ kind: "fixed", amountCents: 100, percentBp: 1000 })).rejects.toThrow();
    await expect(ins({ kind: "fixed" })).rejects.toThrow();
    await expect(ins({ kind: "outro", percentBp: 1000 })).rejects.toThrow();
    await expect(ins({ kind: "percent", percentBp: 1000, appliesTo: "bump" })).rejects.toThrow();
    await expect(ins({ kind: "percent", percentBp: 1000, maxUses: 0 })).rejects.toThrow();
    const d = new Date("2026-12-01T00:00:00Z");
    await expect(ins({ kind: "percent", percentBp: 1000, startsAt: d, endsAt: d })).rejects.toThrow();
    // Válidos.
    await ins({ code: "OK-PCT", kind: "percent", percentBp: 9000, endsAt: new Date(d.getTime() + 1000), startsAt: d });
    await ins({ code: "OK_FIX", kind: "fixed", amountCents: 100, maxUses: 5, maxPerEmail: null, appliesTo: "all" });
    const [row] = await withStore(storeId, (tx) => tx.select().from(coupon).where(eq(coupon.code, "OK-PCT")));
    expect(row).toMatchObject({ appliesTo: "main", maxPerEmail: 1, active: true, archivedAt: null, maxUses: null });
  });

  test("coupon_offer com oferta de outra loja viola a FK composta", async () => {
    const fake = createFakeAsaas();
    const a = await seedAsaasStore(fake);
    const b = await seedStore("Outra");
    const [c] = await withStore(b.storeId, (tx) => tx.insert(coupon).values(baseCoupon(b.storeId, "FK1")).returning({ id: coupon.id }));
    await expect(
      withStore(b.storeId, (tx) => tx.insert(couponOffer).values({ storeId: b.storeId, couponId: c!.id, offerId: a.offerId })),
    ).rejects.toThrow();
  });

  test("coupon_offer da mesma loja funciona e some junto com o cupom (cascade)", async () => {
    const fake = createFakeAsaas();
    const a = await seedAsaasStore(fake);
    const [c] = await withStore(a.storeId, (tx) => tx.insert(coupon).values(baseCoupon(a.storeId, "FK2")).returning({ id: coupon.id }));
    await withStore(a.storeId, (tx) => tx.insert(couponOffer).values({ storeId: a.storeId, couponId: c!.id, offerId: a.offerId }));
    await expect(
      withStore(a.storeId, (tx) => tx.insert(couponOffer).values({ storeId: a.storeId, couponId: c!.id, offerId: a.offerId })),
    ).rejects.toThrow();
    await t.ownerDb.delete(coupon).where(eq(coupon.id, c!.id));
    expect(await withStore(a.storeId, (tx) => tx.select().from(couponOffer))).toHaveLength(0);
  });
});

describe("pedido com desconto", () => {
  async function shopWithOrder() {
    const fake = createFakeAsaas();
    const shop = await seedAsaasStore(fake, 990);
    const order = await newAsaasOrder(shop.storeId, shop.offerId, `c-${randomUUID()}@example.com`);
    return { shop, order };
  }

  test("pedido antigo (subtotal = total, sem cupom) segue válido e tem desconto 0", async () => {
    const { shop, order } = await shopWithOrder();
    const [row] = await withStore(shop.storeId, (tx) => tx.select().from(orders).where(eq(orders.id, order.id)));
    expect(row!.subtotalCents).toBe(row!.totalCents);
    expect(row).toMatchObject({ discountCents: 0, couponId: null });
  });

  test("total diferente de subtotal - desconto é recusado", async () => {
    const { shop, order } = await shopWithOrder();
    const [c] = await withStore(shop.storeId, (tx) => tx.insert(coupon).values({ storeId: shop.storeId, code: "PED1", kind: "percent", percentBp: 1000 }).returning({ id: coupon.id }));
    const upd = (v: Partial<typeof orders.$inferInsert>) => withStore(shop.storeId, (tx) => tx.update(orders).set(v).where(eq(orders.id, order.id)));
    await expect(upd({ discountCents: 99 })).rejects.toThrow(); // total continua 990
    await expect(upd({ couponId: c!.id })).rejects.toThrow(); // cupom sem desconto
    await expect(upd({ discountCents: -1 })).rejects.toThrow();
    await upd({ couponId: c!.id, discountCents: 99, totalCents: 891 }); // consistente
    await expect(upd({ couponId: null })).rejects.toThrow(); // desconto sem cupom
  });

  test("cupom de outra loja no pedido viola a FK composta", async () => {
    const { shop, order } = await shopWithOrder();
    const other = await seedStore("Outra 2");
    const [c] = await withStore(other.storeId, (tx) => tx.insert(coupon).values({ storeId: other.storeId, code: "PED2", kind: "percent", percentBp: 1000 }).returning({ id: coupon.id }));
    await expect(
      withStore(shop.storeId, (tx) => tx.update(orders).set({ couponId: c!.id, discountCents: 99, totalCents: 891 }).where(eq(orders.id, order.id))),
    ).rejects.toThrow();
  });
});

describe("ações do painel (coupons.*)", () => {
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? e.code : String(e)));
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ActionError);
  const base = { kind: "percent" as const, percentBp: 1000 };

  test("cria, lista, busca, edita e arquiva; o código fica em maiúsculas e os padrões valem", async () => {
    const s = await seedPanelStore("Cupons painel");
    const call = panelCall(s.storeId);
    const created = await runAction(createCoupon, call, { code: " kids10 ", ...base });
    expect(created).toMatchObject({ code: "KIDS10", kind: "percent", percentBp: 1000, amountCents: null, appliesTo: "main", maxPerEmail: 1, maxUses: null, active: true, offerIds: [], uses: 0, archivedAt: null });

    const listed = await runAction(listCoupons, call, {});
    expect(listed.map((c) => c.id)).toEqual([created.id]);
    expect((await runAction(getCoupon, call, { id: created.id })).code).toBe("KIDS10");

    const edited = await runAction(updateCoupon, call, { id: created.id, kind: "fixed", amountCents: 300, maxUses: 5, offerIds: [s.offerId] });
    expect(edited).toMatchObject({ kind: "fixed", percentBp: null, amountCents: 300, maxUses: 5, offerIds: [s.offerId] });
    const cleared = await runAction(updateCoupon, call, { id: created.id, offerIds: [] });
    expect(cleared.offerIds).toEqual([]);

    const archived = await runAction(archiveCoupon, call, { id: created.id });
    expect(archived.active).toBe(false);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(await runAction(listCoupons, call, {})).toEqual([]);
    expect((await runAction(listCoupons, call, { includeArchived: true })).map((c) => c.id)).toEqual([created.id]);
    // O cupom continua existindo (nunca apaga) e arquivado não é editado.
    expect((await runAction(getCoupon, call, { id: created.id })).archivedAt).not.toBeNull();
    expect(await code(runAction(updateCoupon, call, { id: created.id, active: true }))).toBe("conflict");
  });

  test("código repetido (kids10 x KIDS10) é conflito, na criação e na edição; em outra loja é permitido", async () => {
    const s = await seedPanelStore("Cupons dup");
    const call = panelCall(s.storeId);
    await runAction(createCoupon, call, { code: "KIDS10", ...base });
    const err = await fail(runAction(createCoupon, call, { code: "kids10", ...base }));
    expect([err?.code, err?.message]).toEqual(["conflict", "Já existe um cupom com este código"]);
    const other = await runAction(createCoupon, call, { code: "OUTRO", ...base });
    expect(await code(runAction(updateCoupon, call, { id: other.id, code: "kids10" }))).toBe("conflict");
    const s2 = await seedPanelStore("Cupons dup 2");
    expect((await runAction(createCoupon, panelCall(s2.storeId), { code: "KIDS10", ...base })).code).toBe("KIDS10");
  });

  test("validação: código, tipo x valor, janela, limites e campos desconhecidos", async () => {
    const s = await seedPanelStore("Cupons val");
    const call = panelCall(s.storeId);
    const issuePath = async (input: unknown) => {
      const e = await fail(runAction(createCoupon, call, input));
      expect(e?.code).toBe("invalid_input");
      return (e!.details as { path: string[] }[]).map((i) => i.path.join("."));
    };
    expect(await issuePath({ code: "a b", ...base })).toContain("code");
    expect(await issuePath({ code: "AB", ...base })).toContain("code");
    expect(await issuePath({ code: "A".repeat(33), ...base })).toContain("code");
    expect(await issuePath({ code: "VAL1", kind: "percent" })).toContain("percentBp");
    expect(await issuePath({ code: "VAL2", kind: "percent", percentBp: 9001 })).toContain("percentBp");
    expect(await issuePath({ code: "VAL3", kind: "percent", percentBp: 0 })).toContain("percentBp");
    expect(await issuePath({ code: "VAL4", kind: "percent", percentBp: 1000, amountCents: 100 })).toContain("amountCents");
    expect(await issuePath({ code: "VAL5", kind: "fixed" })).toContain("amountCents");
    expect(await issuePath({ code: "VAL6", kind: "fixed", amountCents: 0 })).toContain("amountCents");
    expect(await issuePath({ code: "VAL7", kind: "fixed", amountCents: 1.5 })).toContain("amountCents");
    expect(await issuePath({ code: "VAL8", kind: "fixed", amountCents: 100, percentBp: 1000 })).toContain("percentBp");
    const t0 = "2026-12-01T00:00:00Z";
    expect(await issuePath({ code: "VAL9", ...base, startsAt: t0, endsAt: t0 })).toContain("endsAt");
    expect(await issuePath({ code: "VALA", ...base, maxUses: 0 })).toContain("maxUses");
    expect(await issuePath({ code: "VALB", ...base, maxPerEmail: -1 })).toContain("maxPerEmail");
    expect(await issuePath({ code: "VALC", ...base, desconto: 1 })).toEqual([""]);
    // null é aceito nos limites; a data vira Date.
    const ok = await runAction(createCoupon, call, { code: "VALD", ...base, maxUses: null, maxPerEmail: null, startsAt: t0, endsAt: "2026-12-31T00:00:00Z" });
    expect(ok).toMatchObject({ maxUses: null, maxPerEmail: null });
    expect(ok.startsAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    // Edição: o estado resultante é validado (tipo novo sem valor; fim antes do início).
    expect(await code(runAction(updateCoupon, call, { id: ok.id, kind: "fixed" }))).toBe("invalid_input");
    expect(await code(runAction(updateCoupon, call, { id: ok.id, endsAt: "2026-11-01T00:00:00Z" }))).toBe("invalid_input");
    expect(await code(runAction(updateCoupon, call, { id: ok.id, percentBp: 9500 }))).toBe("invalid_input");
  });

  test("valores fora da faixa (valor fixo enorme, datas absurdas) → invalid_input, nunca erro interno", async () => {
    const s = await seedPanelStore("Cupons faixa");
    const call = panelCall(s.storeId);
    const fixedBase = { kind: "fixed" as const, amountCents: 500 };
    expect(await code(runAction(createCoupon, call, { code: "BIG1", kind: "fixed", amountCents: 2_147_483_648 }))).toBe("invalid_input");
    expect(await code(runAction(createCoupon, call, { code: "BIG2", kind: "fixed", amountCents: 100_000_001 }))).toBe("invalid_input");
    expect(await code(runAction(createCoupon, call, { code: "BIG3", kind: "percent", percentBp: 2_147_483_648 }))).toBe("invalid_input");
    expect(await code(runAction(createCoupon, call, { code: "DT1", ...fixedBase, startsAt: "1899-12-31T00:00:00Z" }))).toBe("invalid_input");
    expect(await code(runAction(createCoupon, call, { code: "DT2", ...fixedBase, endsAt: "2101-01-01T00:00:00Z" }))).toBe("invalid_input");
    expect(await code(runAction(createCoupon, call, { code: "DT3", ...fixedBase, endsAt: "+275760-09-13T00:00:00Z" }))).toBe("invalid_input");
    const ok = await runAction(createCoupon, call, { code: "FAIXA", ...fixedBase, amountCents: 100_000_000, endsAt: "2100-12-31T00:00:00Z" });
    expect(await code(runAction(updateCoupon, call, { id: ok.id, amountCents: 2_147_483_648 }))).toBe("invalid_input");
    expect(await code(runAction(updateCoupon, call, { id: ok.id, startsAt: "0001-01-01T00:00:00Z" }))).toBe("invalid_input");
    expect(await code(runAction(updateCoupon, call, { id: ok.id, maxUses: 2_147_483_648 }))).toBe("invalid_input");
  });

  test("código de cupom já usado não muda (conflict com mensagem clara); os outros campos mudam", async () => {
    const s = await seedPanelStore("Cupons renomear");
    const call = panelCall(s.storeId);
    const c = await runAction(createCoupon, call, { code: "ANTES", ...base });
    // Sem pedido: renomear é permitido.
    const renamed = await runAction(updateCoupon, call, { id: c.id, code: "NOVO" });
    expect(renamed.code).toBe("NOVO");
    // Com pedido (qualquer situação: o código fica no histórico do pedido, do CSV e das métricas), não.
    const o = await seedOrder(s, { status: "expired", coupon: { code: "NOVO", discountCents: 99 } });
    expect(o.couponId).toBe(c.id);
    const err = await fail(runAction(updateCoupon, call, { id: c.id, code: "OUTRO" }));
    expect([err?.code, err?.message]).toEqual(["conflict", "Este cupom já foi usado: crie outro código"]);
    expect((await runAction(getCoupon, call, { id: c.id })).code).toBe("NOVO");
    // Mandar o mesmo código (o formulário manda tudo) e mudar outros campos continua valendo.
    const edited = await runAction(updateCoupon, call, { id: c.id, code: "novo", percentBp: 1500 });
    expect([edited.code, edited.percentBp]).toEqual(["NOVO", 1500]);
  });

  test("ofertas: de outra loja ou inexistente → not_found; nada é gravado", async () => {
    const s = await seedPanelStore("Cupons of");
    const o = await seedPanelStore("Cupons of outra");
    const call = panelCall(s.storeId);
    expect(await code(runAction(createCoupon, call, { code: "OFR1", ...base, offerIds: [o.offerId] }))).toBe("not_found");
    expect(await code(runAction(createCoupon, call, { code: "OFR2", ...base, offerIds: [randomUUID()] }))).toBe("not_found");
    expect(await runAction(listCoupons, call, { includeArchived: true })).toEqual([]);
    const fine = await runAction(createCoupon, call, { code: "OFR4", ...base });
    expect(await code(runAction(updateCoupon, call, { id: fine.id, offerIds: [o.offerId] }))).toBe("not_found");
  });

  test("cupom de outra loja é invisível (RLS): get e archive → not_found", async () => {
    const a = await seedPanelStore("Cupons rls a");
    const b = await seedPanelStore("Cupons rls b");
    const mine = await runAction(createCoupon, panelCall(a.storeId), { code: "RLS1", ...base });
    expect(await code(runAction(getCoupon, panelCall(b.storeId), { id: mine.id }))).toBe("not_found");
    expect(await code(runAction(archiveCoupon, panelCall(b.storeId), { id: mine.id }))).toBe("not_found");
    expect(await runAction(listCoupons, panelCall(b.storeId), {})).toEqual([]);
  });

  test("papéis: traffic, support e reader leem e não escrevem; admin escreve", async () => {
    const s = await seedPanelStore("Cupons papéis");
    const owner = await runAction(createCoupon, panelCall(s.storeId), { code: "ROLE1", ...base });
    for (const role of ["traffic", "support", "reader"] as const) {
      const c = panelCall(s.storeId, role);
      expect((await runAction(listCoupons, c, {})).length).toBe(1);
      expect((await runAction(getCoupon, c, { id: owner.id })).code).toBe("ROLE1");
      expect(await code(runAction(createCoupon, c, { code: "ROLE2", ...base }))).toBe("forbidden");
      expect(await code(runAction(updateCoupon, c, { id: owner.id, active: false }))).toBe("forbidden");
      expect(await code(runAction(archiveCoupon, c, { id: owner.id }))).toBe("forbidden");
    }
    expect((await runAction(createCoupon, panelCall(s.storeId, "admin"), { code: "ROLE3", ...base })).code).toBe("ROLE3");
  });

  test("uses segue a regra D5: paid/disputed, Pix pendente não vencido e cartão pendente há menos de 2 h", async () => {
    const s = await seedPanelStore("Cupons uses");
    const call = panelCall(s.storeId);
    const c = await runAction(createCoupon, call, { code: "USOS", ...base });
    const old = new Date(Date.now() - 3 * 3_600_000);
    const recent = new Date(Date.now() - 30 * 60_000);
    const counted = [
      await seedOrder(s, { status: "paid" }),
      await seedOrder(s, { status: "disputed" }),
      await seedOrder(s, { status: "pending", method: "pix_asaas" }),
      await seedOrder(s, { status: "pending", method: "pix_manual" }),
      await seedOrder(s, { status: "pending", method: "card_asaas", createdAt: recent }),
    ];
    const ignored = [
      await seedOrder(s, { status: "refunded" }),
      await seedOrder(s, { status: "expired" }),
      await seedOrder(s, { status: "declined" }),
      await seedOrder(s, { status: "pending", method: "card_asaas", createdAt: old }),
      await seedOrder(s, { status: "pending", method: "pix_asaas" }),
    ];
    // Pix pendente vencido: muda a data no banco (sem esperar).
    await ownerDb.update(orders).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(orders.id, ignored[4]!.id));
    for (const o of [...counted, ...ignored]) await ownerDb.update(orders).set({ couponId: c.id, discountCents: 99, totalCents: o.subtotalCents - 99 }).where(eq(orders.id, o.id));
    expect((await runAction(getCoupon, call, { id: c.id })).uses).toBe(counted.length);
    expect((await runAction(listCoupons, call, {}))[0]!.uses).toBe(counted.length);
  });
});

// ---- Cupom no pedido (A3): createOrder, checkout.previewCoupon e checkout.start ------------------------------------

describe("cupom no checkout", () => {
  const INVALID = "Cupom inválido ou vencido";
  const owner = { kind: "user" as const, userId: "u1", role: "owner" as const };
  const pub = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });
  const ownerCall = (storeId: string) => ({ storeId, actor: owner, origin: "panel" as const });
  // Pega a ação pelo registro (a importação de `@/lib/actions/all` registra todas).
  const action = (name: string) => {
    const a = registry.get(name);
    if (!a) throw new Error(`ação não registrada: ${name}`);
    return a;
  };
  // Relógio injetado (`call.server.now`): os limites de cupom são por janela fixa de hora; com a hora real, um teste que
  // cruzasse a virada da hora contaria em duas janelas. Meio da hora, longe das bordas.
  const NOW = new Date("2026-11-23T10:30:00.000Z");
  const at = (storeId: string, now?: Date) => ({ ...pub(storeId), ...(now ? { server: { now } } : {}) });
  const preview = (storeId: string, input: Record<string, unknown>, now?: Date) =>
    runAction(action("checkout.previewCoupon"), at(storeId, now), input) as Promise<
      { ok: true; code: string; discountCents: number; totalCents: number } | { ok: false; message: string }
    >;
  const start = (storeId: string, input: Record<string, unknown>, now?: Date) =>
    runAction(action("checkout.start"), at(storeId, now), input) as Promise<{ publicId: string; orderId: string; totalCents: number }>;
  const fail = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error("esperava erro");
      },
      (e: unknown) => e as ActionError,
    );

  let ipSeq = 0;
  const nextIp = () => `198.18.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const mail = () => `c-${randomUUID()}@example.com`;

  /** Loja com Pix manual, `main` produtos principais pelo `price` e, opcional, bump de 5 produtos por 1710. */
  async function shop(o: { main?: number; price?: number; bump?: boolean; asaas?: FakeAsaas; maxInstallments?: number } = {}) {
    const { storeId } = await seedStore("Cupom checkout");
    const call = ownerCall(storeId);
    if (o.asaas) {
      setAsaasFetchForTests(o.asaas.fetch);
      await runAction(saveAsaas, call, { env: "sandbox", apiKey: o.asaas.apiKey });
    }
    await runAction(savePixManual, call, { key: "contato@manakids.com.br", name: "Mana Kids", city: "Sao Paulo" });
    const main: string[] = [];
    for (let i = 0; i < (o.main ?? 1); i++) main.push((await seedProduct(storeId, `PDF ${i + 1}`)).id);
    const kits: string[] = [];
    if (o.bump) for (let i = 0; i < 5; i++) kits.push((await seedProduct(storeId, `Kit ${i + 1}`)).id);
    const slug = `o-${Math.random().toString(36).slice(2, 10)}`;
    const created = await runAction(createOffer, call, {
      slug,
      name: "Almanaque",
      productIds: main,
      priceCents: o.price ?? 990,
      methods: ["pix", "card"],
      pixMode: "manual",
      ...(o.maxInstallments ? { maxInstallments: o.maxInstallments } : {}),
      ...(o.bump ? { bump: { productIds: kits, priceCents: 1710, label: "5 Kits Extras" } } : {}),
    });
    return { storeId, slug, offerId: created.id, call };
  }

  const newCoupon = (storeId: string, over: Record<string, unknown> = {}) =>
    runAction(createCoupon, ownerCall(storeId), { code: "KIDS10", kind: "percent", percentBp: 1000, ...over });

  const startInput = (slug: string, over: Record<string, unknown> & { customer?: Record<string, unknown> } = {}) => {
    const { customer: c, ...rest } = over;
    return {
      slug,
      withBump: false,
      method: "pix",
      customer: { name: "Maria Souza", email: mail(), phone: "(11) 98765-4321", ...c },
      touch: { first: null, last: null },
      clientIp: nextIp(),
      userAgent: "bun-test",
      ...rest,
    };
  };

  const orderOf = async (storeId: string, id: string) => (await withStore(storeId, (tx) => tx.select().from(orders).where(eq(orders.id, id))))[0]!;
  const itemsOf = (storeId: string, orderId: string) =>
    withStore(storeId, (tx) => tx.select().from(orderItem).where(eq(orderItem.orderId, orderId)));
  const orderCount = async (storeId: string) => (await withStore(storeId, (tx) => tx.select({ id: orders.id }).from(orders))).length;
  const sum = (xs: { priceCents: number }[]) => xs.reduce((a, x) => a + x.priceCents, 0);

  test("Almanaque + KIDS10 (10%, main) → subtotal 990, desconto 99, total 891, itens somam 891", async () => {
    const s = await shop();
    const c = await newCoupon(s.storeId);
    const r = await start(s.storeId, startInput(s.slug, { couponCode: "kids10", expectedTotalCents: 891 }));
    expect(r.totalCents).toBe(891);
    const o = await orderOf(s.storeId, r.orderId);
    expect(o).toMatchObject({ subtotalCents: 990, discountCents: 99, totalCents: 891, couponId: c.id });
    expect(sum(await itemsOf(s.storeId, o.id))).toBe(891);
  });

  test("com bump e applies_to=main → total 891 + 1710 = 2601; com all → 2430; itens de cada grupo somam o grupo", async () => {
    const s = await shop({ bump: true });
    await newCoupon(s.storeId);
    await newCoupon(s.storeId, { code: "TUDO10", appliesTo: "all" });
    const main = await start(s.storeId, startInput(s.slug, { withBump: true, couponCode: "KIDS10", expectedTotalCents: 2601 }));
    const om = await orderOf(s.storeId, main.orderId);
    expect(om).toMatchObject({ subtotalCents: 2700, discountCents: 99, totalCents: 2601 });
    const im = await itemsOf(s.storeId, om.id);
    expect(sum(im.filter((i) => i.kind === "main"))).toBe(891);
    expect(sum(im.filter((i) => i.kind === "bump"))).toBe(1710);
    expect(sum(im)).toBe(2601);

    const all = await start(s.storeId, startInput(s.slug, { withBump: true, couponCode: "TUDO10", expectedTotalCents: 2430 }));
    const oa = await orderOf(s.storeId, all.orderId);
    expect(oa).toMatchObject({ subtotalCents: 2700, discountCents: 270, totalCents: 2430 });
    const ia = await itemsOf(s.storeId, oa.id);
    expect(sum(ia.filter((i) => i.kind === "main"))).toBe(891);
    expect(sum(ia.filter((i) => i.kind === "bump"))).toBe(1539);
    expect(sum(ia)).toBe(2430);
  });

  test("Completo (6 PDFs) com fixo de 500 → total 2200, 6 itens somam 2200", async () => {
    const s = await shop({ main: 6, price: 2700 });
    await newCoupon(s.storeId, { code: "MENOS5", kind: "fixed", percentBp: null, amountCents: 500 });
    const r = await start(s.storeId, startInput(s.slug, { couponCode: "MENOS5", expectedTotalCents: 2200 }));
    const o = await orderOf(s.storeId, r.orderId);
    expect(o).toMatchObject({ subtotalCents: 2700, discountCents: 500, totalCents: 2200 });
    const items = await itemsOf(s.storeId, o.id);
    expect(items).toHaveLength(6);
    expect(sum(items)).toBe(2200);
  });

  test("cupom vencido, inativo, arquivado, ainda não começou, de outra oferta, inexistente ou com max_uses atingido → invalid_input e nenhum pedido", async () => {
    const s = await shop();
    const other = await runAction(createOffer, s.call, {
      slug: `x-${Math.random().toString(36).slice(2, 10)}`,
      name: "Outra",
      productIds: [(await seedProduct(s.storeId, "Outro")).id],
      priceCents: 1500,
      methods: ["pix"],
      pixMode: "manual",
    });
    const past = new Date(Date.now() - 2 * 86_400_000);
    await newCoupon(s.storeId, { code: "VENCIDO", startsAt: past, endsAt: new Date(Date.now() - 60_000) });
    await newCoupon(s.storeId, { code: "FUTURO", startsAt: new Date(Date.now() + 86_400_000) });
    await newCoupon(s.storeId, { code: "INATIVO", active: false });
    const arch = await newCoupon(s.storeId, { code: "ARQUIVADO" });
    await runAction(archiveCoupon, s.call, { id: arch.id });
    await newCoupon(s.storeId, { code: "OUTRAOFERTA", offerIds: [other.id] });
    const esgotado = await newCoupon(s.storeId, { code: "ESGOTADO", maxUses: 1, maxPerEmail: null });
    // O único uso do ESGOTADO é um pedido pago de outro comprador.
    const first = await start(s.storeId, startInput(s.slug, { couponCode: "ESGOTADO", expectedTotalCents: 891 }));
    await ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, first.orderId));
    expect((await orderOf(s.storeId, first.orderId)).couponId).toBe(esgotado.id);

    const before = await orderCount(s.storeId);
    for (const code of ["VENCIDO", "FUTURO", "INATIVO", "ARQUIVADO", "OUTRAOFERTA", "NAOEXISTE", "ESGOTADO", "!!"]) {
      const e = await fail(start(s.storeId, startInput(s.slug, { couponCode: code, expectedTotalCents: 891 })));
      expect([code, e.code, e.message]).toEqual([code, "invalid_input", INVALID]);
      expect([code, e.details]).toEqual([code, [{ path: ["couponCode"], message: INVALID }]]);
    }
    expect(await orderCount(s.storeId)).toBe(before);
  });

  test("cupom restrito à oferta do checkout vale", async () => {
    const s = await shop();
    await newCoupon(s.storeId, { offerIds: [s.offerId] });
    const r = await start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891 }));
    expect(r.totalCents).toBe(891);
  });

  test("max_per_email 1: segundo pedido de a+x@gmail.com depois de a@gmail.com pago → invalid_input", async () => {
    const s = await shop();
    await newCoupon(s.storeId);
    const base = `a.${randomUUID().slice(0, 8)}`;
    const first = await start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: `${base}@gmail.com` } }));
    await ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, first.orderId));
    const variant = `${base.replace(".", "")}+x@googlemail.com`;
    const e = await fail(start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: variant } })));
    expect([e.code, e.message]).toEqual(["invalid_input", INVALID]);
    // A prévia não recebe e-mail nem confere o limite por caixa (não revela se a caixa de alguém usou o cupom): ok.
    expect(await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() })).toEqual({ ok: true, code: "KIDS10", discountCents: 99, totalCents: 891 });
    const strict = await fail(preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, email: variant, clientIp: nextIp() }));
    expect(strict.code).toBe("invalid_input");
    // Outra pessoa usa normalmente.
    const other = await start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891 }));
    expect(other.totalCents).toBe(891);
  });

  test("max_per_email conta só compras pagas: Pix pendente da mesma caixa não impede o cartão com o cupom; pago, impede", async () => {
    const fake = createFakeAsaas();
    const s = await shop({ asaas: fake });
    await newCoupon(s.storeId);
    const who = `b-${randomUUID().slice(0, 8)}@example.com`;
    const pix = await start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: who } }));
    expect((await orderOf(s.storeId, pix.orderId)).status).toBe("pending");
    // Desistiu do Pix e foi para o cartão: o Pix pendente não conta no limite por pessoa.
    const card = { method: "card", couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: who, cpf: "52998224725" } };
    const second = await start(s.storeId, startInput(s.slug, card));
    expect((await orderOf(s.storeId, second.orderId)).method).toBe("card_asaas");
    // Pago (ou contestado): agora conta.
    await ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, pix.orderId));
    const e = await fail(start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: who } })));
    expect([e.code, e.message]).toEqual(["invalid_input", INVALID]);
    setAsaasFetchForTests();
  });

  test("max_uses (limite global) conta pendentes: cartão pendente há 1 h ocupa o uso; há 3 h libera", async () => {
    const fake = createFakeAsaas();
    const s = await shop({ asaas: fake });
    await newCoupon(s.storeId, { maxUses: 1, maxPerEmail: null });
    const card = () => ({ method: "card", couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: mail(), cpf: "52998224725" } });
    const first = await start(s.storeId, startInput(s.slug, card()));
    expect((await orderOf(s.storeId, first.orderId)).method).toBe("card_asaas");
    await ownerDb.update(orders).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(orders.id, first.orderId));
    expect((await fail(start(s.storeId, startInput(s.slug, card())))).code).toBe("invalid_input");
    await ownerDb.update(orders).set({ createdAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(orders.id, first.orderId));
    expect((await start(s.storeId, startInput(s.slug, card()))).totalCents).toBe(891);
    setAsaasFetchForTests();
  });

  test("expectedTotalCents diferente → conflict PRICE_CHANGED e nenhum pedido", async () => {
    const s = await shop({ bump: true });
    await newCoupon(s.storeId);
    const before = await orderCount(s.storeId);
    // Viu 891 mas marcou o bump (2601); viu 990 (sem o cupom) e mandou o cupom.
    for (const [withBump, seen] of [[true, 891], [false, 990]] as const) {
      const e = await fail(start(s.storeId, startInput(s.slug, { withBump, couponCode: "KIDS10", expectedTotalCents: seen })));
      expect([e.code, e.message]).toEqual(["conflict", "O valor mudou: confira o resumo"]);
      expect((e.details as { code: string }).code).toBe("PRICE_CHANGED");
    }
    expect(await orderCount(s.storeId)).toBe(before);
  });

  test("cupom que vence entre a prévia e o envio: invalid_input e nenhum pedido", async () => {
    const s = await shop();
    const c = await newCoupon(s.storeId);
    const ip = nextIp();
    expect(await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: ip })).toEqual({ ok: true, code: "KIDS10", discountCents: 99, totalCents: 891 });
    await ownerDb.update(coupon).set({ startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() - 1000) }).where(eq(coupon.id, c.id));
    const e = await fail(start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, clientIp: ip })));
    expect([e.code, e.message]).toEqual(["invalid_input", INVALID]);
    expect(await orderCount(s.storeId)).toBe(0);
  });

  test("duas compras simultâneas no último uso → só uma cria o pedido (lock)", async () => {
    const s = await shop();
    await newCoupon(s.storeId, { maxUses: 1, maxPerEmail: null });
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () => start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891 }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => (r.reason as ActionError).code)).toEqual(["invalid_input"]);
    expect(await orderCount(s.storeId)).toBe(1);
  });

  test("checkout.previewCoupon: desconto e total; com bump; código inválido ou desconto zero dão a mensagem neutra", async () => {
    const s = await shop({ bump: true });
    await newCoupon(s.storeId);
    await newCoupon(s.storeId, { code: "TUDO10", appliesTo: "all" });
    const p = (code: string, withBump = false) => preview(s.storeId, { slug: s.slug, code, withBump, clientIp: nextIp() });
    expect(await p(" kids10 ")).toEqual({ ok: true, code: "KIDS10", discountCents: 99, totalCents: 891 });
    expect(await p("KIDS10", true)).toEqual({ ok: true, code: "KIDS10", discountCents: 99, totalCents: 2601 });
    expect(await p("TUDO10", true)).toEqual({ ok: true, code: "TUDO10", discountCents: 270, totalCents: 2430 });
    expect(await p("NAOEXISTE")).toEqual({ ok: false, message: INVALID });
    expect(await p("a b")).toEqual({ ok: false, message: INVALID });

    // Oferta de R$ 5,00: o piso come o desconto inteiro (desconto 0) → inválido, na prévia e no envio.
    const cheap = await shop({ price: 500 });
    await newCoupon(cheap.storeId);
    expect(await preview(cheap.storeId, { slug: cheap.slug, code: "KIDS10", withBump: false, clientIp: nextIp() })).toEqual({ ok: false, message: INVALID });
    const e = await fail(start(cheap.storeId, startInput(cheap.slug, { couponCode: "KIDS10", expectedTotalCents: 500 })));
    expect([e.code, e.message]).toEqual(["invalid_input", INVALID]);
    expect(await orderCount(cheap.storeId)).toBe(0);
  });

  test("prévia com o bump marcado e indisponível mostra a mensagem do bump (a mesma do envio), não a de cupom inválido", async () => {
    const s = await shop({ bump: true });
    await newCoupon(s.storeId);
    await ownerDb.update(offer).set({ bumpPriceCents: null }).where(eq(offer.id, s.offerId));
    const ip = nextIp();
    const e = await fail(preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: true, clientIp: ip }, NOW));
    const sent = await fail(start(s.storeId, startInput(s.slug, { withBump: true, couponCode: "KIDS10", expectedTotalCents: 891, clientIp: ip }), NOW));
    expect(previewErrorResult(e)).toEqual({ ok: false, message: sent.message });
    expect(sent.message).toBe(BUMP_UNAVAILABLE);
    // O resto continua neutro; o limite mostra a própria mensagem.
    expect(previewErrorResult(new ActionError("not_found", "Oferta não encontrada"))).toEqual({ ok: false, message: INVALID });
    expect(previewErrorResult(new ActionError("rate_limited", "Muitas tentativas"))).toEqual({ ok: false, message: "Muitas tentativas" });
    // Recusa pelo bump não é tentativa de código: não conta no balde da loja.
    expect(await ownerDb.select().from(rateLimit).where(eq(rateLimit.key, `coupon:preview:store:${s.storeId}`))).toEqual([]);
  });

  test("checkout.previewCoupon é pública, sem auditoria, e não aparece no MCP", () => {
    const a = action("checkout.previewCoupon");
    expect([a.permission, a.audit]).toEqual(["public", false]);
  });

  test("21ª prévia do mesmo IP na hora → rate_limited (código inválido também conta)", async () => {
    const s = await shop();
    await newCoupon(s.storeId);
    const ip = nextIp();
    for (let i = 0; i < 20; i++) {
      const r = await preview(s.storeId, { slug: s.slug, code: i % 2 ? "KIDS10" : `ERRADO${i}`, withBump: false, clientIp: ip }, NOW);
      expect(r.ok).toBe(i % 2 === 1);
    }
    const e = await fail(preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: ip }, NOW));
    expect(e.code).toBe("rate_limited");
    // Outro IP segue; o mesmo IP na hora seguinte também.
    expect((await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() }, NOW)).ok).toBe(true);
    const nextHour = new Date(NOW.getTime() + 3_600_000);
    expect((await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: ip }, nextHour)).ok).toBe(true);
  });

  test("300 prévias RECUSADAS da loja na hora → rate_limited para qualquer IP (o balde só conta as inválidas)", async () => {
    const s = await shop();
    await newCoupon(s.storeId);
    const hour = 3_600_000;
    const windowStart = new Date(Math.floor(NOW.getTime() / hour) * hour);
    const key = `coupon:preview:store:${s.storeId}`;
    await ownerDb.insert(rateLimit).values({ key, windowStart, count: 299 });
    const counter = async () => (await ownerDb.select().from(rateLimit).where(eq(rateLimit.key, key)))[0]?.count;
    // A 300ª recusada ainda passa (devolve ok:false) e enche o balde; a próxima, de qualquer IP, já é barrada.
    expect(await preview(s.storeId, { slug: s.slug, code: "ERRADO", withBump: false, clientIp: nextIp() }, NOW)).toEqual({ ok: false, message: INVALID });
    expect(await counter()).toBe(300);
    const e = await fail(preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() }, NOW));
    expect(e.code).toBe("rate_limited");
    // Janela seguinte: libera.
    const nextHour = new Date(NOW.getTime() + hour);
    expect((await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() }, nextHour)).ok).toBe(true);
  });

  test("300+ prévias VÁLIDAS de IPs diferentes não travam a loja (e não contam no balde dela)", async () => {
    const s = await shop();
    await newCoupon(s.storeId);
    const key = `coupon:preview:store:${s.storeId}`;
    for (let i = 0; i < 310; i++) {
      const r = await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() }, NOW);
      expect(r.ok).toBe(true);
    }
    expect(await ownerDb.select().from(rateLimit).where(eq(rateLimit.key, key))).toEqual([]);
    expect((await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() }, NOW)).ok).toBe(true);
  }, HEAVY_TEST_MS);

  test("prévia recusada conta no balde da loja; a válida não", async () => {
    const s = await shop();
    await newCoupon(s.storeId);
    const key = `coupon:preview:store:${s.storeId}`;
    const counter = async () => (await ownerDb.select().from(rateLimit).where(eq(rateLimit.key, key)))[0]?.count ?? 0;
    await preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() }, NOW);
    expect(await counter()).toBe(0);
    await preview(s.storeId, { slug: s.slug, code: "NAO", withBump: false, clientIp: nextIp() }, NOW);
    await preview(s.storeId, { slug: s.slug, code: "NAO2", withBump: false, clientIp: nextIp() }, NOW);
    expect(await counter()).toBe(2);
  });

  test("checkout.start com cupom inválido conta no limite de cupom do IP; esgotado, o envio com cupom é recusado", async () => {
    const s = await shop();
    await newCoupon(s.storeId);
    const ip = nextIp();
    for (let i = 0; i < 20; i++) {
      const e = await fail(start(s.storeId, startInput(s.slug, { couponCode: `ERRADO${i}`, expectedTotalCents: 891, clientIp: ip }), NOW));
      expect(e.code).toBe("invalid_input");
    }
    expect((await fail(preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: ip }, NOW))).code).toBe("rate_limited");
    expect((await fail(start(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, clientIp: ip }), NOW))).code).toBe("rate_limited");
    // Sem cupom o mesmo IP compra normalmente.
    expect((await start(s.storeId, startInput(s.slug, { clientIp: ip }), NOW)).totalCents).toBe(990);
  });

  describe("balde da loja (300 recusas por hora) vale para a prévia e para o envio", () => {
    const hour = 3_600_000;
    const storeKey = (storeId: string) => `coupon:preview:store:${storeId}`;
    const counter = async (storeId: string) => (await ownerDb.select().from(rateLimit).where(eq(rateLimit.key, storeKey(storeId))))[0]?.count ?? 0;
    const fill = (storeId: string, count: number) =>
      ownerDb.insert(rateLimit).values({ key: storeKey(storeId), windowStart: new Date(Math.floor(NOW.getTime() / hour) * hour), count });
    // O envio de verdade (server action) passa por `startCheckout`, com o relógio injetado.
    const send = (storeId: string, input: Record<string, unknown>, now = NOW) => startCheckout({ storeId }, input, { now });

    test("envio recusado (código inválido) soma 1 no balde da loja, apesar do rollback; cheio, a prévia e o envio com cupom são barrados", async () => {
      const s = await shop();
      await newCoupon(s.storeId);
      await fill(s.storeId, 299);
      const e = await fail(send(s.storeId, startInput(s.slug, { couponCode: "ERRADO", expectedTotalCents: 891 })));
      expect([e.code, e.message]).toEqual(["invalid_input", INVALID]);
      expect(await counter(s.storeId)).toBe(300);
      expect((await fail(preview(s.storeId, { slug: s.slug, code: "KIDS10", withBump: false, clientIp: nextIp() }, NOW))).code).toBe("rate_limited");
      expect((await fail(send(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891 })))).code).toBe("rate_limited");
      // Comprar sem cupom segue normal; na hora seguinte o cupom volta.
      expect((await send(s.storeId, startInput(s.slug))).method).toBe("pix_manual");
      expect((await send(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891 }), new Date(NOW.getTime() + hour))).method).toBe("pix_manual");
    });

    test("300 prévias recusadas barram o envio com cupom", async () => {
      const s = await shop();
      await newCoupon(s.storeId);
      await fill(s.storeId, 299);
      expect(await preview(s.storeId, { slug: s.slug, code: "ERRADO", withBump: false, clientIp: nextIp() }, NOW)).toEqual({ ok: false, message: INVALID });
      const before = await orderCount(s.storeId);
      const e = await fail(send(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891 })));
      expect(e.code).toBe("rate_limited");
      expect(await orderCount(s.storeId)).toBe(before);
    });

    test("recusa pelo limite por pessoa também conta; envio aceito não conta", async () => {
      const s = await shop();
      await newCoupon(s.storeId);
      const who = mail();
      const first = await send(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: who } }));
      expect(await counter(s.storeId)).toBe(0);
      await ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.publicId, first.publicId));
      expect((await fail(send(s.storeId, startInput(s.slug, { couponCode: "KIDS10", expectedTotalCents: 891, customer: { email: who } })))).code).toBe("invalid_input");
      expect(await counter(s.storeId)).toBe(1);
    });
  });

  test("cartão parcelado: parcelas pelo total com desconto (Completo 2700 em até 5x + fixo 500 → 4x; sem cupom → 5x); a renovação também", async () => {
    const fake = createFakeAsaas();
    const s = await shop({ main: 6, price: 2700, maxInstallments: 5, asaas: fake });
    await newCoupon(s.storeId, { code: "MENOS5", kind: "fixed", percentBp: null, amountCents: 500 });
    const KEY = "k".repeat(32) + "-chave-do-bilhete-de-teste";
    const card = (over: Record<string, unknown>) => startInput(s.slug, { method: "card", customer: { cpf: "52998224725" }, ...over });
    const withCoupon = await startCheckout({ storeId: s.storeId }, card({ couponCode: "MENOS5", expectedTotalCents: 2200 }), { cardTicketKey: KEY });
    const ticket = verifyCardTicket(withCoupon.cardTicket!, KEY)!;
    expect([ticket.totalCents, ticket.maxInstallments]).toEqual([2200, 4]);
    const renewed = verifyCardTicket(await renewCardTicket({ storeId: s.storeId }, { publicId: withCoupon.publicId, ticket: withCoupon.cardTicket }, KEY), KEY)!;
    expect([renewed.totalCents, renewed.maxInstallments]).toEqual([2200, 4]);
    const plain = await startCheckout({ storeId: s.storeId }, card({}), { cardTicketKey: KEY });
    expect(verifyCardTicket(plain.cardTicket!, KEY)!.maxInstallments).toBe(5);
    const d = { discounted: true };
    expect([installmentsFor(5, 2200, d), installmentsFor(5, 2700, d), installmentsFor(12, 500, d), installmentsFor(3, 499, d)]).toEqual([4, 5, 1, 1]);
    setAsaasFetchForTests();
  });

  test("sem cupom, o cartão mantém as parcelas da oferta (R$ 9,90 em até 3x → 3x), no bilhete e na renovação (R-V1)", async () => {
    const fake = createFakeAsaas();
    const s = await shop({ price: 990, maxInstallments: 3, asaas: fake });
    const KEY = "k".repeat(32) + "-chave-do-bilhete-de-teste";
    const out = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: "52998224725" } }), { cardTicketKey: KEY });
    const ticket = verifyCardTicket(out.cardTicket!, KEY)!;
    expect([ticket.totalCents, ticket.maxInstallments]).toEqual([990, 3]);
    const renewed = verifyCardTicket(await renewCardTicket({ storeId: s.storeId }, { publicId: out.publicId, ticket: out.cardTicket }, KEY), KEY)!;
    expect([renewed.totalCents, renewed.maxInstallments]).toEqual([990, 3]);
    setAsaasFetchForTests();
  });

  test("auditoria do checkout.start com cupom → tem o código, não tem e-mail em claro", async () => {
    const s = await shop();
    await newCoupon(s.storeId);
    const who = mail();
    await start(s.storeId, startInput(s.slug, { couponCode: "kids10", expectedTotalCents: 891, customer: { email: who } }));
    const rows = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "checkout.start")));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.input)).not.toContain(who);
    expect(rows[0]!.input).toMatchObject({ coupon: "KIDS10", emailHash: createHash("sha256").update(who).digest("hex") });
  });
});
