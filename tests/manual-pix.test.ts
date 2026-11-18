import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import fc from "fast-check";
import { ActionError, runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { createProduct } from "@/lib/catalog/products";
import { withStore } from "@/lib/db/client";
import { job, orders, payment } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { createOrder } from "@/lib/orders/create";
import { buildPixBrCode } from "@/lib/payments/brcode";
import { allocateManualAmount, isUniqueViolation, manualPixBrCode, releaseOrder, savePixManual } from "@/lib/payments/manual";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const support: Actor = { kind: "user", userId: "u2", role: "support" };
const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(16, 65)]).toString("base64");
const ctxOf = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "public" }, origin: "public", tx });

async function seedOffer(storeId: string, priceCents = 990, pixMode: "manual" | "asaas" = "manual") {
  const call = { storeId, actor: owner, origin: "panel" as const };
  const main = await runAction(createProduct, call, { name: "Principal", fileName: "a.pdf", fileBase64: pdf });
  return runAction(createOffer, call, {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Oferta",
    productId: main.id,
    priceCents,
    methods: ["pix", "card"],
    pixMode,
  });
}

const orderInput = (offerId: string, method: "pix_manual" | "pix_asaas" = "pix_manual") => ({
  offerId,
  withBump: false,
  method,
  customer: { name: "Ana", email: "ana@example.com", phone: "11999999999" },
  touch: { first: null, last: null },
  clientIp: "127.0.0.1",
  userAgent: "bun-test",
});
const newOrder = (storeId: string, offerId: string, method: "pix_manual" | "pix_asaas" = "pix_manual") =>
  withStore(storeId, (tx) => createOrder(ctxOf(storeId, tx), orderInput(offerId, method)));

describe("alocação do valor único", () => {
  test("10 pedidos simultâneos de 990 recebem 10 valores distintos entre 991 e 1089", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const created = await Promise.all(Array.from({ length: 10 }, () => newOrder(storeId, offer.id)));
    const amounts = created.map((o) => o.manualAmountCents!);
    expect(new Set(amounts).size).toBe(10);
    for (const a of amounts) {
      expect(a).toBeGreaterThanOrEqual(991);
      expect(a).toBeLessThanOrEqual(1089);
    }
    for (const o of created) {
      expect(o.totalCents).toBe(990);
      expect(o.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect(o.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
    }
  });

  test("propriedade: N alocações concorrentes no mesmo total são distintas e ficam em total+1..total+99", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 100, max: 50_000 }), fc.integer({ min: 2, max: 20 }), async (price, n) => {
        const { storeId } = await seedStore();
        const offer = await seedOffer(storeId, price);
        const created = await Promise.all(Array.from({ length: n }, () => newOrder(storeId, offer.id)));
        const amounts = created.map((o) => o.manualAmountCents!);
        expect(new Set(amounts).size).toBe(n);
        for (const a of amounts) {
          expect(a).toBeGreaterThanOrEqual(price + 1);
          expect(a).toBeLessThanOrEqual(price + 99);
        }
      }),
      { numRuns: 6 },
    );
  }, 60_000);

  test("o menor offset livre é escolhido", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const a = await newOrder(storeId, offer.id);
    const b = await newOrder(storeId, offer.id);
    expect([a.manualAmountCents, b.manualAmountCents]).toEqual([991, 992]);
  });

  test("totais diferentes não colidem no mesmo valor (990+11 vs 1000+1)", async () => {
    const { storeId } = await seedStore();
    const o990 = await seedOffer(storeId, 990);
    const o1000 = await seedOffer(storeId, 1000);
    const amounts: number[] = [];
    for (let i = 0; i < 11; i++) amounts.push((await newOrder(storeId, o990.id)).manualAmountCents!);
    for (let i = 0; i < 5; i++) amounts.push((await newOrder(storeId, o1000.id)).manualAmountCents!);
    expect(new Set(amounts).size).toBe(16);
  });

  test("99 pendentes: o 100º lança pix_manual_exhausted; validade cai para 2 h com 50+", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const all = [];
    for (let i = 0; i < 99; i++) all.push(await newOrder(storeId, offer.id));
    expect(new Set(all.map((o) => o.manualAmountCents)).size).toBe(99);
    expect(all[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const last = all[98]!.expiresAt!.getTime();
    expect(last).toBeLessThanOrEqual(Date.now() + 2 * 3600_000);
    const err = await newOrder(storeId, offer.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).code).toBe("conflict");
    expect((err as ActionError).message).toBe("pix_manual_exhausted");
  }, 60_000);

  test("pedido expirado libera o offset", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const a = await newOrder(storeId, offer.id);
    expect(a.manualAmountCents).toBe(991);
    await t.ownerDb.update(orders).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(orders.id, a.id));
    const b = await newOrder(storeId, offer.id);
    expect(b.manualAmountCents).toBe(991);
    const [row] = await t.ownerDb.select().from(orders).where(eq(orders.id, a.id));
    expect(row!.status).toBe("expired");
  });

  test("`skip` pula offsets e o índice único parcial barra duplicatas pendentes", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const a = await newOrder(storeId, offer.id);
    const next = await withStore(storeId, (tx) => allocateManualAmount(ctxOf(storeId, tx), 990, { skip: [992] }));
    expect(next.amountCents).toBe(993);
    const dup = async () => {
      await t.ownerDb.insert(orders).values({ ...a, id: crypto.randomUUID(), publicId: "dup-public-id-0000000" });
    };
    const e = await dup().then(() => null, (x: unknown) => x);
    expect(isUniqueViolation(e)).toBe(true);
  });

  test("pedido Pix do Asaas não recebe valor manual", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId, 990, "asaas");
    const o = await newOrder(storeId, offer.id, "pix_asaas");
    expect(o.manualAmountCents).toBeNull();
  });
});

describe("BR Code do pedido e conexão", () => {
  test("savePixManual normaliza, valida a chave e não guarda segredo", async () => {
    const { storeId } = await seedStore();
    const call = { storeId, actor: owner, origin: "panel" as const };
    const out = await runAction(savePixManual, call, { key: "123.456.789-09", name: "José da Silva", city: "São Paulo" });
    expect(out).toEqual({ key: "12345678909", name: "Jose da Silva", city: "Sao Paulo" });
    const conn = await withStore(storeId, (tx) => getIntegration(tx, storeId, "pix_manual"));
    expect(conn).toEqual({ config: out, secret: null });
    for (const key of ["Ana@Exemplo.com", "+5511999999999", "123e4567-e89b-12d3-a456-426614174000", "12345678000199"]) {
      await runAction(savePixManual, call, { key, name: "N", city: "C" });
    }
    for (const key of ["abc", "12345", "+1555", "a@b", "x".repeat(40)]) {
      await expect(runAction(savePixManual, call, { key, name: "N", city: "C" })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(runAction(savePixManual, { ...call, actor: { kind: "user", userId: "u", role: "admin" } }, { key: "a@b.co", name: "N", city: "C" })).rejects.toMatchObject({ code: "forbidden" });
  });

  test("manualPixBrCode usa a chave da loja, o valor único e o txid do pedido", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id);
    expect(await withStore(storeId, (tx) => manualPixBrCode(ctxOf(storeId, tx), o))).toBeNull();
    await runAction(savePixManual, { storeId, actor: owner, origin: "panel" }, { key: "teste@exemplo.com", name: "Fulano", city: "SAO PAULO" });
    const code = await withStore(storeId, (tx) => manualPixBrCode(ctxOf(storeId, tx), o));
    const txid = o.publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 25);
    expect(code).toBe(buildPixBrCode({ key: "teste@exemplo.com", name: "Fulano", city: "SAO PAULO", amountCents: o.manualAmountCents!, txid }));
  });
});

describe("orders.release", () => {
  test("libera Pix manual pendente: paid, pagamento manual no valor único e jobs", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id);
    await runAction(releaseOrder, { storeId, actor: owner, origin: "panel" }, { orderId: o.id });
    const [row] = await t.ownerDb.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe("paid");
    const pays = await t.ownerDb.select().from(payment).where(eq(payment.orderId, o.id));
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ provider: "manual", providerId: null, amountCents: 991 });
    const jobs = await t.ownerDb.select().from(job).where(eq(job.type, "deliver_order"));
    expect(jobs.filter((j) => (j.payload as { orderId?: string }).orderId === o.id)).toHaveLength(1);
    // segunda liberação: já não está pendente
    await expect(runAction(releaseOrder, { storeId, actor: owner, origin: "panel" }, { orderId: o.id })).rejects.toMatchObject({ code: "conflict" });
  });

  test("pedido Asaas -> conflict; inexistente -> not_found; support -> forbidden; mcp/ai -> approval_required", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId, 990, "asaas");
    const asaas = await newOrder(storeId, offer.id, "pix_asaas");
    const call = { storeId, actor: owner, origin: "panel" as const };
    await expect(runAction(releaseOrder, call, { orderId: asaas.id })).rejects.toMatchObject({ code: "conflict" });
    await expect(runAction(releaseOrder, call, { orderId: crypto.randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    await expect(runAction(releaseOrder, { ...call, actor: support }, { orderId: asaas.id })).rejects.toMatchObject({ code: "forbidden" });
    for (const origin of ["mcp", "ai"] as const) {
      await expect(runAction(releaseOrder, { ...call, origin }, { orderId: asaas.id })).rejects.toMatchObject({ code: "approval_required" });
    }
  });

  test("pedido de outra loja não é liberado (RLS) e fica pendente", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const offer = await seedOffer(a.storeId);
    const o = await newOrder(a.storeId, offer.id);
    await expect(runAction(releaseOrder, { storeId: b.storeId, actor: owner, origin: "panel" }, { orderId: o.id })).rejects.toMatchObject({ code: "not_found" });
    const [row] = await t.ownerDb.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe("pending");
  });
});
