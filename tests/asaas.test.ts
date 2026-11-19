import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { auditLog, customer, integration, payment } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { transitionOrder } from "@/lib/orders/state";
import { createAsaasClient, setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { isUniqueViolation } from "@/lib/payments/manual";
import { ensureAsaasCustomer, saveAsaas, startAsaasPix } from "@/lib/payments/asaas/pix";
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
    expect(mapAsaasStatus("REFUNDED")).toBe("refunded");
    // Estorno em andamento: o dinheiro ainda não voltou (sem transição; o pedido fica com o estorno solicitado).
    for (const s of ["REFUND_IN_PROGRESS", "REFUND_REQUESTED"]) expect(mapAsaasStatus(s)).toBeNull();
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
    const audit = (await t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId))).filter((r) => r.action === "connections.saveAsaas");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ ok: false });
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
    expect(conn!.config).toEqual({ env: "sandbox", webhookToken: c.webhookToken, accountKey: `sandbox:wallet:${fake.walletId}` });
  });

  test("accountKey = ambiente + walletId da conta (GET /wallets/); sem carteira, impressão sha256 da chave", async () => {
    const fake = createFakeAsaas();
    setAsaasFetchForTests(fake.fetch);
    const { storeId } = await seedStore();
    await runAction(saveAsaas, panel(storeId), { env: "production", apiKey: fake.apiKey });
    const conn = await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"));
    expect((conn!.config as { accountKey: string }).accountKey).toBe(`production:wallet:${fake.walletId}`);
    expect(fake.calls.some((c) => c.method === "GET" && c.path.startsWith("/wallets"))).toBe(true);

    const noWallet = createFakeAsaas({ apiKey: "chave-sem-carteira-1", walletId: null });
    setAsaasFetchForTests(noWallet.fetch);
    await runAction(saveAsaas, panel(storeId), { env: "sandbox", apiKey: noWallet.apiKey });
    const conn2 = await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"));
    const key = (conn2!.config as { accountKey: string }).accountKey;
    expect(key).toBe(`sandbox:key:${createHash("sha256").update(noWallet.apiKey).digest("hex").slice(0, 32)}`);
    expect(key).not.toContain(noWallet.apiKey);
  });

  test("falha ao identificar a conta: nada é salvo", async () => {
    const fake = createFakeAsaas();
    setAsaasFetchForTests(fake.fetch);
    fake.fail("GET /wallets", 500, "erro");
    const { storeId } = await seedStore();
    const e = await runAction(saveAsaas, panel(storeId), { env: "sandbox", apiKey: fake.apiKey }).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("provider_error");
    expect(await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"))).toBeNull();
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
    const m = await runAction(saveAsaas, { storeId, actor: support, origin: "mcp" }, { env: "sandbox", apiKey: "chave-qualquer-1" }).catch((x: unknown) => x);
    expect((m as ActionError).code).toBe("forbidden");
  });
});

describe("Pix automático", () => {
  test("startAsaasPix envia value 9.9 para 990 centavos e externalReference = id do pedido; grava payment", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake, 990);
    const order = await newAsaasOrder(storeId, offerId);
    const qr = await startAsaasPix({ storeId }, order.id);
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
    await startAsaasPix({ storeId }, order.id);
    await startAsaasPix({ storeId }, order.id);
    expect(fake.payments.size).toBe(1);
  });

  test("ensureAsaasCustomer cria uma vez, guarda o id e envia os dados do cliente", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const a = await ensureAsaasCustomer({ storeId }, order.customerId);
    const b = await ensureAsaasCustomer({ storeId }, order.customerId);
    expect(b).toBe(a);
    const creates = fake.calls.filter((c) => c.method === "POST" && c.path === "/customers");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toEqual({
      name: "Ana",
      email: "ana@example.com",
      cpfCnpj: "52998224725",
      mobilePhone: "11999999999",
      externalReference: order.customerId,
      notificationDisabled: true,
    });
    const [c] = await t.ownerDb.select().from(customer).where(eq(customer.id, order.customerId));
    expect(c!.asaasCustomerId).toBe(a);
  });

  test("chamadas simultâneas devolvem o mesmo id (o primeiro gravado vence)", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const ids = await Promise.all([1, 2, 3].map(() => ensureAsaasCustomer({ storeId }, order.customerId)));
    expect(new Set(ids).size).toBe(1);
    const [c] = await t.ownerDb.select().from(customer).where(eq(customer.id, order.customerId));
    expect(c!.asaasCustomerId).toBe(ids[0]!);
  });

  test("falha do Asaas na cobrança vira provider_error e não grava payment", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    fake.fail("POST /payments", 400, "Valor inválido");
    const e = await startAsaasPix({ storeId }, order.id).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("provider_error");
    expect(await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id))).toHaveLength(0);
  });

  test("pedido de outro método ou já pago é recusado", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    await withStore(storeId, (tx) => transitionOrder(ctxOf(storeId, tx), order.id, "paid", "t"));
    const e = await startAsaasPix({ storeId }, order.id).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
  });
});

/** Quantas conexões do banco de teste estão com transação aberta parada (HTTP dentro de transação deixa uma). */
async function idleInTransaction(): Promise<number> {
  const rows = await t.ownerDb.execute(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`,
  );
  return Number((rows as unknown as { n: number }[])[0]!.n);
}

describe("sem HTTP dentro de transação", () => {
  test("startAsaasPix: nenhuma chamada ao Asaas acontece com transação aberta", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const seen: number[] = [];
    setAsaasFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(await idleInTransaction());
      return fake.fetch(input, init);
    }) as typeof fetch);
    await startAsaasPix({ storeId }, order.id);
    expect(seen.length).toBeGreaterThanOrEqual(3); // cliente, cobrança, QR
    expect(seen.every((n) => n === 0)).toBe(true);
  });

  test("saveAsaas: o teste de chave (saldo) roda antes de abrir transação", async () => {
    const fake = createFakeAsaas();
    const { storeId } = await seedStore();
    const seen: number[] = [];
    setAsaasFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(await idleInTransaction());
      return fake.fetch(input, init);
    }) as typeof fetch);
    await runAction(saveAsaas, panel(storeId), { env: "sandbox", apiKey: fake.apiKey });
    expect(seen).toEqual([0, 0]); // saldo + conta (wallets)
  });
});

describe("Pix automático: robustez da cobrança", () => {
  test("falha no QR depois de criar a cobrança: a linha de pagamento fica e a nova tentativa reaproveita a cobrança", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    fake.fail("GET /payments/", 500, "indisponível");
    const e = await startAsaasPix({ storeId }, order.id).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("provider_error");
    expect(await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id))).toHaveLength(1);
    fake.clearFailures();
    const qr = await startAsaasPix({ storeId }, order.id);
    expect(qr.copyPaste).toStartWith("00020126");
    expect(fake.payments.size).toBe(1);
  });

  test("3 chamadas simultâneas: uma linha aberta, todas devolvem a mesma cobrança e as sobras são canceladas no Asaas", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const qrs = await Promise.all([1, 2, 3].map(() => startAsaasPix({ storeId }, order.id)));
    expect(new Set(qrs.map((q) => q.copyPaste)).size).toBe(1);
    const rows = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    expect(rows).toHaveLength(1);
    const live = [...fake.payments.values()].filter((p) => !p.deleted);
    expect(live.map((p) => p.id)).toEqual([rows[0]!.providerId!]);
  });

  test("o índice garante no máximo uma cobrança Pix aberta por pedido", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    const row = { storeId, orderId: order.id, provider: "asaas", status: "PENDING", amountCents: 990 };
    await t.ownerDb.insert(payment).values({ ...row, providerId: "pay_dup_1" });
    const e = await t.ownerDb.insert(payment).values({ ...row, providerId: "pay_dup_2" }).catch((x: unknown) => x);
    expect(isUniqueViolation(e)).toBe(true);
  });

  test("webhook PAYMENT_CREATED da própria cobrança chega entre a criação e a gravação: a cobrança viva não é apagada", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    setAsaasFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if (init?.method === "POST" && String(input).endsWith("/payments")) {
        const { id } = (await res.clone().json()) as { id: string };
        await t.ownerDb.insert(payment).values({ storeId, orderId: order.id, provider: "asaas", providerId: id, status: "PENDING", amountCents: 990 });
      }
      return res;
    }) as typeof fetch);
    const qr = await startAsaasPix({ storeId }, order.id);
    expect(qr.copyPaste).toStartWith("00020126");
    expect([...fake.payments.values()].filter((p) => p.deleted)).toHaveLength(0);
    expect(await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id))).toHaveLength(1);
  });

  test("falha em apagar a cobrança sobrando não quebra a chamada", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    fake.fail("DELETE /payments/", 500, "não deu");
    const qrs = await Promise.all([1, 2].map(() => startAsaasPix({ storeId }, order.id)));
    expect(new Set(qrs.map((q) => q.copyPaste)).size).toBe(1);
  });
});

describe("troca de conta/ambiente do Asaas", () => {
  /** Duas contas Asaas separadas (sandbox e produção), escolhidas pela chave de API enviada. */
  function twoAccounts() {
    const sandbox = createFakeAsaas();
    const prod = createFakeAsaas({ apiKey: "prod-key-987654", walletId: "wal_producao" });
    const route = (async (input: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("access_token");
      return (key === prod.apiKey ? prod : sandbox).fetch(input, init);
    }) as typeof fetch;
    return { sandbox, prod, route };
  }

  test("sandbox -> produção: recria o cliente na conta nova e cria cobrança nova para o pedido pendente", async () => {
    const { sandbox, prod, route } = twoAccounts();
    const { storeId, offerId } = await seedAsaasStore(sandbox);
    setAsaasFetchForTests(route);
    const order = await newAsaasOrder(storeId, offerId);
    await startAsaasPix({ storeId }, order.id);
    const [old] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    const [before] = await t.ownerDb.select().from(customer).where(eq(customer.id, order.customerId));
    expect(before!.asaasAccountKey).toBe(`sandbox:wallet:${sandbox.walletId}`);

    await runAction(saveAsaas, panel(storeId), { env: "production", apiKey: prod.apiKey });
    const [superseded] = await t.ownerDb.select().from(payment).where(eq(payment.id, old!.id));
    expect(superseded!.status).toBe("superseded");

    const qr = await startAsaasPix({ storeId }, order.id);
    expect(qr.copyPaste).toContain("pay_");
    expect(prod.customers.size).toBe(1);
    expect(prod.payments.size).toBe(1);
    const created = [...prod.payments.values()][0]!;
    expect(created.customer).toBe([...prod.customers.keys()][0]!);
    expect(created.externalReference).toBe(order.id);
    const [after] = await t.ownerDb.select().from(customer).where(eq(customer.id, order.customerId));
    expect(after!.asaasCustomerId).toBe(created.customer);
    expect(after!.asaasAccountKey).toBe("production:wallet:wal_producao");
    const rows = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    expect(rows.map((r) => [r.providerId, r.status]).sort()).toEqual(
      [
        [old!.providerId, "superseded"],
        [created.id, "PENDING"],
      ].sort(),
    );
  });

  test("troca de conta: depois do commit, as cobranças descartadas são canceladas na conta ANTERIOR (chave antiga)", async () => {
    const { sandbox, prod, route } = twoAccounts();
    const { storeId, offerId } = await seedAsaasStore(sandbox);
    const order = await newAsaasOrder(storeId, offerId);
    setAsaasFetchForTests(route);
    await startAsaasPix({ storeId }, order.id);
    const [old] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    const atDelete: { status: string; idle: number }[] = [];
    setAsaasFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        const [row] = await t.ownerDb.select().from(payment).where(eq(payment.id, old!.id));
        atDelete.push({ status: row!.status, idle: await idleInTransaction() });
      }
      return route(input, init);
    }) as typeof fetch);
    await runAction(saveAsaas, panel(storeId), { env: "production", apiKey: prod.apiKey });
    const del = sandbox.calls.filter((c) => c.method === "DELETE");
    expect(del.map((c) => [c.path, c.headers.get("access_token")])).toEqual([[`/payments/${old!.providerId}`, sandbox.apiKey]]);
    expect(sandbox.payments.get(old!.providerId!)!.deleted).toBe(true);
    expect(prod.calls.some((c) => c.method === "DELETE")).toBe(false);
    // Só depois do commit: a linha já estava superseded e nenhuma transação aberta.
    expect(atDelete).toEqual([{ status: "superseded", idle: 0 }]);
  });

  test("troca de conta: falha ao cancelar na conta anterior não impede salvar (só log)", async () => {
    const { sandbox, prod, route } = twoAccounts();
    const { storeId, offerId } = await seedAsaasStore(sandbox);
    setAsaasFetchForTests(route);
    const order = await newAsaasOrder(storeId, offerId);
    await startAsaasPix({ storeId }, order.id);
    sandbox.fail("DELETE /payments/", 500, "indisponível");
    const warn = spyOn(log, "warn");
    try {
      const r = await runAction(saveAsaas, panel(storeId), { env: "production", apiKey: prod.apiKey });
      expect(r.accountChanged).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("conta Asaas anterior"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    const conn = await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"));
    expect((conn!.config as { accountKey: string }).accountKey).toBe("production:wallet:wal_producao");
    const [row] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    expect(row!.status).toBe("superseded");
  });

  test("salvar de novo a mesma conta não descarta cobranças nem recria o cliente", async () => {
    const fake = createFakeAsaas();
    const { storeId, offerId } = await seedAsaasStore(fake);
    const order = await newAsaasOrder(storeId, offerId);
    await startAsaasPix({ storeId }, order.id);
    await runAction(saveAsaas, panel(storeId), { env: "sandbox", apiKey: fake.apiKey, rotateWebhookToken: true });
    const rows = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    expect(rows.map((r) => r.status)).toEqual(["PENDING"]);
    await startAsaasPix({ storeId }, order.id);
    expect(fake.customers.size).toBe(1);
    expect(fake.payments.size).toBe(1);
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("troca de conta só descarta cobranças PENDING da própria loja", async () => {
    const { sandbox, prod, route } = twoAccounts();
    const a = await seedAsaasStore(sandbox);
    const b = await seedAsaasStore(sandbox);
    setAsaasFetchForTests(route);
    const oa = await newAsaasOrder(a.storeId, a.offerId);
    const ob = await newAsaasOrder(b.storeId, b.offerId);
    await startAsaasPix({ storeId: a.storeId }, oa.id);
    await startAsaasPix({ storeId: b.storeId }, ob.id);
    await runAction(saveAsaas, panel(a.storeId), { env: "production", apiKey: prod.apiKey });
    const [pa] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, oa.id));
    const [pb] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, ob.id));
    expect([pa!.status, pb!.status]).toEqual(["superseded", "PENDING"]);
  });
});
