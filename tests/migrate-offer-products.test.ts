// Migração 0022: tabela offer_product, backfill a partir de offer.product_id/bump_product_id e order_item.position.
// O tests/db.ts já migra até a 0022 (sem ofertas), então o teste roda o SQL do backfill (lido do próprio arquivo da
// migração, o que vai para produção) sobre ofertas criadas no schema antigo (colunas product_id/bump_product_id).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { offer, offerProduct, orderItem, orders } from "@/lib/db/schema";
import { createTestDb, seedProduct, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const migration = readFileSync(join(import.meta.dir, "../drizzle/0022_offer_products.sql"), "utf8");
const backfill = migration.split("--> statement-breakpoint").filter((s) => /insert\s+into\s+"?offer_product"?/i.test(s));

const newOffer = (storeId: string, slug: string, productId: string, bump?: string) => ({
  storeId,
  slug,
  name: slug,
  productId,
  priceCents: 2700,
  methods: ["pix"],
  pixMode: "manual",
  ...(bump ? { bumpProductId: bump, bumpPriceCents: 990, bumpLabel: "Bump" } : {}),
});

test("backfill: oferta com bump vira main+bump (posição 0); sem bump vira só main; RLS isola por loja", async () => {
  expect(backfill).toHaveLength(2); // um INSERT para o principal e outro para o bump
  const a = await seedStore("A");
  const b = await seedStore("B");
  const [p1, p2, p3] = [await seedProduct(a.storeId, "P1"), await seedProduct(a.storeId, "P2"), await seedProduct(b.storeId, "P3")];
  const [withBump, noBump, other] = await t.ownerDb
    .insert(offer)
    .values([newOffer(a.storeId, "com-bump", p1.id, p2.id), newOffer(a.storeId, "sem-bump", p2.id), newOffer(b.storeId, "outra", p3.id)])
    .returning({ id: offer.id });

  expect(await t.ownerDb.select().from(offerProduct)).toHaveLength(0);
  for (const stmt of backfill) await t.ownerDb.execute(sql.raw(stmt));

  const rows = await t.ownerDb.select().from(offerProduct);
  const of = (id: string) =>
    rows
      .filter((r) => r.offerId === id)
      .map((r) => [r.productId, r.kind, r.position, r.storeId])
      .sort();
  expect(of(withBump!.id)).toEqual([
    [p1.id, "main", 0, a.storeId],
    [p2.id, "bump", 0, a.storeId],
  ].sort());
  expect(of(noBump!.id)).toEqual([[p2.id, "main", 0, a.storeId]]);
  expect(of(other!.id)).toEqual([[p3.id, "main", 0, b.storeId]]);

  // RLS: cada loja só enxerga as suas linhas.
  expect(await withStore(a.storeId, (tx) => tx.select().from(offerProduct))).toHaveLength(3);
  const seenByB = await withStore(b.storeId, (tx) => tx.select().from(offerProduct));
  expect(seenByB.map((r) => r.offerId)).toEqual([other!.id]);
  // e a loja B não grava na A.
  await expect(withStore(b.storeId, (tx) => tx.insert(offerProduct).values({ storeId: a.storeId, offerId: withBump!.id, productId: p3.id, kind: "main", position: 1 }))).rejects.toThrow();
});

test("restrições: produto repetido na oferta, kind e posição inválidos; cascade ao apagar a oferta", async () => {
  const a = await seedStore("A");
  const p = await seedProduct(a.storeId);
  const [o] = await t.ownerDb.insert(offer).values(newOffer(a.storeId, "r", p.id)).returning({ id: offer.id });
  const row = { storeId: a.storeId, offerId: o!.id, productId: p.id, kind: "main", position: 0 };
  await t.ownerDb.insert(offerProduct).values(row);
  await expect((async () => t.ownerDb.insert(offerProduct).values({ ...row, kind: "bump", position: 1 }))()).rejects.toThrow();
  const q = await seedProduct(a.storeId, "Q");
  await expect((async () => t.ownerDb.insert(offerProduct).values({ ...row, productId: q.id, kind: "x" }))()).rejects.toThrow();
  await expect((async () => t.ownerDb.insert(offerProduct).values({ ...row, productId: q.id, position: -1 }))()).rejects.toThrow();
  await t.ownerDb.delete(offer).where(sql`id = ${o!.id}`);
  expect(await t.ownerDb.select().from(offerProduct).where(sql`offer_id = ${o!.id}`)).toHaveLength(0);
});

test("order_item.position: pedidos sem posição ficam em 0", async () => {
  const col = await t.ownerDb.execute(sql`select column_default, is_nullable from information_schema.columns where table_name = 'order_item' and column_name = 'position'`);
  expect(col[0]).toMatchObject({ column_default: "0", is_nullable: "NO" });
  expect(orderItem.position.default).toBe(0);
  void orders;
});
