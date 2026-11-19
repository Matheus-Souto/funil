import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { runAction } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { withStore } from "@/lib/db/client";
import { job, orders } from "@/lib/db/schema";
import { enqueue, runDueJobs, scheduleOnce, type JobType } from "@/lib/jobs";
import { createExpireOrdersHandler, expireOrdersHandler } from "@/lib/jobs/handlers";
import { log } from "@/lib/log";
import { createOrder } from "@/lib/orders/create";
import { createTestDb, seedProduct, seedStore, type TestDb } from "./db";

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

  test("opção types: só reivindica os tipos pedidos; os demais nem são tocados (attempts e run_at intactos)", async () => {
    await enq("meta_event", { orderId: "outro" }, null, at(-5));
    const other = await newest("meta_event");
    await enq("refund_order", { orderId: "r" }, null, at(-5));
    const seen: unknown[] = [];
    const n = await runDueJobs({ refund_order: async (j) => void seen.push(j.payload) }, 10, at(1), { types: ["refund_order"] });
    expect(n).toBe(1);
    expect(seen).toEqual([{ orderId: "r" }]);
    const after = await row(other.id);
    expect([after.status, after.attempts, after.runAt.getTime()]).toEqual(["queued", 0, at(-5).getTime()]);
    await t.ownerDb.delete(job).where(eq(job.id, other.id));
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

  test("tipo sem handler volta para queued em 10 min, sem contar tentativa, com um único aviso por execução", async () => {
    await t.ownerDb.delete(job).where(eq(job.type, "expire_orders"));
    await enq("expire_orders", { n: 1 });
    await enq("expire_orders", { n: 2 });
    const ids = (await t.ownerDb.select().from(job).where(eq(job.type, "expire_orders"))).map((r) => r.id);
    const warn = spyOn(log, "warn");
    try {
      await runDueJobs({}, 10, at(1));
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.filter((m) => m.includes("sem handler"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    for (const id of ids) {
      const r = await row(id);
      expect([r.status, r.attempts, r.lockedAt]).toEqual(["queued", 0, null]);
      expect(r.runAt.getTime()).toBe(at(1).getTime() + 10 * 60_000);
    }
    // Nunca vira failed: adiado de novo a cada execução enquanto o tipo não tiver handler.
    await runDueJobs({}, 10, at(1 + 600));
    expect((await row(ids[0]!)).status).toBe("queued");
    expect((await row(ids[0]!)).attempts).toBe(0);
    // Com o handler registrado, roda normalmente.
    await runDueJobs({ expire_orders: async () => undefined }, 10, at(1 + 1200));
    for (const id of ids) expect((await row(id)).status).toBe("done");
  });

  test("handler que não termina estoura o tempo-limite (padrão 120 s): conta como falha e o worker segue", async () => {
    await enq("notify_seller", { hang: true }, null, at(-20));
    const hungId = (await newest("notify_seller")).id;
    await enq("notify_seller", { hang: false }, null, at(-10));
    const okId = (await newest("notify_seller")).id;
    const timeouts: number[] = [];
    let fire: (() => void) | undefined;
    // Relógio do tempo-limite injetado: o handler "pendurado" faz o tempo passar disparando o timer.
    const timer = (ms: number, onTimeout: () => void) => {
      timeouts.push(ms);
      fire = onTimeout;
      return () => void (fire = undefined);
    };
    let hungSignal: AbortSignal | undefined;
    const handlers = {
      notify_seller: async (j: { payload: unknown }, signal: AbortSignal) => {
        if ((j.payload as { hang: boolean }).hang) {
          hungSignal = signal;
          fire!();
          return new Promise<void>(() => undefined);
        }
      },
    };
    expect(await runDueJobs(handlers, 2, T0, { timer })).toBe(2);
    expect(timeouts).toEqual([120_000, 120_000]);
    expect(hungSignal?.aborted).toBe(true);
    const hung = await row(hungId);
    expect([hung.status, hung.attempts, hung.lockedAt]).toEqual(["queued", 1, null]);
    expect(hung.runAt.getTime()).toBe(T0.getTime() + 60_000);
    expect(hung.lastError).toContain("tempo-limite");
    expect((await row(okId)).status).toBe("done");
    await t.ownerDb.update(job).set({ status: "done" }).where(eq(job.id, hungId));
  });

  test("tempo-limite configurável", async () => {
    await enq("notify_seller", { quick: true }, null, at(-5));
    const timeouts: number[] = [];
    await runDueJobs({ notify_seller: async () => undefined }, 1, T0, { timeoutMs: 5000, timer: (ms) => (timeouts.push(ms), () => undefined) });
    expect(timeouts).toEqual([5000]);
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

  test("handler que lança deixa o job queued com o run_at do backoff", async () => {
    await enq("notify_seller", { k: "throw" }, null, T0);
    const id = (await newest("notify_seller")).id;
    await runDueJobs({ notify_seller: async () => { throw new Error("x"); } }, 1, T0);
    const r = await row(id);
    expect([r.status, r.attempts, r.lockedAt]).toEqual(["queued", 1, null]);
    expect(r.runAt.getTime()).toBe(T0.getTime() + 60_000);
    await t.ownerDb.update(job).set({ status: "done" }).where(eq(job.id, id));
  });

  test("running travado há 11 min volta à fila e roda; há 5 min não", async () => {
    const mkRunning = async (lockedMinAgo: number) => {
      await enq("deliver_order", {}, null, at(-10_000));
      const id = (await newest("deliver_order")).id;
      await t.ownerDb
        .update(job)
        .set({ status: "running", attempts: 1, lockedAt: new Date(T0.getTime() - lockedMinAgo * 60_000) })
        .where(eq(job.id, id));
      return id;
    };
    const stuck = await mkRunning(11);
    const fresh = await mkRunning(5);
    const seen: string[] = [];
    await runDueJobs({ deliver_order: async (j) => void seen.push(j.id) }, 10, T0);
    expect(seen).toContain(stuck);
    expect(seen).not.toContain(fresh);
    expect((await row(stuck)).status).toBe("done");
    expect((await row(stuck)).attempts).toBe(2);
    expect((await row(fresh)).status).toBe("running");
    await t.ownerDb.delete(job).where(eq(job.id, fresh));
  });

  test("finalização obsoleta de um worker lento não sobrescreve a reivindicação seguinte", async () => {
    await enq("revoke_downloads", { stale: true }, null, T0);
    const id = (await newest("revoke_downloads")).id;
    const lockB = at(11 * 60);
    for (const outcome of ["done", "throw"] as const) {
      await t.ownerDb.update(job).set({ status: "queued", attempts: 0, lockedAt: null, runAt: T0 }).where(eq(job.id, id));
      await runDueJobs(
        {
          revoke_downloads: async () => {
            // Worker A está lento; o worker B já reivindicou o job (ainda running, claim mais novo).
            await t.ownerDb.update(job).set({ status: "running", lockedAt: lockB, attempts: 2 }).where(eq(job.id, id));
            if (outcome === "throw") throw new Error("falha tardia");
          },
        },
        1,
        T0,
      );
      const r = await row(id);
      expect([r.status, r.attempts, r.lockedAt?.getTime(), r.lastError]).toEqual(["running", 2, lockB.getTime(), null]);
    }
    await t.ownerDb.update(job).set({ status: "done" }).where(eq(job.id, id));
  });

  test("locked_at vem de leitura nova do relógio a cada claim", async () => {
    await enq("deliver_order", { c: 1 }, null, at(-1));
    await enq("deliver_order", { c: 2 }, null, at(-1));
    let tick = 0;
    const clock = () => at(tick++);
    const locks: number[] = [];
    const h = { deliver_order: async (j: { lockedAt: Date | null }) => void locks.push(j.lockedAt!.getTime()) };
    await runDueJobs(h, 2, clock);
    expect(locks).toHaveLength(2);
    expect(locks[1]).toBeGreaterThan(locks[0]!);
  });

  test("nenhuma transação aberta enquanto o handler roda", async () => {
    await enq("meta_event", {}, null, T0);
    let idle = -1;
    await runDueJobs(
      {
        meta_event: async () => {
          const rows = await t.ownerDb.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`,
          );
          idle = rows[0]!.n;
        },
      },
      1,
      T0,
    );
    expect(idle).toBe(0);
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
  async function seedOffer(storeId: string) {
    const call = { storeId, actor: { kind: "user", userId: "u", role: "owner" } as const, origin: "panel" as const };
    const p = await seedProduct(storeId, "P");
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
    await expireOrdersHandler({} as never, new AbortController().signal);
    const st = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;
    expect(await st(ids.a1)).toBe("expired");
    expect(await st(ids.a2)).toBe("pending");
    expect(await st(ids.b1)).toBe("expired");
    expect(await st(ids.b2)).toBe("paid");
    expect(await st(ids.b3)).toBe("pending");
  });

  test("pedido que vira pago entre o select e a transição é pulado (conflict) e os demais expiram", async () => {
    const a = await seedStore();
    const oa = await seedOffer(a.storeId);
    // Criados já vencidos, o 2º pedido Pix manual expiraria o 1º ao alocar o valor; por isso vencem depois de criados.
    const future = new Date(Date.now() + 3_600_000);
    const raced = await mk(a.storeId, oa.id, future, "pending");
    const other = await mk(a.storeId, oa.id, future, "pending");
    await t.ownerDb.update(orders).set({ expiresAt: new Date(Date.now() - 60_000) }).where(inArray(orders.id, [raced, other]));
    const h = createExpireOrdersHandler(async (tx, id) => {
      if (id === raced) await tx.update(orders).set({ status: "paid" }).where(eq(orders.id, id));
    });
    await h({} as never, new AbortController().signal);
    const st = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;
    expect(await st(raced)).toBe("paid");
    expect(await st(other)).toBe("expired");
  });

  test("pedido travado por outra transação é pulado, sem bloquear", async () => {
    const a = await seedStore();
    const oa = await seedOffer(a.storeId);
    const locked = await mk(a.storeId, oa.id, new Date(Date.now() - 60_000), "pending");
    await withStore(a.storeId, async (tx) => {
      await tx.select().from(orders).where(eq(orders.id, locked)).for("update");
      await expireOrdersHandler({} as never, new AbortController().signal);
    });
    expect((await t.ownerDb.select().from(orders).where(eq(orders.id, locked)))[0]!.status).toBe("pending");
  });

  test("erro numa loja não impede as outras e o job falha no fim", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const oa = await seedOffer(a.storeId);
    const ob = await seedOffer(b.storeId);
    const past = new Date(Date.now() - 60_000);
    const bad = await mk(a.storeId, oa.id, past, "pending");
    const good = await mk(b.storeId, ob.id, past, "pending");
    const h = createExpireOrdersHandler(async (_tx, id) => {
      if (id === bad) throw new Error("boom");
    });
    const err = await h({} as never, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const st = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;
    expect(await st(bad)).toBe("pending");
    expect(await st(good)).toBe("expired");
  });
});
