// Cupom (A1): regra pura do desconto, normalização do código, isolamento por loja (RLS), FKs compostas e o check do
// pedido (`total = subtotal - desconto`). As ações e o checkout vêm nas próximas tasks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { coupon, couponOffer, orders } from "@/lib/db/schema";
import { COUPON, computeDiscount, normalizeCode } from "@/lib/coupons/rules";
import { createTestDb, seedStore, type TestDb } from "./db";
import { newAsaasOrder, createFakeAsaas, seedAsaasStore } from "./asaas-helpers";

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
