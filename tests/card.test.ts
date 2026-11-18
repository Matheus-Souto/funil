import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { cardAttempt, job, orders, payment } from "@/lib/db/schema";
import { asaasDueDate, createAsaasClient, setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { payWithCard, DECLINE_MESSAGE, UNKNOWN_IP, UNKNOWN_MESSAGE, type CardDeps, type CardPaymentInput } from "@/lib/payments/asaas/card";
import { clientIpFrom, handleCardCheckout } from "@/lib/payments/asaas/card-http";
import { ensureAsaasCustomer, startAsaasPix } from "@/lib/payments/asaas/pix";
import { handleAsaasWebhook } from "@/lib/payments/asaas/webhook";
import { resetCardFingerprintsForTests } from "@/lib/payments/ratelimit";
import { refundOrder } from "@/lib/payments/refund";
import { createTestDb, type TestDb } from "./db";
import { createFakeAsaas, newAsaasOrder, newCardOrder, owner, seedAsaasStore } from "./asaas-helpers";
import type { FakeAsaas } from "./fakes/asaas";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setAsaasFetchForTests();
  await t.drop();
});
afterEach(() => {
  setAsaasFetchForTests();
  resetCardFingerprintsForTests();
});

// Dados de cartão únicos para as varreduras (CVV 987, validade 08/2034, titular inconfundível).
const APPROVE = "4444444444444444";
const DECLINE = "5184019740373151";
const CVV = "987";
const HOLDER = "TITULAR UNICO ZETA";

const tick = () => new Promise<void>((r) => setImmediate(r));
const fastDeps: CardDeps = { wait: tick };
let ipSeq = 0;
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const email = () => `c-${randomUUID()}@example.com`;

function input(orderPublicId: string, over: Partial<CardPaymentInput> & { number?: string } = {}): CardPaymentInput {
  const { number, ...rest } = over;
  return {
    orderPublicId,
    idempotencyKey: randomUUID(),
    installments: 1,
    card: { holderName: HOLDER, number: number ?? APPROVE, expiryMonth: "08", expiryYear: "2034", ccv: CVV },
    holder: { cpf: "52998224725", postalCode: "01310-100", addressNumber: "100" },
    clientIp: nextIp(),
    ...rest,
  };
}

const lookups = (fake: FakeAsaas, orderId: string) =>
  fake.calls.filter((c) => c.method === "GET" && c.path === "/payments" && c.query.get("externalReference") === orderId);
const paymentPosts = (fake: FakeAsaas) => fake.calls.filter((c) => c.method === "POST" && c.path === "/payments");
const attempts = (storeId: string, orderId: string) =>
  withStore(storeId, (tx) => tx.select().from(cardAttempt).where(eq(cardAttempt.orderId, orderId)));
const orderRow = async (storeId: string, id: string) =>
  (await withStore(storeId, (tx) => tx.select().from(orders).where(eq(orders.id, id))))[0]!;

async function setup(priceCents = 990, maxInstallments = 1) {
  const fake = createFakeAsaas();
  const s = await seedAsaasStore(fake, priceCents, { maxInstallments });
  return { fake, ...s, call: { storeId: s.storeId } };
}

/** Segura o POST /payments até `release()`; `arrived` resolve quando a chamada chega ao "Asaas". */
function gatePayments(fake: FakeAsaas) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  setAsaasFetchForTests((async (i: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(i).endsWith("/payments")) {
      reached();
      await gate;
    }
    return fake.fetch(i, init);
  }) as unknown as typeof fetch);
  return { release, arrived };
}

/** Captura stdout/stderr e console.* (tudo o que `log` ou um console.* escreveria). */
function captureOutput() {
  const chunks: string[] = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const cons = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const grab = ((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = grab;
  process.stderr.write = grab;
  for (const k of Object.keys(cons) as (keyof typeof cons)[]) console[k] = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  return {
    text: () => chunks.join("\n"),
    restore() {
      process.stdout.write = out;
      process.stderr.write = err;
      Object.assign(console, cons);
    },
  };
}

/** Texto sem ids/uuids/datas, para procurar dados de cartão sem falso positivo. */
const scrub = (s: string) =>
  s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "U")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}(:\d{2})?)?/g, "D")
    .replace(/(pay|cus|ins)_\d+/g, "ID");
const token = (v: string) => new RegExp(`(?<![0-9A-Za-z_-])${v}(?![0-9A-Za-z_-])`);

async function dumpAllTables(): Promise<string> {
  const tables = (await t.ownerDb.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as {
    tablename: string;
  }[];
  expect(tables.map((r) => r.tablename)).toEqual(expect.arrayContaining(["card_attempt", "audit_log", "job", "payment", "rate_limit"]));
  const parts: string[] = [];
  for (const { tablename } of tables) {
    parts.push(JSON.stringify(await t.ownerDb.execute(sql.raw(`select * from "${tablename}"`))));
  }
  return parts.join("\n");
}

function expectNoCardData(text: string, pans: string[]) {
  const clean = scrub(text);
  for (const pan of pans) {
    expect(text).not.toContain(pan);
    expect(text).not.toContain(pan.slice(0, 8));
  }
  expect(text).not.toContain(HOLDER);
  expect(clean).not.toMatch(token(CVV));
  expect(clean).not.toMatch(token("2034"));
}

describe("payWithCard: aprovação", () => {
  test("cobra uma vez no cartão com remoteIp do cliente; pedido pago, payment e tentativa gravados", async () => {
    const { fake, call, storeId, offerId } = await setup(990);
    const o = await newCardOrder(storeId, offerId, email());
    const inp = input(o.publicId);
    const r = await payWithCard(call, inp, fastDeps);
    expect(r).toEqual({ status: "approved" });

    const posts = paymentPosts(fake);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as Record<string, unknown>;
    expect(body.billingType).toBe("CREDIT_CARD");
    expect(body.value).toBe(9.9);
    expect(body.remoteIp).toBe(inp.clientIp);
    expect(body.externalReference).toBe(o.id);
    expect(body.installmentCount).toBeUndefined();
    expect(body.creditCard).toEqual({ holderName: HOLDER, number: APPROVE, expiryMonth: "08", expiryYear: "2034", ccv: CVV });
    expect(body.creditCardHolderInfo).toEqual({
      name: HOLDER,
      email: expect.stringContaining("@example.com"),
      cpfCnpj: "52998224725",
      postalCode: "01310100",
      addressNumber: "100",
      phone: "11988887777",
      mobilePhone: "11988887777",
    });

    expect((await orderRow(storeId, o.id)).status).toBe("paid");
    const pays = await withStore(storeId, (tx) => tx.select().from(payment).where(eq(payment.orderId, o.id)));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.status).toBe("CONFIRMED");
    expect(pays[0]!.amountCents).toBe(990);
    const [a] = await attempts(storeId, o.id);
    expect(a!.status).toBe("approved");
    expect(a!.asaasPaymentId).toBe(pays[0]!.providerId);
    const jobs = await t.ownerDb.select().from(job).where(eq(job.storeId, storeId));
    expect(jobs.map((j) => j.type)).toContain("deliver_order");
  });

  test("mesma idempotencyKey em 2 chamadas paralelas -> uma única cobrança no Asaas", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    const inp = input(o.publicId);
    const rs = await Promise.all([payWithCard(call, inp, fastDeps), payWithCard(call, inp, fastDeps)]);
    expect(rs).toEqual([{ status: "approved" }, { status: "approved" }]);
    expect(paymentPosts(fake)).toHaveLength(1);
    expect(await attempts(storeId, o.id)).toHaveLength(1);
  });

  test("segunda chamada com a mesma chave enquanto a primeira está no Asaas espera o resultado dela", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    const inp = input(o.publicId);
    const gate = gatePayments(fake);
    const first = payWithCard(call, inp, fastDeps);
    await gate.arrived;
    let waited = 0;
    const second = payWithCard(call, inp, {
      wait: async () => {
        waited++;
        gate.release();
        await tick();
      },
    });
    expect(await Promise.all([first, second])).toEqual([{ status: "approved" }, { status: "approved" }]);
    expect(waited).toBeGreaterThan(0);
    expect(paymentPosts(fake)).toHaveLength(1);
  });

  test("outra chave enquanto uma tentativa está em andamento -> conflict, sem segunda cobrança", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    const gate = gatePayments(fake);
    const first = payWithCard(call, input(o.publicId), fastDeps);
    await gate.arrived;
    const e = await payWithCard(call, input(o.publicId), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
    gate.release();
    expect(await first).toEqual({ status: "approved" });
    expect(paymentPosts(fake)).toHaveLength(1);
  });

  test("chaves diferentes em pedido já pago -> approved sem nova cobrança", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    expect((await payWithCard(call, input(o.publicId), fastDeps)).status).toBe("approved");
    expect(await payWithCard(call, input(o.publicId), fastDeps)).toEqual({ status: "approved" });
    expect(paymentPosts(fake)).toHaveLength(1);
  });

  test("cliente sem CPF: usa o CPF do titular para criar o cliente no Asaas", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email(), null);
    expect((await payWithCard(call, input(o.publicId), fastDeps)).status).toBe("approved");
    const created = fake.calls.find((c) => c.path === "/customers")!.body as Record<string, unknown>;
    expect(created.cpfCnpj).toBe("52998224725");
  });
});

describe("payWithCard: validação e isolamento", () => {
  test("parcelas acima do máximo da oferta -> invalid_input, sem Asaas e sem tentativa", async () => {
    const { fake, call, storeId, offerId } = await setup(990, 1);
    const o = await newCardOrder(storeId, offerId, email());
    const e = await payWithCard(call, input(o.publicId, { installments: 2 }), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("invalid_input");
    expect(paymentPosts(fake)).toHaveLength(0);
    expect(await attempts(storeId, o.id)).toHaveLength(0);
  });

  test("dados do cartão inválidos -> invalid_input sem ecoar valores", async () => {
    const { call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    const e = (await payWithCard(call, input(o.publicId, { number: "12345" }), fastDeps).catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("invalid_input");
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain("12345");
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(CVV);
  });

  test("pedido de outra loja, inexistente ou de outro método -> not_found / conflict", async () => {
    const a = await setup();
    const b = await setup();
    const ob = await newCardOrder(b.storeId, b.offerId, email());
    const e1 = await payWithCard(a.call, input(ob.publicId), fastDeps).catch((x: unknown) => x);
    expect((e1 as ActionError).code).toBe("not_found");
    const e2 = await payWithCard(a.call, input("nao-existe"), fastDeps).catch((x: unknown) => x);
    expect((e2 as ActionError).code).toBe("not_found");
    const pix = await newAsaasOrder(a.storeId, a.offerId, email());
    const e3 = await payWithCard(a.call, input(pix.publicId), fastDeps).catch((x: unknown) => x);
    expect((e3 as ActionError).code).toBe("conflict");
    expect(paymentPosts(a.fake)).toHaveLength(0);
  });

  test("a mesma chave reutilizada em outro pedido -> conflict", async () => {
    const { call, storeId, offerId } = await setup();
    const o1 = await newCardOrder(storeId, offerId, email());
    const o2 = await newCardOrder(storeId, offerId, email());
    const inp = input(o1.publicId);
    await payWithCard(call, inp, fastDeps);
    const e = await payWithCard(call, { ...inp, orderPublicId: o2.publicId }, fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
  });
});

describe("payWithCard: recusa e vazamento de dados (Review Focus 5)", () => {
  test("recusa cujo erro ecoa número e CVV: mensagem genérica; logs, resposta e tentativa sem dados do cartão", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    fake.fail("POST /payments", 400, `Cartão ${APPROVE} cvv ${CVV} validade 08/2034 de ${HOLDER} recusado`);
    const cap = captureOutput();
    let r;
    try {
      r = await payWithCard(call, input(o.publicId), fastDeps);
    } finally {
      cap.restore();
    }
    expect(r).toEqual({ status: "declined", message: DECLINE_MESSAGE });
    expect(DECLINE_MESSAGE).toBe("Pagamento recusado. Confira os dados ou pague com Pix.");
    expect(cap.text()).not.toContain("4444");
    expectNoCardData(cap.text() + JSON.stringify(r), [APPROVE]);
    const [a] = await attempts(storeId, o.id);
    expect(a!.status).toBe("declined");
    expect(JSON.stringify(a)).not.toContain("4444");
    expect((await orderRow(storeId, o.id)).status).toBe("pending");
  });

  test("varredura: depois de uma aprovação e uma recusa, nenhuma tabela nem log contém número, CVV, validade ou titular", async () => {
    const { call, storeId, offerId } = await setup();
    const o1 = await newCardOrder(storeId, offerId, email());
    const o2 = await newCardOrder(storeId, offerId, email());
    const cap = captureOutput();
    let r1, r2;
    try {
      r1 = await payWithCard(call, input(o1.publicId), fastDeps);
      r2 = await payWithCard(call, input(o2.publicId, { number: DECLINE }), fastDeps);
    } finally {
      cap.restore();
    }
    expect(r1!.status).toBe("approved");
    expect(r2!.status).toBe("declined");
    expectNoCardData(cap.text(), [APPROVE, DECLINE]);
    expectNoCardData(await dumpAllTables(), [APPROVE, DECLINE]);
  });
});

describe("payWithCard: resultado desconhecido (timeout/rede)", () => {
  test("não diz recusado; tentativa 'error'; nova tentativa em 2 min é recusada; o webhook liquida", async () => {
    const { fake, call, storeId, offerId, webhookToken } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    fake.loseResponse("POST /payments");
    const t0 = new Date();
    const r = await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => t0 });
    expect(r).toEqual({ status: "unknown", message: UNKNOWN_MESSAGE });
    expect(UNKNOWN_MESSAGE).toBe("Não foi possível confirmar o pagamento. Verifique em instantes antes de tentar de novo.");
    expect((await attempts(storeId, o.id))[0]!.status).toBe("error");
    expect((await orderRow(storeId, o.id)).status).toBe("pending");
    fake.clearFailures();

    const soon = new Date(t0.getTime() + 60_000);
    const e = await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => soon }).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
    expect(paymentPosts(fake)).toHaveLength(1);

    const charged = [...fake.payments.values()].find((p) => p.externalReference === o.id)!;
    const res = await handleAsaasWebhook(storeId, new Headers({ "asaas-access-token": webhookToken }), {
      event: "PAYMENT_CONFIRMED",
      payment: { id: charged.id },
    });
    expect(res.status).toBe(200);
    expect((await orderRow(storeId, o.id)).status).toBe("paid");

    const later = new Date(t0.getTime() + 3 * 60_000);
    expect(await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => later })).toEqual({ status: "approved" });
    expect(paymentPosts(fake)).toHaveLength(1);
  });

  test("passados 2 min sem confirmação, uma nova tentativa é permitida", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    fake.fail("POST /payments", 503, "indisponível");
    const t0 = new Date();
    expect((await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => t0 })).status).toBe("unknown");
    fake.clearFailures();
    const later = new Date(t0.getTime() + 3 * 60_000);
    expect((await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => later })).status).toBe("approved");
    // Antes de permitir, conferiu no Asaas se a tentativa desconhecida cobrou (nenhuma cobrança: segue).
    expect(lookups(fake, o.id)).toHaveLength(1);
    expect(paymentPosts(fake)).toHaveLength(2);
  });

  test("conferência no Asaas após 2 min: cobrança paga liquida o pedido pelo caminho do webhook, sem nova cobrança", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    fake.loseResponse("POST /payments");
    const t0 = new Date();
    expect((await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => t0 })).status).toBe("unknown");
    fake.clearFailures();
    const later = new Date(t0.getTime() + 3 * 60_000);
    expect(await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => later })).toEqual({ status: "approved" });
    expect(lookups(fake, o.id)).toHaveLength(1);
    expect(paymentPosts(fake)).toHaveLength(1);
    expect((await orderRow(storeId, o.id)).status).toBe("paid");
    const pays = await withStore(storeId, (tx) => tx.select().from(payment).where(eq(payment.orderId, o.id)));
    expect(pays.map((p) => p.status)).toEqual(["CONFIRMED"]);
    const jobs = await t.ownerDb.select().from(job).where(eq(job.storeId, storeId));
    expect(jobs.filter((j) => j.type === "deliver_order")).toHaveLength(1);
  });

  test("conferência no Asaas: cobrança em análise -> recusa a nova tentativa", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    fake.loseResponse("POST /payments");
    const t0 = new Date();
    await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => t0 });
    fake.clearFailures();
    const charged = [...fake.payments.values()].find((p) => p.externalReference === o.id)!;
    fake.setStatus(charged.id, "AWAITING_RISK_ANALYSIS");
    const later = new Date(t0.getTime() + 3 * 60_000);
    const e = (await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => later }).catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("Já existe um pagamento em análise para este pedido. Aguarde alguns minutos.");
    expect(paymentPosts(fake)).toHaveLength(1);
    expect((await orderRow(storeId, o.id)).status).toBe("pending");
  });

  test("conferência no Asaas falha -> recusa (fail closed), sem nova cobrança", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    fake.loseResponse("POST /payments");
    const t0 = new Date();
    await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => t0 });
    fake.clearFailures();
    fake.fail("GET /payments?", 500, "fora do ar");
    const later = new Date(t0.getTime() + 3 * 60_000);
    const e = (await payWithCard(call, input(o.publicId), { ...fastDeps, now: () => later }).catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("conflict");
    expect(e.message).toBe(UNKNOWN_MESSAGE);
    expect(paymentPosts(fake)).toHaveLength(1);
  });

  test("tentativa 'processing' abandonada (mais velha que a janela) também passa pela conferência", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    await withStore(storeId, (tx) =>
      tx.insert(cardAttempt).values({
        storeId,
        orderId: o.id,
        idempotencyKey: randomUUID(),
        status: "processing",
        createdAt: new Date(Date.now() - 10 * 60_000),
      }),
    );
    expect((await payWithCard(call, input(o.publicId), fastDeps)).status).toBe("approved");
    expect(lookups(fake, o.id)).toHaveLength(1);
  });

  test("sem tentativa anterior desconhecida, não consulta o Asaas", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    expect((await payWithCard(call, input(o.publicId), fastDeps)).status).toBe("approved");
    expect(lookups(fake, o.id)).toHaveLength(0);
  });

  test("falha antes da cobrança (Asaas desconectado) não trava o pedido", async () => {
    const { call, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    await t.ownerDb.execute(sql`delete from integration where store_id = ${storeId}`);
    const e = await payWithCard(call, input(o.publicId), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("conflict");
    const [a] = await attempts(storeId, o.id);
    expect(a!.status).toBe("error");
    expect(a!.errorMessage).toBe("sem_cobranca");
  });
});

describe("payWithCard: limites e Turnstile", () => {
  test("11ª tentativa do mesmo IP na hora -> rate_limited (sem chamar o Asaas)", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const ip = "203.0.113.11";
    for (let i = 0; i < 10; i++) {
      const o = await newCardOrder(storeId, offerId, email());
      const r = await payWithCard(call, input(o.publicId, { clientIp: ip, number: `40000000000${String(i).padStart(5, "0")}` }), fastDeps);
      expect(r.status).toBe("approved");
    }
    const o = await newCardOrder(storeId, offerId, email());
    const e = await payWithCard(call, input(o.publicId, { clientIp: ip, number: "4000000000099999" }), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("rate_limited");
    expect(paymentPosts(fake)).toHaveLength(10);
  });

  test("IP desconhecido (sem proxy confiável): sem limite por IP; e-mail e cartão continuam valendo", async () => {
    const { fake, call, storeId, offerId } = await setup();
    for (let i = 0; i < 11; i++) {
      const o = await newCardOrder(storeId, offerId, email());
      const r = await payWithCard(call, input(o.publicId, { clientIp: UNKNOWN_IP, number: `42000000000${String(i).padStart(5, "0")}` }), fastDeps);
      expect(r.status).toBe("approved");
    }
    const rows = await t.ownerDb.execute(sql`select key from rate_limit where key like 'card:ip:%unknown%'`);
    expect(rows).toHaveLength(0);
    expect((paymentPosts(fake)[0]!.body as { remoteIp: string }).remoteIp).toBe("0.0.0.0");
    const pan = "4200000000088888";
    for (let i = 0; i < 3; i++) {
      const o = await newCardOrder(storeId, offerId, email());
      await payWithCard(call, input(o.publicId, { clientIp: UNKNOWN_IP, number: pan }), fastDeps);
    }
    const o = await newCardOrder(storeId, offerId, email());
    const e = await payWithCard(call, input(o.publicId, { clientIp: UNKNOWN_IP, number: pan }), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("rate_limited");
  });

  test("IP desconhecido: uma recusa exige Turnstile para o mesmo e-mail", async () => {
    const { call, storeId, offerId } = await setup();
    const mail = email();
    const deps: CardDeps = { ...fastDeps, verifyTurnstile: async (tok) => tok === "ok" };
    const o1 = await newCardOrder(storeId, offerId, mail);
    expect((await payWithCard(call, input(o1.publicId, { clientIp: UNKNOWN_IP, number: DECLINE }), deps)).status).toBe("declined");
    const o2 = await newCardOrder(storeId, offerId, mail);
    const e = (await payWithCard(call, input(o2.publicId, { clientIp: UNKNOWN_IP }), deps).catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("rate_limited");
    // outro comprador (outro e-mail) não é afetado pela recusa
    const o3 = await newCardOrder(storeId, offerId, email());
    expect((await payWithCard(call, input(o3.publicId, { clientIp: UNKNOWN_IP }), deps)).status).toBe("approved");
  });

  test("4ª tentativa do mesmo cartão na hora -> rate_limited", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const pan = "4000000000077777";
    for (let i = 0; i < 3; i++) {
      const o = await newCardOrder(storeId, offerId, email());
      expect((await payWithCard(call, input(o.publicId, { number: pan }), fastDeps)).status).toBe("approved");
    }
    const o = await newCardOrder(storeId, offerId, email());
    const e = await payWithCard(call, input(o.publicId, { number: pan }), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("rate_limited");
    expect(paymentPosts(fake)).toHaveLength(3);
  });

  test("6ª tentativa do mesmo e-mail na hora -> rate_limited", async () => {
    const { call, storeId, offerId } = await setup();
    const mail = email();
    for (let i = 0; i < 5; i++) {
      const o = await newCardOrder(storeId, offerId, mail);
      const r = await payWithCard(call, input(o.publicId, { number: `41000000000${String(i).padStart(5, "0")}` }), fastDeps);
      expect(r.status).toBe("approved");
    }
    const o = await newCardOrder(storeId, offerId, mail);
    const e = await payWithCard(call, input(o.publicId, { number: "4100000000099999" }), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("rate_limited");
  });

  test("Turnstile só é exigido depois de uma recusa do mesmo IP", async () => {
    const { call, storeId, offerId } = await setup();
    const ip = "203.0.113.77";
    const seen: (string | undefined)[] = [];
    const deps: CardDeps = {
      ...fastDeps,
      verifyTurnstile: async (tok) => {
        seen.push(tok);
        return tok === "ok";
      },
    };
    const o1 = await newCardOrder(storeId, offerId, email());
    expect((await payWithCard(call, input(o1.publicId, { clientIp: ip, number: DECLINE }), deps)).status).toBe("declined");
    expect(seen).toHaveLength(0);

    const o2 = await newCardOrder(storeId, offerId, email());
    const e = (await payWithCard(call, input(o2.publicId, { clientIp: ip }), deps).catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("rate_limited");
    expect(e.details).toEqual({ captcha: true });
    const ok = await payWithCard(call, input(o2.publicId, { clientIp: ip, turnstileToken: "ok" }), deps);
    expect(ok.status).toBe("approved");
    expect(seen).toEqual([undefined, "ok"]);
  });
});

describe("payWithCard: parcelado", () => {
  test("envia installmentCount + totalValue (sem value); webhook de outra parcela não vira cobrança em dobro; estorno pelo parcelamento", async () => {
    const { fake, call, storeId, offerId, webhookToken } = await setup(1000, 3);
    const o = await newCardOrder(storeId, offerId, email());
    expect((await payWithCard(call, input(o.publicId, { installments: 3 }), fastDeps)).status).toBe("approved");
    const body = paymentPosts(fake)[0]!.body as Record<string, unknown>;
    expect(body.installmentCount).toBe(3);
    expect(body.totalValue).toBe(10);
    expect(body.value).toBeUndefined();
    expect(body.installmentValue).toBeUndefined();

    const [inst] = [...fake.installments.values()];
    const cap = captureOutput();
    try {
      for (const pid of inst!.payments) {
        const r = await handleAsaasWebhook(storeId, new Headers({ "asaas-access-token": webhookToken }), {
          event: "PAYMENT_CONFIRMED",
          payment: { id: pid },
        });
        expect(r.status).toBe(200);
      }
    } finally {
      cap.restore();
    }
    expect(cap.text()).not.toContain("pagamento em dobro");
    const pays = await withStore(storeId, (tx) => tx.select().from(payment).where(eq(payment.orderId, o.id)));
    expect(pays.every((p) => (p.raw as { duplicate?: boolean } | null)?.duplicate !== true)).toBe(true);
    expect((await orderRow(storeId, o.id)).status).toBe("paid");

    await runAction(refundOrder, { storeId, actor: owner, origin: "panel" }, { orderId: o.id });
    expect(fake.calls.some((c) => c.method === "POST" && c.path === `/installments/${inst!.id}/refund`)).toBe(true);
    expect((await orderRow(storeId, o.id)).status).toBe("refunded");
  });

  test("parcelado com resposta perdida: o webhook de qualquer parcela libera o pedido pelo total do parcelamento", async () => {
    const { fake, call, storeId, offerId, webhookToken } = await setup(1000, 3);
    const o = await newCardOrder(storeId, offerId, email());
    fake.loseResponse("POST /payments");
    expect((await payWithCard(call, input(o.publicId, { installments: 3 }), fastDeps)).status).toBe("unknown");
    fake.clearFailures();
    const [inst] = [...fake.installments.values()];
    const r = await handleAsaasWebhook(storeId, new Headers({ "asaas-access-token": webhookToken }), {
      event: "PAYMENT_CONFIRMED",
      payment: { id: inst!.payments[2]! },
    });
    expect(r.status).toBe(200);
    expect((await orderRow(storeId, o.id)).status).toBe("paid");
  });
});

describe("cliente Asaas: erros de cobrança com cartão são opacos", () => {
  test("400 no CREDIT_CARD: mensagem sem o texto do Asaas; details só com status e códigos", async () => {
    const fake = createFakeAsaas();
    const c = createAsaasClient({ apiKey: fake.apiKey, env: "sandbox", fetch: fake.fetch });
    fake.fail("POST /payments", 400, `Cartão ${APPROVE} cvv ${CVV} de ${HOLDER}`);
    const e = (await c
      .createPayment({ customer: "cus_x", billingType: "CREDIT_CARD", value: 1, dueDate: "2026-11-18", externalReference: "r" })
      .catch((x: unknown) => x)) as ActionError;
    expect(e.code).toBe("provider_error");
    expect(e.message).toBe("Asaas respondeu 400");
    expect(e.details).toEqual({ status: 400, errorCodes: ["invalid_action"] });
    const lost = createAsaasClient({
      apiKey: "k",
      env: "sandbox",
      fetch: (() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch,
    });
    const n = (await lost
      .createPayment({ customer: "cus_x", billingType: "CREDIT_CARD", value: 1, dueDate: "2026-11-18", externalReference: "r" })
      .catch((x: unknown) => x)) as ActionError;
    expect(n.details).toEqual({ status: 0, errorCodes: [] });
  });
});

describe("Asaas (pendências da Task 9)", () => {
  test("createCustomer envia notificationDisabled: true", async () => {
    const { fake, storeId, offerId } = await setup();
    const o = await newCardOrder(storeId, offerId, email());
    await ensureAsaasCustomer({ storeId }, o.customerId);
    const body = fake.calls.find((c) => c.path === "/customers")!.body as Record<string, unknown>;
    expect(body.notificationDisabled).toBe(true);
  });

  test("asaasDueDate usa o calendário de America/Sao_Paulo", () => {
    // 02:30 UTC do dia 19 ainda é 23:30 do dia 18 em São Paulo.
    expect(asaasDueDate(new Date("2026-11-19T02:30:00Z"))).toBe("2026-11-18");
    expect(asaasDueDate(new Date("2026-11-19T02:30:00Z"), 1)).toBe("2026-11-19");
    expect(asaasDueDate(new Date("2026-12-31T12:00:00Z"), 1)).toBe("2027-01-01");
  });

  test("Pix: dueDate = amanhã em São Paulo; cartão: hoje em São Paulo", async () => {
    const { fake, call, storeId, offerId } = await setup();
    const pix = await newAsaasOrder(storeId, offerId, email());
    await startAsaasPix({ storeId }, pix.id, { now: new Date("2026-11-18T12:00:00Z") });
    expect((paymentPosts(fake)[0]!.body as { dueDate: string }).dueDate).toBe("2026-11-19");
    const card = await newCardOrder(storeId, offerId, email());
    const late = new Date("2026-11-19T02:30:00Z");
    await payWithCard(call, input(card.publicId), { ...fastDeps, now: () => late });
    expect((paymentPosts(fake)[1]!.body as { dueDate: string }).dueDate).toBe("2026-11-18");
  });
});

describe("rota POST /api/checkout/card", () => {
  const store = { id: "", slug: "s", name: "Loja" };
  const req = (body: string, headers: Record<string, string> = {}, url = "http://127.0.0.1:3000/api/checkout/card") =>
    new Request(url, { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3000", ...headers }, body });

  test("clientIpFrom: com proxy confiável, a entrada mais à direita; entradas forjadas à esquerda não mudam a chave", () => {
    for (const xff of ["203.0.113.4", "6.6.6.6, 203.0.113.4", "1.1.1.1, 2.2.2.2, 203.0.113.4"]) {
      expect(clientIpFrom(new Headers({ "x-forwarded-for": xff }), 1)).toBe("203.0.113.4");
    }
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.4, 10.0.0.1" }), 2)).toBe("203.0.113.4");
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "6.6.6.6, ::ffff:127.0.0.1" }), 1)).toBe("127.0.0.1");
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "6.6.6.6, lixo" }), 1)).toBe(UNKNOWN_IP);
    expect(clientIpFrom(new Headers(), 1)).toBe(UNKNOWN_IP);
  });

  test("clientIpFrom: sem proxy confiável nunca lê X-Forwarded-For (chave fixa 'unknown')", () => {
    expect(UNKNOWN_IP).toBe("unknown");
    for (const xff of ["10.0.0.5", "6.6.6.6, 203.0.113.4"]) expect(clientIpFrom(new Headers({ "x-forwarded-for": xff }), 0)).toBe(UNKNOWN_IP);
    expect(clientIpFrom(new Headers(), 0)).toBe(UNKNOWN_IP);
  });

  test("loja desconhecida -> 404; corpo > 16 KB -> 413; JSON inválido -> 400", async () => {
    const none = { resolveStore: async () => null, nodeEnv: "test" };
    expect((await handleCardCheckout(req("{}"), none)).status).toBe(404);
    const opts = { resolveStore: async () => store, nodeEnv: "test" };
    expect((await handleCardCheckout(req("x".repeat(17 * 1024)), opts)).status).toBe(413);
    expect((await handleCardCheckout(req("{nao json"), opts)).status).toBe(400);
  });

  test("produção exige HTTPS, exceto em loopback; com proxy confiável vale x-forwarded-proto", async () => {
    const pay = async () => ({ status: "approved" as const });
    const prod = { resolveStore: async () => store, nodeEnv: "production", payWithCard: pay, trustProxy: 0 };
    const remote = req("{}", { host: "loja.example.com" }, "http://loja.example.com/api/checkout/card");
    expect((await handleCardCheckout(remote, prod)).status).toBe(403);
    expect((await handleCardCheckout(req("{}"), prod)).status).toBe(200);
    const proxied = req("{}", { host: "loja.example.com", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.4" }, "http://loja.example.com/api/checkout/card");
    expect((await handleCardCheckout(proxied, { ...prod, trustProxy: 1 })).status).toBe(200);
    const forged = req("{}", { host: "loja.example.com", "x-forwarded-proto": "https" }, "http://loja.example.com/api/checkout/card");
    expect((await handleCardCheckout(forged, prod)).status).toBe(403);
  });

  test("pedido desconhecido -> 404 sem ecoar dados; IP do cliente vai para payWithCard", async () => {
    const { storeId } = await setup();
    const body = JSON.stringify({ ...input("pedido-que-nao-existe"), clientIp: "6.6.6.6" });
    const res = await handleCardCheckout(req(body, { "x-forwarded-for": "203.0.113.50" }), {
      resolveStore: async () => ({ ...store, id: storeId }),
      nodeEnv: "test",
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("4444");
    expect(JSON.parse(text)).toEqual({ error: "not_found", message: "Pedido não encontrado" });

    let seenIp = "";
    await handleCardCheckout(req(body, { "x-forwarded-for": "6.6.6.6, 203.0.113.50" }), {
      resolveStore: async () => ({ ...store, id: storeId }),
      nodeEnv: "test",
      trustProxy: 1,
      payWithCard: async (_c, i) => {
        seenIp = i.clientIp;
        return { status: "approved" };
      },
    });
    expect(seenIp).toBe("203.0.113.50");
  });

  test("erro inesperado -> 500 genérico; o log não recebe dados do cartão", async () => {
    const cap = captureOutput();
    let res: Response;
    try {
      res = await handleCardCheckout(req(JSON.stringify(input("x"))), {
        resolveStore: async () => store,
        nodeEnv: "test",
        payWithCard: async (_c, i) => {
          throw new Error(`falhou com ${i.card.number}`);
        },
      });
    } finally {
      cap.restore();
    }
    expect(res!.status).toBe(500);
    expect(await res!.json()).toEqual({
      error: "internal",
      message: "Não foi possível processar o pagamento. Verifique em instantes antes de tentar de novo.",
    });
    expect(cap.text()).toContain("[redacted]");
    expect(cap.text()).not.toContain("44444444");
  });
});
