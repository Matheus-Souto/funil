import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { auditLog, customer, integration, job, orders, payment } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { transitionOrder } from "@/lib/orders/state";
import { createAsaasClient, setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { ensureAsaasCustomer, saveAsaas, startAsaasPix } from "@/lib/payments/asaas/pix";
import { refundOrder } from "@/lib/payments/refund";
import { mapAsaasStatus } from "@/lib/payments/asaas/webhook";
import { createTestDb, seedStore, type TestDb } from "./db";
import { ctxOf, createFakeAsaas, newAsaasOrder, owner, seedAsaasStore } from "./asaas-helpers";

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

describe("cliente Asaas", () => {
  test("envia access_token, User-Agent genérico e converte erros em provider_error", async () => {
    const fake = createFakeAsaas();
    const c = createAsaasClient({ apiKey: fake.apiKey, env: "sandbox", fetch: fake.fetch });
    expect((await c.getBalance()).balance).toBe(123.45);
    expect(fake.calls[0]!.headers.get("access_token")).toBe(fake.apiKey);
    expect(fake.calls[0]!.headers.get("user-agent")).toBe("funil/0.1");
    const bad = createAsaasClient({ apiKey: "errada", env: "sandbox", fetch: fake.fetch });
    const e = await bad.getBalance().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ActionError);
    expect((e as ActionError).code).toBe("provider_error");
  });

  test("erro do Asaas que ecoa número de cartão não vaza na mensagem", async () => {
    const fake = createFakeAsaas();
    fake.fail("GET /finance/balance", 400, "Cartão 4111 1111 1111 1111 recusado, cvv 123");
    const c = createAsaasClient({ apiKey: fake.apiKey, env: "sandbox", fetch: fake.fetch });
    const e = (await c.getBalance().catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("provider_error");
    expect(e.message).not.toContain("4111");
    expect(JSON.stringify(e.details)).not.toContain("4111");
  });

  test("falha de rede vira provider_error sem expor o motivo", async () => {
    const c = createAsaasClient({
      apiKey: "k",
      env: "sandbox",
      fetch: (() => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1"))) as unknown as typeof fetch,
    });
    const e = (await c.getBalance().catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("provider_error");
    expect(e.message).not.toContain("10.0.0.1");
  });
});

describe("mapAsaasStatus", () => {
  test("tabela de status", () => {
    for (const s of ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"]) expect(mapAsaasStatus(s)).toBe("paid");
    for (const s of ["REFUNDED", "REFUND_IN_PROGRESS"]) expect(mapAsaasStatus(s)).toBe("refunded");
    for (const s of ["CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"]) expect(mapAsaasStatus(s)).toBe("disputed");
    expect(mapAsaasStatus("OVERDUE")).toBe("expired");
    expect(mapAsaasStatus("PENDING")).toBeNull();
    expect(mapAsaasStatus("")).toBeNull();
  });
});

describe("connections.saveAsaas", () => {
  test("testa a chave antes de salvar: chave inválida não grava nada", async () => {
    const fake = createFakeAsaas();
    setAsaasFetchForTests(fake.fetch);
    const { storeId } = await seedStore();
    const e = await runAction(saveAsaas, panel(storeId), { env: "sandbox", apiKey: "chave-invalida-123" }).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("provider_error");
    expect(await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"))).toBeNull();
  });

  test("salva com token do webhook, mantém o token ao salvar de novo e rotaciona só se pedido", async () => {
    const fake = createFakeAsaas();
    setAsaasFetchForTests(fake.fetch);
    const { storeId } = await seedStore();
    const a = await runAction(saveAsaas, panel(storeId), { env: "sandbox", apiKey: fake.apiKey });
    expect(a.webhookUrl).toBe(`http://localhost:3000/api/webhooks/asaas/${storeId}`);
    expect(a.webhookToken.length).toBeGreaterThanOrEqual(40);
    const b = await runAction(saveAsaas, panel(storeId), { env: "production", apiKey: fake.apiKey });
    expect(b.webhookToken).toBe(a.webhookToken);
    const c = await runAction(saveAsaas, panel(storeId), { env: "sandbox", apiKey: fake.apiKey, rotateWebhookToken: true });
    expect(c.webhookToken).not.toBe(a.webhookToken);
    const conn = await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"));
    expect(conn!.secret).toBe(fake.apiKey);
    expect(conn!.config).toEqual({ env: "sandbox", webhookToken: c.webhookToken });
  });

  test("a chave de API nunca aparece em claro no banco nem na auditoria", async () => {
    const fake = createFakeAsaas({ apiKey: "segredo-super-unico-9999" });
    const { storeId } = await seedAsaasStore(fake);
    const [row] = await t.ownerDb.select().from(integration).where(eq(integration.storeId, storeId));
    expect(JSON.stringify(row)).not.toContain("segredo-super-unico-9999");
    const audit = await t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId));
    expect(JSON.stringify(audit)).not.toContain("segredo-super-unico-9999");
  });

  test("é sensível: origem mcp pede aprovação e suporte não pode", async () => {
    const { storeId } = await seedStore();
    const mcp = await runAction(saveAsaas, { storeId, actor: owner, origin: "mcp" }, { env: "sandbox", apiKey: "chave-qualquer-1" }).catch((x: unknown) => x);
    expect((mcp as ActionError).code).toBe("approval_required");
    const support = { kind: "user" as const, userId: "u2", role: "support" as const };
    const r = await runAction(saveAsaas, { storeId, actor: support, origin: "panel" }, { env: "sandbox", apiKey: "chave-qualquer-1" }).catch((x: unknown) => x);
    expect((r as ActionError).code).toBe("forbidden");
  });
});

describe("Pix automático", () => {
  test("startAsaasPix envia value 9.9 para 990 centavos e externalReference = id do pedido; grava payment", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake, 990);
    const order = await newAsaasOrder(storeId, offerId);
    const qr = await withStore(storeId, (tx) => startAsaasPix(ctxOf(storeId, tx), order.id));
    expect(qr.copyPaste).toStartWith("00020126");
    expect(qr.qrImage.length).toBeGreaterThan(10);
    expect(qr.expiresAt).toBeTruthy();
    const create = fake.calls.find((c) => c.method === "POST" && c.path === "/payments")!;
    const body = create.body as Record<string, unknown>;
    expect(body.value).toBe(9.9);
    expect(body.billingType).toBe("PIX");
    expect(body.externalReference).toBe(order.id);
    const rows = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "asaas", amountCents: 990, status: "PENDING" });
    expect(rows[0]!.providerId).toStartWith("pay_");
  });

  test("chamar de novo reaproveita a cobrança (uma só no Asaas)", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    await withStore(storeId, (tx) => startAsaasPix(ctxOf(storeId, tx), order.id));
    await withStore(storeId, (tx) => startAsaasPix(ctxOf(storeId, tx), order.id));
    expect(fake.payments.size).toBe(1);
  });

  test("ensureAsaasCustomer cria uma vez, guarda o id e envia os dados do cliente", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const a = await withStore(storeId, (tx) => ensureAsaasCustomer(ctxOf(storeId, tx), order.customerId));
    const b = await withStore(storeId, (tx) => ensureAsaasCustomer(ctxOf(storeId, tx), order.customerId));
    expect(b).toBe(a);
    const creates = fake.calls.filter((c) => c.method === "POST" && c.path === "/customers");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toEqual({
      name: "Ana",
      email: "ana@example.com",
      cpfCnpj: "52998224725",
      mobilePhone: "11999999999",
      externalReference: order.customerId,
    });
    const [c] = await t.ownerDb.select().from(customer).where(eq(customer.id, order.customerId));
    expect(c!.asaasCustomerId).toBe(a);
  });

  test("duas chamadas simultâneas não criam dois clientes", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    await Promise.all([1, 2, 3].map(() => withStore(storeId, (tx) => ensureAsaasCustomer(ctxOf(storeId, tx), order.customerId))));
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/customers")).toHaveLength(1);
  });

  test("falha do Asaas na cobrança vira provider_error e não grava payment", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    fake.fail("POST /payments", 400, "Valor inválido");
    const e = await withStore(storeId, (tx) => startAsaasPix(ctxOf(storeId, tx), order.id)).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("provider_error");
    expect(await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id))).toHaveLength(0);
  });

  test("pedido de outro método ou já pago é recusado", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    await withStore(storeId, (tx) => transitionOrder(ctxOf(storeId, tx), order.id, "paid", "t"));
    const e = await withStore(storeId, (tx) => startAsaasPix(ctxOf(storeId, tx), order.id)).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
  });
});

describe("orders.refund", () => {
  async function paidAsaasOrder() {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    await withStore(storeId, (tx) => startAsaasPix(ctxOf(storeId, tx), order.id));
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    fake.setStatus(pay!.providerId!, "RECEIVED");
    await withStore(storeId, (tx) => transitionOrder(ctxOf(storeId, tx), order.id, "paid", "t"));
    return { fake, storeId, order, providerId: pay!.providerId! };
  }
  const statusOf = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;

  test("Asaas: chama o endpoint de estorno e muda o estado para refunded (revoga downloads)", async () => {
    const { fake, storeId, order, providerId } = await paidAsaasOrder();
    const r = await runAction(refundOrder, panel(storeId), { orderId: order.id });
    expect(r.orderId).toBe(order.id);
    expect(fake.calls.some((c) => c.method === "POST" && c.path === `/payments/${providerId}/refund`)).toBe(true);
    expect(await statusOf(order.id)).toBe("refunded");
    const types = (await t.ownerDb.select().from(job)).filter((j) => (j.payload as { orderId?: string }).orderId === order.id).map((j) => j.type);
    expect(types).toContain("revoke_downloads");
  });

  test("Asaas falha: estado não muda e devolve provider_error", async () => {
    const { fake, storeId, order } = await paidAsaasOrder();
    fake.fail("POST /payments/", 400, "Saldo insuficiente para estorno");
    const e = await runAction(refundOrder, panel(storeId), { orderId: order.id }).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("provider_error");
    expect(await statusOf(order.id)).toBe("paid");
  });

  test("só pedidos pagos são reembolsáveis", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const e = await runAction(refundOrder, panel(storeId), { orderId: order.id }).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
  });

  test("Pix manual: só muda o estado e avisa para devolver pelo banco (sem chamar o Asaas)", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const base = await newAsaasOrder(storeId, offerId);
    await t.ownerDb.update(orders).set({ method: "pix_manual", status: "paid" }).where(eq(orders.id, base.id));
    const before = fake.calls.length;
    const r = await runAction(refundOrder, panel(storeId), { orderId: base.id });
    expect(r.message).toContain("banco");
    expect(await statusOf(base.id)).toBe("refunded");
    expect(fake.calls.length).toBe(before);
  });

  test("é sensível e exige a permissão orders.refund", async () => {
    const { storeId, order } = await paidAsaasOrder();
    const mcp = await runAction(refundOrder, { storeId, actor: owner, origin: "mcp" }, { orderId: order.id }).catch((x: unknown) => x);
    expect((mcp as ActionError).code).toBe("approval_required");
    const support = { kind: "user" as const, userId: "u2", role: "support" as const };
    const f = await runAction(refundOrder, { storeId, actor: support, origin: "panel" }, { orderId: order.id }).catch((x: unknown) => x);
    expect((f as ActionError).code).toBe("forbidden");
  });
});
