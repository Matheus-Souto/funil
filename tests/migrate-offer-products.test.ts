// Migração 0022: tabela offer_product, backfill a partir de offer.product_id/bump_product_id e order_item.position.
// O tests/db.ts migra até a última (a 0023 já removeu offer.product_id/bump_product_id), então o teste recria as duas
// colunas antigas, roda o SQL do backfill (lido do próprio arquivo da 0022, o que vai para produção) sobre ofertas no
// schema antigo e as remove de novo.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { offer, offerProduct, orderItem } from "@/lib/db/schema";
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

/** Código SQLSTATE e constraint do erro do Postgres (o drizzle o embrulha em `cause`). */
async function pgError(run: () => PromiseLike<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run();
  } catch (e) {
    const err = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint_name?: string };
    return { code: err.code, constraint: err.constraint_name };
  }
  throw new Error("esperava erro do Postgres, mas a operação passou");
}

const newOffer = (storeId: string, slug: string) => ({ storeId, slug, name: slug, priceCents: 2700, methods: ["pix"], pixMode: "manual" });

/** Cria a oferta e grava nas colunas antigas (product_id/bump_product_id), como era antes da 0023. */
async function legacyOffer(storeId: string, slug: string, productId: string, bump?: string): Promise<string> {
  const [o] = await t.ownerDb
    .insert(offer)
    .values({ ...newOffer(storeId, slug), ...(bump ? { bumpPriceCents: 990, bumpLabel: "Bump" } : {}) })
    .returning({ id: offer.id });
  await t.ownerDb.execute(sql`update offer set product_id = ${productId}, bump_product_id = ${bump ?? null} where id = ${o!.id}`);
  return o!.id;
}

async function withLegacyColumns<T>(run: () => Promise<T>): Promise<T> {
  await t.ownerDb.execute(sql`alter table offer add column product_id uuid, add column bump_product_id uuid`);
  try {
    return await run();
  } finally {
    await t.ownerDb.execute(sql`alter table offer drop column product_id, drop column bump_product_id`);
  }
}

test("backfill: oferta com bump vira main+bump (posição 0); sem bump vira só main; RLS isola por loja", async () => {
  expect(backfill).toHaveLength(2); // um INSERT para o principal e outro para o bump
  const a = await seedStore("A");
  const b = await seedStore("B");
  const [p1, p2, p3] = [await seedProduct(a.storeId, "P1"), await seedProduct(a.storeId, "P2"), await seedProduct(b.storeId, "P3")];
  const [withBump, noBump, other] = await withLegacyColumns(async () => {
    const ids = [await legacyOffer(a.storeId, "com-bump", p1.id, p2.id), await legacyOffer(a.storeId, "sem-bump", p2.id), await legacyOffer(b.storeId, "outra", p3.id)];
    expect(await t.ownerDb.select().from(offerProduct)).toHaveLength(0);
    for (const stmt of backfill) await t.ownerDb.execute(sql.raw(stmt));
    return ids.map((id) => ({ id }));
  });

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
  // e a loja B não grava na A (RLS: with check, 42501).
  const rls = await pgError(() => withStore(b.storeId, (tx) => tx.insert(offerProduct).values({ storeId: a.storeId, offerId: withBump!.id, productId: p3.id, kind: "main", position: 1 })));
  expect(rls.code).toBe("42501");
});

test("restrições: produto repetido, kind e posição inválidos (causa conferida); cascade ao apagar a oferta", async () => {
  const a = await seedStore("A");
  const p = await seedProduct(a.storeId);
  const [o] = await t.ownerDb.insert(offer).values(newOffer(a.storeId, "r")).returning({ id: offer.id });
  const row = { storeId: a.storeId, offerId: o!.id, productId: p.id, kind: "main", position: 0 };
  await t.ownerDb.insert(offerProduct).values(row);
  const q = await seedProduct(a.storeId, "Q");
  expect(await pgError(() => t.ownerDb.insert(offerProduct).values({ ...row, kind: "bump", position: 1 }))).toEqual({ code: "23505", constraint: "offer_product_offer_product_unique" });
  expect(await pgError(() => t.ownerDb.insert(offerProduct).values({ ...row, productId: q.id, kind: "x" }))).toEqual({ code: "23514", constraint: "offer_product_kind_check" });
  expect(await pgError(() => t.ownerDb.insert(offerProduct).values({ ...row, productId: q.id, position: -1 }))).toEqual({ code: "23514", constraint: "offer_product_position_check" });
  // Posição única por grupo: duas gravações concorrentes não podem juntar listas (rede de segurança do setProducts).
  expect(await pgError(() => t.ownerDb.insert(offerProduct).values({ ...row, productId: q.id }))).toEqual({ code: "23505", constraint: "offer_product_offer_kind_position_unique" });
  await t.ownerDb.insert(offerProduct).values({ ...row, productId: q.id, kind: "bump" }); // mesma posição em outro grupo passa
  await t.ownerDb.delete(offer).where(sql`id = ${o!.id}`);
  expect(await t.ownerDb.select().from(offerProduct).where(sql`offer_id = ${o!.id}`)).toHaveLength(0);
});

test("FK composta: linha da loja A não aponta para oferta nem produto da loja B (papel dono, que ignora o RLS)", async () => {
  const a = await seedStore("A");
  const b = await seedStore("B");
  const pa = await seedProduct(a.storeId, "PA");
  const pb = await seedProduct(b.storeId, "PB");
  const [oa, ob] = await t.ownerDb.insert(offer).values([newOffer(a.storeId, "fa"), newOffer(b.storeId, "fb")]).returning({ id: offer.id });
  const base = { storeId: a.storeId, offerId: oa!.id, productId: pa.id, kind: "main", position: 0 };
  expect(await pgError(() => t.ownerDb.insert(offerProduct).values({ ...base, productId: pb.id }))).toEqual({ code: "23503", constraint: "offer_product_product_fk" });
  expect(await pgError(() => t.ownerDb.insert(offerProduct).values({ ...base, offerId: ob!.id }))).toEqual({ code: "23503", constraint: "offer_product_offer_fk" });
  await t.ownerDb.insert(offerProduct).values(base); // a combinação da mesma loja passa
});

test("order_item.position: pedidos sem posição ficam em 0", async () => {
  const col = await t.ownerDb.execute(sql`select column_default, is_nullable from information_schema.columns where table_name = 'order_item' and column_name = 'position'`);
  expect(col[0]).toMatchObject({ column_default: "0", is_nullable: "NO" });
  expect(orderItem.position.default).toBe(0);
});
