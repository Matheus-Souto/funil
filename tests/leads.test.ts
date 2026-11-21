// Tabela `checkout_lead` (abandono antes de comprar): isolamento por loja (RLS) e as restrições do banco.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { checkoutLead, offer, store } from "@/lib/db/schema";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const DAY_MS = 86_400_000;

/** SQLSTATE e constraint do erro do Postgres (o drizzle o embrulha em `cause`). */
async function pgError(run: () => PromiseLike<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run();
  } catch (e) {
    const err = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint_name?: string };
    return { code: err.code, constraint: err.constraint_name };
  }
  return {};
}
const CHECK = "23514";
const UNIQUE = "23505";

async function seedOffer(storeId: string): Promise<string> {
  const [o] = await t.ownerDb
    .insert(offer)
    .values({ storeId, slug: `oferta-${randomUUID()}`, name: "Oferta", priceCents: 990, methods: ["pix"], pixMode: "manual" })
    .returning({ id: offer.id });
  return o!.id;
}

function leadRow(storeId: string, offerId: string, over: Partial<typeof checkoutLead.$inferInsert> = {}): typeof checkoutLead.$inferInsert {
  const email = `contato-${randomUUID()}@example.com`;
  return { storeId, offerId, keyHash: sha(randomUUID()), email, emailHash: sha(email), expiresAt: new Date(Date.now() + 30 * DAY_MS), ...over };
}

describe("checkout_lead", () => {
  test("RLS: contato de outra loja não aparece", async () => {
    const a = await seedStore("Loja A");
    const b = await seedStore("Loja B");
    const offerB = await seedOffer(b.storeId);
    await withStore(b.storeId, (tx) => tx.insert(checkoutLead).values(leadRow(b.storeId, offerB)));

    expect(await withStore(a.storeId, (tx) => tx.select().from(checkoutLead))).toHaveLength(0);
    expect(await withStore(b.storeId, (tx) => tx.select().from(checkoutLead))).toHaveLength(1);
    // gravar com o store_id de outra loja também é recusado
    await expect(withStore(a.storeId, (tx) => tx.insert(checkoutLead).values(leadRow(b.storeId, offerB)))).rejects.toThrow();
  });

  test("check: converted sem e-mail ok, open sem e-mail recusado", async () => {
    const { storeId } = await seedStore("Loja checks");
    const offerId = await seedOffer(storeId);
    const base = leadRow(storeId, offerId);

    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...base, email: null, status: "open" }))).toEqual({ code: CHECK, constraint: "checkout_lead_email_check" });
    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...base, email: null, status: "contacted" }))).toEqual({ code: CHECK, constraint: "checkout_lead_email_check" });
    await t.ownerDb.insert(checkoutLead).values({ ...base, email: null, status: "converted" });
    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...leadRow(storeId, offerId), status: "perdido" }))).toEqual({ code: CHECK, constraint: "checkout_lead_status_check" });
  });

  test("a chave é única por loja, e apagar a oferta apaga o contato", async () => {
    const a = await seedStore("Loja chave A");
    const b = await seedStore("Loja chave B");
    const offerA = await seedOffer(a.storeId);
    const offerB = await seedOffer(b.storeId);
    const keyHash = sha(randomUUID());
    await t.ownerDb.insert(checkoutLead).values(leadRow(a.storeId, offerA, { keyHash }));
    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values(leadRow(a.storeId, offerA, { keyHash })))).toEqual({ code: UNIQUE, constraint: "checkout_lead_store_key_uniq" });
    await t.ownerDb.insert(checkoutLead).values(leadRow(b.storeId, offerB, { keyHash }));

    await t.ownerDb.delete(offer).where(eq(offer.id, offerA));
    const left = await t.ownerDb.select({ n: sql<number>`count(*)::int` }).from(checkoutLead).where(eq(checkoutLead.storeId, a.storeId));
    expect(left[0]!.n).toBe(0);
  });
});

describe("store: captura de contato", () => {
  test("check da loja: lead_capture sem privacy_email recusado", async () => {
    const { storeId } = await seedStore("Loja captura");
    const [padrao] = await t.ownerDb.select({ on: store.leadCapture, mail: store.privacyEmail }).from(store).where(eq(store.id, storeId));
    expect(padrao).toEqual({ on: false, mail: null });

    expect(await pgError(() => t.ownerDb.update(store).set({ leadCapture: true }).where(eq(store.id, storeId)))).toEqual({ code: CHECK, constraint: "store_lead_capture_check" });
    await t.ownerDb.update(store).set({ leadCapture: true, privacyEmail: "privacidade@example.com" }).where(eq(store.id, storeId));
    // com a captura ligada, não dá para apagar o e-mail de privacidade
    expect(await pgError(() => t.ownerDb.update(store).set({ privacyEmail: null }).where(eq(store.id, storeId)))).toEqual({ code: CHECK, constraint: "store_lead_capture_check" });
  });
});
