import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { runAction } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { createProduct } from "@/lib/catalog/products";
import { withStore } from "@/lib/db/client";
import { job, orders } from "@/lib/db/schema";
import { enqueue, runDueJobs, scheduleOnce, type JobType } from "@/lib/jobs";
import { expireOrdersHandler } from "@/lib/jobs/handlers";
import { createOrder } from "@/lib/orders/create";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const T0 = new Date("2030-01-01T00:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const enq = (type: JobType, payload: unknown = {}, storeId: string | null = null, runAt = T0) =>
  t.db.transaction((tx) => enqueue(tx, { storeId, type, payload, runAt }));
const row = (id: string) => t.ownerDb.select().from(job).where(eq(job.id, id)).then((r) => r[0]!);
const newest = (type: JobType) => t.ownerDb.select().from(job).where(eq(job.type, type)).then((r) => r.at(-1)!);

describe("runDueJobs", () => {
  test("executa job vencido uma vez e marca done", async () => {
    await enq("notify_seller", { orderId: "x" });
    const seen: unknown[] = [];
    const n = await runDueJobs({ notify_seller: async (j) => void seen.push(j.payload) }, 10, at(1));
    expect(n).toBe(1);
    expect(seen).toEqual([{ orderId: "x" }]);
    expect(await runDueJobs({ notify_seller: async () => undefined }, 10, at(2))).toBe(0);
  });

  test("não executa job com run_at no futuro", async () => {
    await enq("deliver_order", {}, null, at(100));
    expect(await runDueJobs({ deliver_order: async () => undefined }, 10, at(50))).toBe(0);
    expect(await runDueJobs({ deliver_order: async () => undefined }, 10, at(100))).toBe(1);
  });

  test("falhas reagendam em 60, 300, 1800, 7200, 43200 s e depois failed", async () => {
    await enq("meta_event", {}, null, T0);
    const id = (await newest("meta_event")).id;
    const boom = { meta_event: async () => { throw new Error("falhou"); } };
    let now = T0;
    for (const delay of [60, 300, 1800, 7200, 43200]) {
      expect(await runDueJobs(boom, 10, now)).toBe(1);
      const r = await row(id);
      expect(r.status).toBe("queued");
      expect(r.runAt.getTime()).toBe(now.getTime() + delay * 1000);
      // ainda não venceu um segundo antes
      expect(await runDueJobs(boom, 10, new Date(r.runAt.getTime() - 1000))).toBe(0);
      now = r.runAt;
    }
    expect(await runDueJobs(boom, 10, now)).toBe(1);
    const last = await row(id);
    expect(last.status).toBe("failed");
    expect(last.attempts).toBe(6);
    expect(await runDueJobs(boom, 10, at(10_000_000))).toBe(0);
  });

  test("last_error é redigido e truncado em 500 caracteres", async () => {
    await enq("revoke_downloads");
    const id = (await newest("revoke_downloads")).id;
    await runDueJobs({ revoke_downloads: async () => { throw new Error(`cartao 4111 1111 1111 1111 ${"x".repeat(900)}`); } }, 10, at(1));
    const r = await row(id);
    expect(r.lastError!.length).toBeLessThanOrEqual(500);
    expect(r.lastError).not.toContain("4111");
  });

  test("tipo sem handler vira failed com 'sem handler', sem repetir", async () => {
    await enq("expire_orders");
    const id = (await newest("expire_orders")).id;
    expect(await runDueJobs({}, 10, at(1))).toBe(1);
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.lastError).toBe("sem handler");
    await runDueJobs({}, 10, at(100_000));
    expect((await row(id)).attempts).toBe(1);
  });

  test("respeita o limite e execuções concorrentes não repetem job", async () => {
    for (let i = 0; i < 4; i++) await enq("deliver_order", { i }, null, at(-1000));
    const seen: number[] = [];
    const h = { deliver_order: async (j: { payload: unknown }) => void seen.push((j.payload as { i: number }).i) };
    expect(await runDueJobs(h, 1, T0)).toBe(1);
    const rs = await Promise.all([runDueJobs(h, 10, T0), runDueJobs(h, 10, T0)]);
    expect(rs[0] + rs[1]).toBe(3);
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  test("scheduleOnce não duplica enquanto houver um queued", async () => {
    await t.ownerDb.delete(job).where(eq(job.type, "expire_orders"));
    expect(await scheduleOnce("expire_orders", T0)).toBe(true);
    expect(await scheduleOnce("expire_orders", T0)).toBe(false);
    const all = await t.ownerDb.select().from(job).where(eq(job.type, "expire_orders"));
    expect(all).toHaveLength(1);
  });
});

describe("expire_orders", () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(16, 65)]).toString("base64");
  async function seedOffer(storeId: string) {
    const call = { storeId, actor: { kind: "user", userId: "u", role: "owner" } as const, origin: "panel" as const };
    const p = await runAction(createProduct, call, { name: "P", fileName: "p.pdf", fileBase64: pdf });
    return runAction(createOffer, call, { slug: "oferta", name: "O", productId: p.id, priceCents: 990, methods: ["pix"], pixMode: "manual" });
  }
  const mk = async (storeId: string, offerId: string, expiresAt: Date | null, status: string) => {
    const o = await withStore(storeId, (tx) =>
      createOrder(
        { storeId, actor: { kind: "public" }, origin: "public", tx },
        {
          offerId,
          withBump: false,
          method: "pix_manual",
          customer: { name: "A", email: `${crypto.randomUUID()}@x.com`, phone: "1" },
          touch: { first: null, last: null },
          clientIp: "1.1.1.1",
          userAgent: "x",
        },
      ),
    );
    await t.ownerDb.update(orders).set({ expiresAt, status }).where(eq(orders.id, o.id));
    return o.id;
  };

  test("expira só pedidos pending vencidos, em cada loja", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const oa = await seedOffer(a.storeId);
    const ob = await seedOffer(b.storeId);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    const ids = {
      a1: await mk(a.storeId, oa.id, past, "pending"),
      a2: await mk(a.storeId, oa.id, future, "pending"),
      b1: await mk(b.storeId, ob.id, past, "pending"),
      b2: await mk(b.storeId, ob.id, past, "paid"),
      b3: await mk(b.storeId, ob.id, null, "pending"),
    };
    await expireOrdersHandler({} as never);
    const st = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;
    expect(await st(ids.a1)).toBe("expired");
    expect(await st(ids.a2)).toBe("pending");
    expect(await st(ids.b1)).toBe("expired");
    expect(await st(ids.b2)).toBe("paid");
    expect(await st(ids.b3)).toBe("pending");
  });
});
