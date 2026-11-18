import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { job, orders, payment } from "@/lib/db/schema";
import { getHandlers } from "@/lib/jobs/handlers";
import { transitionOrder } from "@/lib/orders/state";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { startAsaasPix } from "@/lib/payments/asaas/pix";
import { handleAsaasWebhook } from "@/lib/payments/asaas/webhook";
import { refundOrder } from "@/lib/payments/refund";
import { createTestDb, type TestDb } from "./db";
import { ctxOf, createFakeAsaas, newAsaasOrder, owner, runRefundJobs, seedAsaasStore } from "./asaas-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setAsaasFetchForTests();
  await t.drop();
});
afterEach(() => setAsaasFetchForTests());

const panel = (storeId: string) => ({ storeId, actor: owner, origin: "panel" as const });
const statusOf = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;
const refundJobs = (orderId: string) =>
  t.ownerDb
    .select()
    .from(job)
    .where(and(eq(job.type, "refund_order"), sql`${job.payload}->>'orderId' = ${orderId}`));
const later = (s: number) => new Date(Date.now() + s * 1000);

async function paidAsaasOrder() {
  const fake = createFakeAsaas();
  const { storeId, offerId, webhookToken } = await seedAsaasStore(fake);
  const order = await newAsaasOrder(storeId, offerId);
  await startAsaasPix({ storeId }, order.id);
  const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
  fake.setStatus(pay!.providerId!, "RECEIVED");
  await t.ownerDb.update(payment).set({ status: "RECEIVED" }).where(eq(payment.id, pay!.id));
  await withStore(storeId, (tx) => transitionOrder(ctxOf(storeId, tx), order.id, "paid", "t"));
  const refundCalls = () => fake.calls.filter((c) => c.method === "POST" && c.path === `/payments/${pay!.providerId}/refund`).length;
  return { fake, storeId, order, providerId: pay!.providerId!, webhookToken, refundCalls };
}

async function idleInTransaction(): Promise<number> {
  const rows = await t.ownerDb.execute(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`,
  );
  return Number((rows as unknown as { n: number }[])[0]!.n);
}

describe("orders.refund (Asaas, assíncrono)", () => {
  test("refund_order está registrado no módulo de handlers", () => {
    expect(typeof getHandlers().refund_order).toBe("function");
  });

  test("a ação só marca refund_requested_at e enfileira o job; o estorno é feito pelo job", async () => {
    const { storeId, order, refundCalls } = await paidAsaasOrder();
    const r = await runAction(refundOrder, panel(storeId), { orderId: order.id });
    expect(r).toMatchObject({ orderId: order.id, status: "refund_requested" });
    expect(r.message).toContain("Estorno solicitado");
    expect(refundCalls()).toBe(0);
    expect(await statusOf(order.id)).toBe("paid");
    const [row] = await t.ownerDb.select().from(orders).where(eq(orders.id, order.id));
    expect(row!.refundRequestedAt).toBeInstanceOf(Date);
    const jobs = await refundJobs(order.id);
    expect(jobs.map((j) => [j.status, j.storeId])).toEqual([["queued", storeId]]);

    await runRefundJobs(later(1));
    expect(refundCalls()).toBe(1);
    expect(await statusOf(order.id)).toBe("refunded");
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    expect(pay!.status).toBe("REFUNDED");
    expect((await refundJobs(order.id))[0]!.status).toBe("done");
    const revoke = (await t.ownerDb.select().from(job).where(eq(job.type, "revoke_downloads"))).filter(
      (j) => (j.payload as { orderId?: string }).orderId === order.id,
    );
    expect(revoke).toHaveLength(1);
  });

  test("pedir de novo com o job ainda na fila não enfileira outro", async () => {
    const { storeId, order } = await paidAsaasOrder();
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    const again = await runAction(refundOrder, panel(storeId), { orderId: order.id });
    expect(again.status).toBe("refund_requested");
    expect(await refundJobs(order.id)).toHaveLength(1);
  });

  test("rodar o job duas vezes chama o estorno do Asaas uma vez só", async () => {
    const { storeId, order, refundCalls } = await paidAsaasOrder();
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    const [j] = await refundJobs(order.id);
    const handler = getHandlers().refund_order!;
    await handler(j!, new AbortController().signal);
    await handler(j!, new AbortController().signal);
    expect(refundCalls()).toBe(1);
    expect(await statusOf(order.id)).toBe("refunded");
  });

  test("estorno feito no Asaas mas a transição não chegou a gravar: a nova execução não estorna de novo e conclui", async () => {
    const { fake, storeId, order, providerId, refundCalls } = await paidAsaasOrder();
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    // Simula "estornou e o processo caiu antes de gravar": o Asaas já está REFUNDED, o pedido segue paid.
    fake.setStatus(providerId, "REFUNDED");
    await runRefundJobs(later(1));
    expect(refundCalls()).toBe(0);
    expect(await statusOf(order.id)).toBe("refunded");
  });

  test("falha do Asaas re-tenta pelo backoff e depois conclui", async () => {
    const { fake, storeId, order, providerId, refundCalls } = await paidAsaasOrder();
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    fake.fail("POST /payments/", 400, "Saldo insuficiente para estorno");
    const t0 = later(1);
    await runRefundJobs(t0);
    const [j] = await refundJobs(order.id);
    expect([j!.status, j!.attempts]).toEqual(["queued", 1]);
    expect(j!.runAt.getTime()).toBe(t0.getTime() + 60_000);
    expect(await statusOf(order.id)).toBe("paid");
    fake.clearFailures();
    await runRefundJobs(new Date(t0.getTime() + 60_000));
    // Uma tentativa recusada pelo Asaas + a que deu certo.
    expect(refundCalls()).toBe(2);
    expect(fake.payments.get(providerId)!.status).toBe("REFUNDED");
    expect(await statusOf(order.id)).toBe("refunded");
    expect((await refundJobs(order.id))[0]!.status).toBe("done");
  });

  test("webhook REFUNDED chegando antes do job: o job não estorna de novo", async () => {
    const { fake, storeId, order, providerId, webhookToken, refundCalls } = await paidAsaasOrder();
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    fake.setStatus(providerId, "REFUNDED");
    const r = await handleAsaasWebhook(storeId, new Headers({ "asaas-access-token": webhookToken }), { event: "PAYMENT_REFUNDED", payment: { id: providerId } });
    expect(r.status).toBe(200);
    expect(await statusOf(order.id)).toBe("refunded");
    const before = fake.calls.length;
    await runRefundJobs(later(1));
    expect(refundCalls()).toBe(0);
    expect(fake.calls.length).toBe(before);
    expect((await refundJobs(order.id))[0]!.status).toBe("done");
  });

  test("o job não faz HTTP com transação aberta", async () => {
    const { fake, storeId, order } = await paidAsaasOrder();
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    const seen: number[] = [];
    setAsaasFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(await idleInTransaction());
      return fake.fetch(input, init);
    }) as typeof fetch);
    await runRefundJobs(later(1));
    expect(seen.length).toBeGreaterThanOrEqual(2); // consulta + estorno
    expect(seen.every((n) => n === 0)).toBe(true);
    expect(await statusOf(order.id)).toBe("refunded");
  });

  test("a ação não chama o Asaas", async () => {
    const { fake, storeId, order } = await paidAsaasOrder();
    const before = fake.calls.length;
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    expect(fake.calls.length).toBe(before);
  });

  test("com várias cobranças no pedido, estorna só a paga e não duplicada", async () => {
    const { fake, storeId, order, providerId } = await paidAsaasOrder();
    const base = { storeId, orderId: order.id, provider: "asaas", amountCents: 990 };
    await t.ownerDb.insert(payment).values([
      { ...base, providerId: "pay_velha_overdue", status: "OVERDUE" },
      { ...base, providerId: "pay_dup_paga", status: "RECEIVED", raw: { duplicate: true } },
    ]);
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    await runRefundJobs(later(1));
    const refunds = fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/refund")).map((c) => c.path);
    expect(refunds).toEqual([`/payments/${providerId}/refund`]);
  });

  test("sem cobrança paga e não duplicada -> conflict, nada muda e nada é enfileirado", async () => {
    const { storeId, order, providerId } = await paidAsaasOrder();
    await t.ownerDb.update(payment).set({ status: "OVERDUE" }).where(eq(payment.providerId, providerId));
    const e = await runAction(refundOrder, panel(storeId), { orderId: order.id }).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
    expect(await statusOf(order.id)).toBe("paid");
    expect(await refundJobs(order.id)).toHaveLength(0);
  });

  test("só pedidos pagos são reembolsáveis", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const e = await runAction(refundOrder, panel(storeId), { orderId: order.id }).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
  });

  test("Pix manual: muda o estado na hora e avisa para devolver pelo banco (sem Asaas, sem job)", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const base = await newAsaasOrder(storeId, offerId);
    await t.ownerDb.update(orders).set({ method: "pix_manual", status: "paid" }).where(eq(orders.id, base.id));
    const before = fake.calls.length;
    const r = await runAction(refundOrder, panel(storeId), { orderId: base.id });
    expect(r.message).toContain("banco");
    expect(r.status).toBe("refunded");
    expect(await statusOf(base.id)).toBe("refunded");
    expect(fake.calls.length).toBe(before);
    expect(await refundJobs(base.id)).toHaveLength(0);
  });

  test("é sensível e exige a permissão orders.refund", async () => {
    const { storeId, order } = await paidAsaasOrder();
    const mcp = await runAction(refundOrder, { storeId, actor: owner, origin: "mcp" }, { orderId: order.id }).catch((x: unknown) => x);
    expect((mcp as ActionError).code).toBe("approval_required");
    const support = { kind: "user" as const, userId: "u2", role: "support" as const };
    const f = await runAction(refundOrder, { storeId, actor: support, origin: "panel" }, { orderId: order.id }).catch((x: unknown) => x);
    expect((f as ActionError).code).toBe("forbidden");
    expect(await refundJobs(order.id)).toHaveLength(0);
  });
});
