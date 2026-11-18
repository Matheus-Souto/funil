import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import fc from "fast-check";
import { withStore } from "@/lib/db/client";
import { auditLog, job, orders, payment } from "@/lib/db/schema";
import { ALLOWED, type OrderStatus } from "@/lib/orders/state";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { startAsaasPix } from "@/lib/payments/asaas/pix";
import { handleAsaasWebhook, mapAsaasStatus } from "@/lib/payments/asaas/webhook";
import { POST } from "@/app/api/webhooks/asaas/[storeId]/route";
import { createTestDb, type TestDb } from "./db";
import { ctxOf, createFakeAsaas, newAsaasOrder, seedAsaasStore } from "./asaas-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setAsaasFetchForTests();
  await t.drop();
});
afterEach(() => setAsaasFetchForTests());

const hdr = (token: string | null) => new Headers(token === null ? {} : { "asaas-access-token": token });
const event = (paymentId: string, status = "RECEIVED") => ({ event: "PAYMENT_RECEIVED", payment: { id: paymentId, status } });

async function setup(price = 990, shared?: ReturnType<typeof createFakeAsaas>) {
  const fake = shared ?? createFakeAsaas();
  const s = await seedAsaasStore(fake, price);
  const order = await newAsaasOrder(s.storeId, s.offerId);
  await startAsaasPix({ storeId: s.storeId }, order.id);
  const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
  return { fake, ...s, order, paymentId: pay!.providerId! };
}
const statusOf = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;
const jobsOf = async (orderId: string, type: string) =>
  (await t.ownerDb.select().from(job)).filter((j) => j.type === type && (j.payload as { orderId?: string }).orderId === orderId);

describe("autenticação do webhook", () => {
  test("token errado ou ausente -> 401 e nada muda", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "RECEIVED");
    for (const token of ["errado", "", null]) {
      expect((await handleAsaasWebhook(s.storeId, hdr(token), event(s.paymentId))).status).toBe(401);
    }
    expect(await statusOf(s.order.id)).toBe("pending");
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(0);
  });

  test("token da loja B no webhook da loja A -> 401 (acesso cruzado)", async () => {
    const fake = createFakeAsaas();
    const a = await setup(990, fake);
    const b = await setup(990, fake);
    a.fake.setStatus(a.paymentId, "RECEIVED");
    expect((await handleAsaasWebhook(a.storeId, hdr(b.webhookToken), event(a.paymentId))).status).toBe(401);
    expect(await statusOf(a.order.id)).toBe("pending");
  });

  test("loja inexistente responde 401 igual a token errado; storeId que não é UUID -> 404", async () => {
    expect((await handleAsaasWebhook("00000000-0000-4000-8000-000000000000", hdr("x"), event("p"))).status).toBe(401);
    expect((await handleAsaasWebhook("nao-e-uuid", hdr("x"), event("p"))).status).toBe(404);
  });

  test("corpo inválido com token válido -> 200 e ignora", async () => {
    const s = await setup();
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), { foo: 1 })).status).toBe(200);
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), undefined)).status).toBe(200);
  });
});

describe("efeito do webhook (sempre reconsulta)", () => {
  test("RECEIVED reconsultado -> paid, com um deliver_order; repetido 3x em paralelo -> um paid e um deliver_order", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "RECEIVED");
    const rs = await Promise.all([1, 2, 3].map(() => handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId))));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await statusOf(s.order.id)).toBe("paid");
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(1);
    expect(await jobsOf(s.order.id, "meta_event")).toHaveLength(1);
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, s.order.id));
    expect(pay!.status).toBe("RECEIVED");
  });

  test("corpo diz RECEIVED mas a reconsulta diz PENDING -> nada muda", async () => {
    const s = await setup();
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId, "RECEIVED"))).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("pending");
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(0);
  });

  test("valor pago menor que o total -> continua pending", async () => {
    const s = await setup(990);
    s.fake.setStatus(s.paymentId, "RECEIVED");
    s.fake.setValue(s.paymentId, 9.89);
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId))).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("pending");
  });

  test("valor com ponto flutuante ruim (19.9 reais para 1990) ainda libera", async () => {
    const s = await setup(1990);
    s.fake.setStatus(s.paymentId, "CONFIRMED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    expect(await statusOf(s.order.id)).toBe("paid");
  });

  test("CHARGEBACK_REQUESTED em pedido pago -> disputed (revoga); reversão -> volta a paid só com restore_downloads", async () => {
    const s = await setup();
    const send = () => handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    s.fake.setStatus(s.paymentId, "RECEIVED");
    await send();
    s.fake.setStatus(s.paymentId, "CHARGEBACK_REQUESTED");
    await send();
    expect(await statusOf(s.order.id)).toBe("disputed");
    expect(await jobsOf(s.order.id, "revoke_downloads")).toHaveLength(1);
    s.fake.setStatus(s.paymentId, "RECEIVED");
    await send();
    expect(await statusOf(s.order.id)).toBe("paid");
    expect(await jobsOf(s.order.id, "restore_downloads")).toHaveLength(1);
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(1);
  });

  test("REFUNDED vindo do Asaas em pedido pago -> refunded", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "RECEIVED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    s.fake.setStatus(s.paymentId, "REFUNDED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    expect(await statusOf(s.order.id)).toBe("refunded");
  });

  test("OVERDUE -> expired; Pix pago depois do vencimento local ainda libera o pedido", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "OVERDUE");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    expect(await statusOf(s.order.id)).toBe("expired");
    s.fake.setStatus(s.paymentId, "RECEIVED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    expect(await statusOf(s.order.id)).toBe("paid");
  });

  test("cobrança cujo externalReference é pedido de OUTRA loja é ignorada", async () => {
    const fake = createFakeAsaas();
    const a = await setup(990, fake);
    const b = await setup(990, fake);
    // Cobrança da loja A cujo externalReference aponta para o pedido da loja B.
    a.fake.payments.get(a.paymentId)!.externalReference = b.order.id;
    a.fake.setStatus(a.paymentId, "RECEIVED");
    expect((await handleAsaasWebhook(a.storeId, hdr(a.webhookToken), event(a.paymentId))).status).toBe(200);
    expect(await statusOf(b.order.id)).toBe("pending");
    expect(await statusOf(a.order.id)).toBe("pending");
  });

  test("cobrança já vinculada a outro pedido da mesma loja não libera um terceiro", async () => {
    const s = await setup();
    const other = await newAsaasOrder(s.storeId, s.offerId, "outro@example.com");
    s.fake.payments.get(s.paymentId)!.externalReference = other.id;
    s.fake.setStatus(s.paymentId, "RECEIVED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    expect(await statusOf(other.id)).toBe("pending");
    expect(await statusOf(s.order.id)).toBe("pending");
  });

  test("cobrança sem externalReference ou desconhecida -> 200 e ignora", async () => {
    const s = await setup();
    s.fake.payments.get(s.paymentId)!.externalReference = null;
    s.fake.setStatus(s.paymentId, "RECEIVED");
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId))).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("pending");
  });

  test("Asaas fora do ar na reconsulta -> 500 (para o Asaas reenviar) e nada muda", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "RECEIVED");
    s.fake.fail("GET /payments/", 500, "indisponível");
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId))).status).toBe(500);
    expect(await statusOf(s.order.id)).toBe("pending");
    s.fake.clearFailures();
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId))).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("paid");
  });

  test("auditoria da mudança: origem webhook, ator system, sem corpo cru", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "RECEIVED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    const rows = (await t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, s.storeId))).filter((r) => r.action === "payments.applyAsaasPayment");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "webhook", ok: true });
    expect(rows[0]!.actor).toEqual({ kind: "system" });
  });
});

describe("cobrança órfã (existe no Asaas, sem linha de pagamento no pedido)", () => {
  /** Segunda cobrança no Asaas com o mesmo externalReference, que o banco desconhece. */
  function orphan(s: Awaited<ReturnType<typeof setup>>, status: string): string {
    const id = `pay_orfa_${Math.random().toString(36).slice(2, 10)}`;
    s.fake.payments.set(id, { id, status, value: 9.9, externalReference: s.order.id, customer: "cus_x", billingType: "PIX", dueDate: "2099-01-01" });
    return id;
  }
  const rowsOf = (orderId: string) => t.ownerDb.select().from(payment).where(eq(payment.orderId, orderId));
  async function warnings(fn: () => Promise<unknown>): Promise<string> {
    const orig = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
    try {
      await fn();
    } finally {
      process.stdout.write = orig;
    }
    return out;
  }

  test("OVERDUE da órfã não expira o pedido vivo nem cria linha", async () => {
    const s = await setup();
    const id = orphan(s, "OVERDUE");
    expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(id))).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("pending");
    expect(await rowsOf(s.order.id)).toHaveLength(1);
  });

  test("órfã paga com o pedido já pago: registra, avisa 'pagamento em dobro' e não entrega de novo", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "RECEIVED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    const id = orphan(s, "RECEIVED");
    const out = await warnings(async () => expect((await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(id))).status).toBe(200));
    expect(out).toContain("pagamento em dobro");
    expect(await statusOf(s.order.id)).toBe("paid");
    expect((await rowsOf(s.order.id)).map((r) => r.providerId)).toContain(id);
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(1);
  });

  test("órfã paga com o pedido pendente: o dinheiro chegou, o pedido vira paid (uma entrega)", async () => {
    const s = await setup();
    const id = orphan(s, "RECEIVED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(id));
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(id));
    expect(await statusOf(s.order.id)).toBe("paid");
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(1);
  });

  test("órfã paga com o pedido expirado: libera o pedido", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "OVERDUE");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId));
    expect(await statusOf(s.order.id)).toBe("expired");
    const id = orphan(s, "RECEIVED");
    await handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(id));
    expect(await statusOf(s.order.id)).toBe("paid");
  });
});

describe("rota HTTP", () => {
  const call = (storeId: string, init: RequestInit) =>
    POST(new Request("http://localhost/api/webhooks/asaas/x", { method: "POST", ...init }), { params: Promise.resolve({ storeId }) });

  test("storeId que não é UUID -> 404", async () => {
    expect((await call("abc", { body: "{}" })).status).toBe(404);
  });

  test("corpo acima de 64 KB -> 413 (declarado ou em fluxo)", async () => {
    const s = await setup();
    const big = JSON.stringify({ pad: "x".repeat(70 * 1024) });
    expect((await call(s.storeId, { body: big, headers: { "asaas-access-token": s.webhookToken } })).status).toBe(413);
  });

  test("fluxo completo pela rota: token certo paga; JSON inválido com token certo -> 200", async () => {
    const s = await setup();
    s.fake.setStatus(s.paymentId, "RECEIVED");
    const h = { "asaas-access-token": s.webhookToken, "content-type": "application/json" };
    expect((await call(s.storeId, { body: "{nao json", headers: h })).status).toBe(200);
    expect((await call(s.storeId, { body: JSON.stringify(event(s.paymentId)), headers: h })).status).toBe(200);
    expect(await statusOf(s.order.id)).toBe("paid");
    expect((await call(s.storeId, { body: JSON.stringify(event(s.paymentId)), headers: { "asaas-access-token": "x" } })).status).toBe(401);
  });
});

describe("propriedade: webhook repetido, fora de ordem e contraditório", () => {
  const STATUSES = ["PENDING", "RECEIVED", "CONFIRMED", "OVERDUE", "REFUNDED", "CHARGEBACK_REQUESTED", "AWAITING_CHARGEBACK_REVERSAL", "WEIRD"];

  // Modelo: o estado segue o status reconsultado quando a máquina permite; expired -> paid só pelo caminho do Asaas.
  function model(seq: string[]): { state: OrderStatus; delivered: number } {
    let state: OrderStatus = "pending";
    let delivered = 0;
    for (const s of seq) {
      const to = mapAsaasStatus(s);
      if (!to || to === state) continue;
      const lateExpired = state === "expired" && to === "paid";
      if (!lateExpired && !ALLOWED[state].includes(to)) continue;
      if (to === "paid" && state !== "disputed") delivered++;
      state = to;
    }
    return { state, delivered };
  }

  test("N entregas de eventos com corpos contraditórios terminam no estado da reconsulta e enfileiram a entrega uma vez", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ real: fc.constantFrom(...STATUSES), claimed: fc.constantFrom(...STATUSES), copies: fc.integer({ min: 1, max: 3 }) }), { minLength: 1, maxLength: 5 }),
        async (steps) => {
          const s = await setup();
          for (const step of steps) {
            s.fake.setStatus(s.paymentId, step.real);
            const rs = await Promise.all(
              Array.from({ length: step.copies }, () => handleAsaasWebhook(s.storeId, hdr(s.webhookToken), event(s.paymentId, step.claimed))),
            );
            for (const r of rs) expect(r.status).toBe(200);
          }
          const expected = model(steps.map((x) => x.real));
          expect(await statusOf(s.order.id)).toBe(expected.state);
          expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(expected.delivered);
          expect(expected.delivered).toBeLessThanOrEqual(1);
          expect(await jobsOf(s.order.id, "notify_seller")).toHaveLength(expected.delivered);
        },
      ),
      { numRuns: 25 },
    );
  });
});
