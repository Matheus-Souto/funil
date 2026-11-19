import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { job, orders, payment, storeAlert } from "@/lib/db/schema";
import { getHandlers } from "@/lib/jobs/handlers";
import { transitionOrder } from "@/lib/orders/state";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { startAsaasPix } from "@/lib/payments/asaas/pix";
import { handleAsaasWebhook } from "@/lib/payments/asaas/webhook";
import { log } from "@/lib/log";
import { refundOrder } from "@/lib/payments/refund";
import { classifyInstallmentRefund, classifyRefund, installmentParcels, installmentRefundedCents, refundItems } from "@/lib/payments/asaas/refunds";
import { getOrderDetail } from "@/lib/orders/panel";
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
const cancelNotices = async (orderId: string) =>
  (
    await t.ownerDb
      .select()
      .from(job)
      .where(and(eq(job.type, "notify_seller"), sql`${job.payload}->>'orderId' = ${orderId}`, sql`${job.payload}->>'reason' = 'estorno_cancelado'`))
  ).length;

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

  test("falha transitória do Asaas (5xx) re-tenta pelo backoff e depois conclui", async () => {
    const { fake, storeId, order, providerId, refundCalls } = await paidAsaasOrder();
    await runAction(refundOrder, panel(storeId), { orderId: order.id });
    fake.fail("POST /payments/", 503, "Asaas fora do ar");
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

describe("refund_order: estorno que fica pendente no Asaas (refunds[])", () => {
  const hook = (s: { storeId: string; webhookToken: string }, paymentId: string, ev = "PAYMENT_UPDATED") =>
    handleAsaasWebhook(s.storeId, new Headers({ "asaas-access-token": s.webhookToken }), { event: ev, payment: { id: paymentId } });
  const requestedAt = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.refundRequestedAt;

  test("estorno PENDING: o pedido continua paid, o job conclui sem transição e não estorna de novo", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(1));
    expect(s.refundCalls()).toBe(1);
    expect(await statusOf(s.order.id)).toBe("paid");
    expect((await refundJobs(s.order.id))[0]!.status).toBe("done");
    const [j] = await refundJobs(s.order.id);
    await getHandlers().refund_order!(j!, new AbortController().signal);
    expect(s.refundCalls()).toBe(1);
    expect(await statusOf(s.order.id)).toBe("paid");
  });

  test("queda entre o POST do estorno e a transição: a nova execução vê refunds[PENDING] e não faz outro POST", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    // O estorno é aceito pelo Asaas, mas a resposta se perde: o job falha e volta pelo backoff.
    s.fake.loseResponse(`POST /payments/${s.providerId}/refund`);
    const t0 = later(1);
    await runRefundJobs(t0);
    expect((await refundJobs(s.order.id))[0]!.status).toBe("queued");
    s.fake.clearFailures();
    await runRefundJobs(new Date(t0.getTime() + 60_000));
    expect(s.refundCalls()).toBe(1);
    expect(await statusOf(s.order.id)).toBe("paid");
    expect((await refundJobs(s.order.id))[0]!.status).toBe("done");
  });

  test("estorno DONE (cobrança ainda CONFIRMED/RECEIVED): o webhook leva o pedido a refunded", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(1));
    s.fake.setRefundStatus(s.providerId, "DONE");
    expect(s.fake.payments.get(s.providerId)!.status).toBe("RECEIVED");
    expect((await hook(s, s.providerId, "PAYMENT_REFUNDED")).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("refunded");
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.providerId, s.providerId));
    expect(pay!.status).toBe("REFUNDED");
  });

  test("estorno DONE: uma nova execução do job também conclui (sem novo POST)", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(1));
    s.fake.setRefundStatus(s.providerId, "DONE");
    const [j] = await refundJobs(s.order.id);
    await getHandlers().refund_order!(j!, new AbortController().signal);
    expect(s.refundCalls()).toBe(1);
    expect(await statusOf(s.order.id)).toBe("refunded");
  });

  test("estorno CANCELLED: o pedido segue paid, refund_requested_at é limpo e o vendedor é avisado no log", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(1));
    expect(await requestedAt(s.order.id)).toBeInstanceOf(Date);
    s.fake.setRefundStatus(s.providerId, "CANCELLED");
    const warn = spyOn(log, "warn");
    try {
      expect((await hook(s, s.providerId)).status).toBe(200);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("estorno cancelado"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(await statusOf(s.order.id)).toBe("paid");
    expect(await requestedAt(s.order.id)).toBeNull();
    expect(await cancelNotices(s.order.id)).toBe(1); // aviso por e-mail ao vendedor (notify_seller)
    // O job não age mais sobre um pedido cujo pedido de estorno foi cancelado.
    const [j] = await refundJobs(s.order.id);
    await getHandlers().refund_order!(j!, new AbortController().signal);
    expect(s.refundCalls()).toBe(1);
  });

  test("estorno cancelado antes e o vendedor pede de novo: o job faz um POST novo", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(1));
    s.fake.setRefundStatus(s.providerId, "CANCELLED");
    await hook(s, s.providerId);
    s.fake.setRefundMode("immediate");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(2));
    expect(s.refundCalls()).toBe(2);
    expect(await statusOf(s.order.id)).toBe("refunded");
  });

  test("retentativa do job que encontra só estornos CANCELLED não estorna de novo: limpa e avisa", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    // POST aceito, resposta perdida (job falha); antes da retentativa o estorno é cancelado e o webhook não chegou.
    s.fake.loseResponse(`POST /payments/${s.providerId}/refund`);
    const t0 = later(1);
    await runRefundJobs(t0);
    s.fake.clearFailures();
    s.fake.setRefundStatus(s.providerId, "CANCELLED");
    await runRefundJobs(new Date(t0.getTime() + 60_000));
    expect(s.refundCalls()).toBe(1);
    expect(await statusOf(s.order.id)).toBe("paid");
    expect(await requestedAt(s.order.id)).toBeNull();
    expect(await cancelNotices(s.order.id)).toBe(1);
    await runRefundJobs(new Date(t0.getTime() + 3600_000));
    expect(await cancelNotices(s.order.id)).toBe(1); // nada de aviso repetido
  });
});

const alertsOf = (storeId: string, kind: string) =>
  t.ownerDb.select().from(storeAlert).where(and(eq(storeAlert.storeId, storeId), eq(storeAlert.kind, kind)));
const noticesOf = async (storeId: string, reason: string) =>
  (await t.ownerDb.select().from(job).where(and(eq(job.type, "notify_seller"), eq(job.storeId, storeId)))).filter(
    (j) => (j.payload as { reason?: string }).reason === reason,
  );
const payRaw = async (providerId: string) =>
  (await t.ownerDb.select().from(payment).where(eq(payment.providerId, providerId)))[0]!.raw as Record<string, unknown> | null;
const orderRow = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!;

describe("refund_order: estorno recusado pelo Asaas (4xx permanente)", () => {
  test("saldo insuficiente (400): não re-tenta, limpa o pedido de estorno e avisa o vendedor com o código", async () => {
    const s = await paidAsaasOrder();
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    s.fake.fail(`POST /payments/${s.providerId}/refund`, 400, "Saldo insuficiente para estorno", "insufficient_balance");
    await runRefundJobs(later(1));
    const [j] = await refundJobs(s.order.id);
    expect([j!.status, j!.attempts]).toEqual(["done", 1]);
    expect(await runRefundJobs(later(4000)).then(() => s.refundCalls())).toBe(1); // nada de nova tentativa
    const o = await orderRow(s.order.id);
    expect([o.status, o.refundRequestedAt]).toEqual(["paid", null]);
    const alerts = await alertsOf(s.storeId, "estorno_falhou");
    expect(alerts.map((a) => [a.orderId, a.detail])).toEqual([[s.order.id, { httpStatus: 400, code: "insufficient_balance" }]]);
    expect((await noticesOf(s.storeId, "estorno_falhou")).map((n) => n.payload)).toEqual([
      { orderId: s.order.id, reason: "estorno_falhou", httpStatus: 400, code: "insufficient_balance" },
    ]);
    // O POST não foi aceito: nada de "aguardando Asaas" (sem marca de aceite) e o vendedor pode pedir de novo.
    expect((await payRaw(s.providerId))?.refundPost).not.toHaveProperty("acceptedAt");
    expect((await runAction(getOrderDetail, panel(s.storeId), { id: s.order.id })).refund.state).toBe("none");
    s.fake.clearFailures();
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(5000));
    expect(await statusOf(s.order.id)).toBe("refunded");
  });

  test("chave revogada (401 no estorno): termina sem re-tentar e avisa o vendedor", async () => {
    const s = await paidAsaasOrder();
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    s.fake.fail(`POST /payments/${s.providerId}/refund`, 401, "A chave de API fornecida é inválida", "invalid_access_token");
    await runRefundJobs(later(1));
    expect((await refundJobs(s.order.id))[0]!.status).toBe("done");
    expect((await orderRow(s.order.id)).refundRequestedAt).toBeNull();
    expect((await alertsOf(s.storeId, "estorno_falhou")).map((a) => a.detail)).toEqual([{ httpStatus: 401, code: "invalid_access_token" }]);
  });

  test("chave revogada já na reconsulta (401 no GET): termina sem re-tentar e avisa", async () => {
    const s = await paidAsaasOrder();
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    s.fake.fail(`GET /payments/${s.providerId}`, 401, "A chave de API fornecida é inválida", "invalid_access_token");
    await runRefundJobs(later(1));
    expect((await refundJobs(s.order.id))[0]!.status).toBe("done");
    expect(s.refundCalls()).toBe(0);
    expect((await alertsOf(s.storeId, "estorno_falhou")).map((a) => a.detail)).toEqual([{ httpStatus: 401, code: "invalid_access_token" }]);
  });

  test("429 e rede continuam transitórios (backoff)", async () => {
    const s = await paidAsaasOrder();
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    s.fake.fail(`POST /payments/${s.providerId}/refund`, 429, "Muitas requisições");
    await runRefundJobs(later(1));
    expect((await refundJobs(s.order.id))[0]!.status).toBe("queued");
    expect(await alertsOf(s.storeId, "estorno_falhou")).toHaveLength(0);
  });

  test("marca de POST aceito só depois do 2xx: aceito e pendente -> 'aguardando Asaas'", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(1));
    expect(typeof (await payRaw(s.providerId))?.refundPost).toBe("object");
    expect((await payRaw(s.providerId))!.refundPost).toHaveProperty("acceptedAt");
    expect((await runAction(getOrderDetail, panel(s.storeId), { id: s.order.id })).refund.state).toBe("awaiting_provider");
  });

  test("resposta do POST perdida: sem marca de aceite até a próxima execução ver o estorno em refunds[]", async () => {
    const s = await paidAsaasOrder();
    s.fake.setRefundMode("pending");
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    s.fake.loseResponse(`POST /payments/${s.providerId}/refund`);
    const t0 = later(1);
    await runRefundJobs(t0);
    expect((await payRaw(s.providerId))!.refundPost).not.toHaveProperty("acceptedAt");
    s.fake.clearFailures();
    await runRefundJobs(new Date(t0.getTime() + 60_000));
    expect((await payRaw(s.providerId))!.refundPost).toHaveProperty("acceptedAt");
    expect(s.refundCalls()).toBe(1);
  });
});

describe("estorno em andamento e parcial (webhook e job)", () => {
  const hook = (s: { storeId: string; webhookToken: string }, paymentId: string, ev = "PAYMENT_UPDATED") =>
    handleAsaasWebhook(s.storeId, new Headers({ "asaas-access-token": s.webhookToken }), { event: ev, payment: { id: paymentId } });
  const revokes = async (orderId: string) =>
    (await t.ownerDb.select().from(job).where(eq(job.type, "revoke_downloads"))).filter((j) => (j.payload as { orderId?: string }).orderId === orderId);

  test("REFUND_IN_PROGRESS: o pedido fica pago com estorno solicitado (sem revogar); REFUNDED depois conclui", async () => {
    const s = await paidAsaasOrder();
    s.fake.setStatus(s.providerId, "REFUND_IN_PROGRESS");
    expect((await hook(s, s.providerId, "PAYMENT_REFUND_IN_PROGRESS")).status).toBe(200);
    const o = await orderRow(s.order.id);
    expect(o.status).toBe("paid");
    expect(o.refundRequestedAt).toBeInstanceOf(Date);
    expect(await revokes(s.order.id)).toHaveLength(0);
    expect((await runAction(getOrderDetail, panel(s.storeId), { id: s.order.id })).refund.state).toBe("awaiting_provider");
    s.fake.setStatus(s.providerId, "REFUNDED");
    await hook(s, s.providerId, "PAYMENT_REFUNDED");
    expect(await statusOf(s.order.id)).toBe("refunded");
    expect(await revokes(s.order.id)).toHaveLength(1);
  });

  test("estorno parcial feito no painel do Asaas (refunds[DONE] < total): sem transição; registra e avisa uma vez", async () => {
    const s = await paidAsaasOrder();
    s.fake.partialRefund(s.providerId, 3);
    expect((await hook(s, s.providerId, "PAYMENT_PARTIALLY_REFUNDED")).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("paid");
    expect(await revokes(s.order.id)).toHaveLength(0);
    expect((await payRaw(s.providerId))!.partialRefundCents).toBe(300);
    expect((await alertsOf(s.storeId, "estorno_parcial")).map((a) => [a.orderId, a.detail])).toEqual([[s.order.id, { refundedCents: 300 }]]);
    await hook(s, s.providerId);
    expect(await alertsOf(s.storeId, "estorno_parcial")).toHaveLength(1); // o mesmo valor não avisa de novo
    // Outro parcial (soma ainda menor que o total): registra e avisa o novo valor.
    s.fake.partialRefund(s.providerId, 2);
    await hook(s, s.providerId);
    expect((await payRaw(s.providerId))!.partialRefundCents).toBe(500);
    expect(await alertsOf(s.storeId, "estorno_parcial")).toHaveLength(2);
    expect(await statusOf(s.order.id)).toBe("paid");
  });

  test("parciais que somam o total concluem o estorno", async () => {
    const s = await paidAsaasOrder(); // 9,90
    s.fake.partialRefund(s.providerId, 4.9);
    s.fake.partialRefund(s.providerId, 5);
    await hook(s, s.providerId);
    expect(await statusOf(s.order.id)).toBe("refunded");
  });

  test("pedido de estorno total depois de um parcial: o job faz POST só do restante", async () => {
    const s = await paidAsaasOrder(); // 9,90
    s.fake.partialRefund(s.providerId, 3);
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    await runRefundJobs(later(1));
    const posts = s.fake.calls.filter((c) => c.method === "POST" && c.path === `/payments/${s.providerId}/refund`);
    expect(posts.map((c) => c.body)).toEqual([{ value: 6.9 }]);
    expect(await statusOf(s.order.id)).toBe("refunded");
  });

  test("restante recusado pelo Asaas: alerta o vendedor e o pedido continua pago", async () => {
    const s = await paidAsaasOrder();
    s.fake.partialRefund(s.providerId, 3);
    await runAction(refundOrder, panel(s.storeId), { orderId: s.order.id });
    s.fake.fail(`POST /payments/${s.providerId}/refund`, 400, "Estorno parcial não permitido", "invalid_action");
    await runRefundJobs(later(1));
    expect(await statusOf(s.order.id)).toBe("paid");
    expect((await alertsOf(s.storeId, "estorno_falhou")).map((a) => a.detail)).toEqual([{ httpStatus: 400, code: "invalid_action" }]);
  });

  test("classifyRefund: concluído só com REFUNDED ou soma DONE >= total (centavos)", () => {
    const items = (...xs: [string, number][]) => refundItems({ refunds: xs.map(([status, value]) => ({ status, value })) });
    expect(classifyRefund("RECEIVED", items(["DONE", 9.9]), null, 990)).toBe("done");
    expect(classifyRefund("RECEIVED", items(["DONE", 3]), null, 990)).toBe("partial");
    expect(classifyRefund("RECEIVED", items(["DONE", 3], ["DONE", 6.9]), null, 990)).toBe("done");
    expect(classifyRefund("REFUNDED", [], null, 990)).toBe("done");
    expect(classifyRefund("REFUND_IN_PROGRESS", [], null, 990)).toBe("requested");
    expect(classifyRefund("RECEIVED", items(["DONE", 3], ["PENDING", 6.9]), null, 990)).toBe("requested");
    expect(classifyRefund("RECEIVED", items(["DONE", 3], ["CANCELLED", 6.9]), { at: "x", before: 1 }, 990)).toBe("cancelled");
    expect(classifyRefund("RECEIVED", [], null, 990)).toBe("none");
  });

  test("classifyInstallmentRefund: a venda parcelada só está estornada com TODAS as parcelas de volta", () => {
    const parcel = (id: string, status: string, refunds: [string, number][] = []) => ({ id, status, value: 3.33, installment: "ins_1", refunds: refunds.map(([s, value]) => ({ status: s, value })) });
    const of = (...ps: ReturnType<typeof parcel>[]) => installmentParcels(ps, "ins_1");
    const none = () => null;
    expect(classifyInstallmentRefund(of(parcel("a", "REFUNDED"), parcel("b", "REFUNDED"), parcel("c", "REFUNDED")), none)).toBe("done");
    expect(classifyInstallmentRefund(of(parcel("a", "REFUNDED"), parcel("b", "CONFIRMED"), parcel("c", "CONFIRMED")), none)).toBe("partial");
    expect(classifyInstallmentRefund(of(parcel("a", "CONFIRMED"), parcel("b", "REFUNDED"), parcel("c", "CONFIRMED")), none)).toBe("partial");
    expect(classifyInstallmentRefund(of(parcel("a", "REFUNDED"), parcel("b", "CONFIRMED", [["PENDING", 3.33]]), parcel("c", "CONFIRMED")), none)).toBe("requested");
    expect(classifyInstallmentRefund(of(parcel("a", "CONFIRMED"), parcel("b", "CONFIRMED")), none)).toBe("none");
    expect(classifyInstallmentRefund(of(parcel("a", "CONFIRMED", [["CANCELLED", 3.33]]), parcel("b", "CONFIRMED")), (id) => (id === "a" ? { at: "x", before: 0 } : null))).toBe("cancelled");
    // Sem parcelas (lista vazia ou de outro parcelamento / apagadas): nunca conclui às cegas.
    expect(classifyInstallmentRefund([], none)).toBe("none");
    expect(installmentParcels([{ ...parcel("x", "REFUNDED"), installment: "ins_2" }, { ...parcel("y", "REFUNDED"), deleted: true }], "ins_1")).toEqual([]);
    expect(installmentRefundedCents(of(parcel("a", "REFUNDED"), parcel("b", "CONFIRMED", [["DONE", 1]]), parcel("c", "CONFIRMED")))).toBe(433);
  });
});
