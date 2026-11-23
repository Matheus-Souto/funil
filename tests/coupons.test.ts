// Cupom (A1): regra pura do desconto, normalização do código, isolamento por loja (RLS), FKs compostas e o check do
// pedido (`total = subtotal - desconto`). As ações e o checkout vêm nas próximas tasks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { archiveCoupon, createCoupon, getCoupon, listCoupons, updateCoupon } from "@/lib/coupons/actions";
import { ownerDb, withStore } from "@/lib/db/client";
import { coupon, couponOffer, orders } from "@/lib/db/schema";
import { COUPON, computeDiscount, normalizeCode } from "@/lib/coupons/rules";
import { createTestDb, seedStore, type TestDb } from "./db";
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
