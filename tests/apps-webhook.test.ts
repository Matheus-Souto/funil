// Aviso ao app (Task 9): job `notify_app`, webhook assinado, novas tentativas pelo backoff próprio, alerta ao vendedor,
// reenvio com o mesmo id e a máquina de estados do pedido de app. O app é um servidor HTTP local (loopback liberado só
// para o teste); relógio e tempo-limite são injetados (nenhuma espera real).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { ActionError, runAction, type Ctx } from "@/lib/actions/core";
import { listAlerts } from "@/lib/alerts";
import {
  APP_WEBHOOK_BACKOFF_SECONDS,
  APP_WEBHOOK_ORDER_WAIT_SECONDS,
  APP_WEBHOOK_TIMEOUT_MS,
  appEventId,
  enqueueAppNotice,
  appWebhookDestinationAllowed,
  resendAppNotice,
  setAppWebhookForTests,
  signAppWebhook,
  type AppEventType,
} from "@/lib/apps/webhook";
import { setDbForTests, withStore } from "@/lib/db/client";
import { appWebhookDelivery, emailLog, job, orders, payment, storeAlert } from "@/lib/db/schema";
import { noticeFor, resendOrder } from "@/lib/delivery/jobs";
import { orderCode } from "@/lib/format";
import { runDueJobs } from "@/lib/jobs";
import { getHandlers } from "@/lib/jobs/handlers";
import { MCP_EXCLUDED } from "@/lib/mcp/tools";
import { allowedOrderActions, getOrderDetail } from "@/lib/orders/panel";
import { transitionOrder, type OrderStatus } from "@/lib/orders/state";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { startAsaasPix } from "@/lib/payments/asaas/pix";
import { handleAsaasWebhook } from "@/lib/payments/asaas/webhook";
import { APP_BUYER, connectAppWebhook, makeAppOrder, seedAppOffer, seedAppOrder, startFakeApp, type FakeApp } from "./apps-helpers";
import { createFakeAsaas, newAsaasOrder, seedAsaasStore } from "./asaas-helpers";
import { createTestDb, seedStore, type TestDb } from "./db";
import { panelCall, seedOrder, seedPanelStore } from "./panel-helpers";

const SECRET = "segredo-de-teste-do-webhook-do-app-0123456789";

let t: TestDb;
let app: FakeApp;
/** Relógio injetado: só anda quando o teste manda. Começa um pouco à frente do banco (jobs recém-criados já vencidos). */
const clock = { now: new Date(Date.now() + 5_000) };
const advance = (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
};
/** Tempo-limite injetado: guarda o que foi pedido e só dispara quando o teste chama `fire`. */
const timeouts = {
  requested: [] as number[],
  pending: null as null | (() => void),
  fire() {
    this.pending?.();
  },
};
const testDefaults = () =>
  setAppWebhookForTests({
    allowLoopback: true,
    now: () => clock.now,
    timer: (ms, onTimeout) => {
      timeouts.requested.push(ms);
      timeouts.pending = onTimeout;
      return () => {
        if (timeouts.pending === onTimeout) timeouts.pending = null;
      };
    },
  });

beforeAll(async () => {
  t = await createTestDb();
  app = await startFakeApp();
  testDefaults();
});
afterAll(async () => {
  setAppWebhookForTests();
  setAsaasFetchForTests();
  await app.close();
  await t.drop();
});
afterEach(() => {
  testDefaults();
  setAsaasFetchForTests();
  app.onHang = null;
});

const ctxOf = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "system" }, origin: "system", tx });
const transition = (storeId: string, orderId: string, to: OrderStatus) =>
  withStore(storeId, (tx) => transitionOrder(ctxOf(storeId, tx), orderId, to, "teste"));
const deliveriesOf = (orderId: string) =>
  t.ownerDb.select().from(appWebhookDelivery).where(eq(appWebhookDelivery.orderId, orderId)).orderBy(asc(appWebhookDelivery.sequence));
const jobsOf = (orderId: string, type: string) =>
  t.ownerDb
    .select()
    .from(job)
    .where(and(eq(job.type, type), sql`${job.payload}->>'orderId' = ${orderId}`));
const noticeJobs = (deliveryId: string) =>
  t.ownerDb
    .select()
    .from(job)
    .where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${deliveryId}`))
    .orderBy(asc(job.runAt), asc(job.id));
/** Roda só os `notify_app` vencidos pelo relógio injetado, com o handler registrado (como o worker). */
const runNotices = () => runDueJobs({ notify_app: getHandlers().notify_app! }, 50, () => clock.now, { types: ["notify_app"] });

let seq = 0;
/** Loja com oferta de app e o webhook apontando para um caminho só deste teste no app falso. */
async function appStore(opts: { connect?: boolean } = {}) {
  const { storeId } = await seedStore("Loja de app");
  const offer = await seedAppOffer(storeId);
  const path = `/hook/${++seq}`;
  if (opts.connect !== false) await connectAppWebhook(storeId, `${app.base}${path}`, SECRET);
  return { storeId, offer, path };
}
async function paidAppOrder(opts: { connect?: boolean } = {}) {
  const s = await appStore(opts);
  const order = await seedAppOrder(s.storeId, s.offer.id);
  await transition(s.storeId, order.id, "paid");
  return { ...s, order };
}
const bodyOf = (hit: { body: string }) =>
  JSON.parse(hit.body) as { id: string; tipo: string; criado_em: string; dados: Record<string, unknown> };

describe("assinatura e id do evento", () => {
  test("signAppWebhook: t=<t>,v1=<HMAC-SHA256(segredo, t.corpo) em hex>", () => {
    const body = '{"id":"evt_1","tipo":"ping"}';
    const expected = createHmac("sha256", SECRET).update(`1795000000.${body}`).digest("hex");
    expect(signAppWebhook(SECRET, body, 1795000000)).toBe(`t=1795000000,v1=${expected}`);
    expect(signAppWebhook(SECRET, body, 1795000001)).not.toBe(signAppWebhook(SECRET, body, 1795000000));
    expect(signAppWebhook(`${SECRET}x`, body, 1795000000)).not.toBe(signAppWebhook(SECRET, body, 1795000000));
  });

  test("appEventId: estável por (pedido, tipo, ocorrência) e diferente quando um deles muda", () => {
    const order = "0b1d4c0e-6f6e-4d6c-9a43-0c1f0f9b3a11";
    const id = appEventId(order, "pagamento.confirmado", 0);
    expect(id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(appEventId(order, "pagamento.confirmado", 0)).toBe(id);
    const others = [
      appEventId(order, "pagamento.confirmado", 1),
      appEventId(order, "pagamento.reembolsado", 0),
      appEventId("0b1d4c0e-6f6e-4d6c-9a43-0c1f0f9b3a12", "pagamento.confirmado", 0),
    ];
    expect(new Set([id, ...others]).size).toBe(4);
  });
});

describe("pedido de app pago", () => {
  test("um notify_app, nenhum deliver_order; o app recebe pagamento.confirmado assinado com o segredo e o t atual; nenhum e-mail ao comprador", async () => {
    const s = await paidAppOrder();
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(0);
    // Meta, aviso de venda ao vendedor e Telegram continuam saindo, como no pedido de download.
    for (const type of ["meta_event", "notify_seller", "notify_telegram"]) expect([type, (await jobsOf(s.order.id, type)).length]).toEqual([type, 1]);
    const [d] = await deliveriesOf(s.order.id);
    expect(d).toMatchObject({
      storeId: s.storeId,
      eventType: "pagamento.confirmado",
      eventId: appEventId(s.order.id, "pagamento.confirmado", 0),
      status: "pending",
      attempts: 0,
      lastHttpStatus: null,
    });
    expect((await noticeJobs(d!.id)).map((j) => [j.status, j.storeId, j.payload])).toEqual([["queued", s.storeId, { deliveryId: d!.id }]]);

    expect(await runNotices()).toBeGreaterThanOrEqual(1);
    const hits = app.hitsOf(s.path);
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.headers["user-agent"]).toBe("funil-webhook/1");
    expect(hit.headers["funil-evento"]).toBe(d!.eventId);
    const t0 = Math.floor(clock.now.getTime() / 1000);
    // A assinatura confere com o segredo sobre o corpo cru recebido, e o `t` é o instante do envio.
    expect(hit.headers["funil-assinatura"]).toBe(signAppWebhook(SECRET, hit.body, t0));
    expect(hit.headers["funil-assinatura"]).toBe(`t=${t0},v1=${createHmac("sha256", SECRET).update(`${t0}.${hit.body}`).digest("hex")}`);

    const [after] = await deliveriesOf(s.order.id);
    expect(after).toMatchObject({ status: "delivered", attempts: 1, lastHttpStatus: 200 });
    expect(after!.deliveredAt).toEqual(clock.now);
    expect((await noticeJobs(d!.id)).map((j) => j.status)).toEqual(["done"]);
    expect(await t.ownerDb.select().from(emailLog).where(eq(emailLog.orderId, s.order.id))).toHaveLength(0);
  });

  test("corpo: só id, tipo, criado_em e dados (conta, pedido, app_code, valor, método, pago_em); nada de e-mail, nome, telefone ou documento", async () => {
    const s = await paidAppOrder();
    await runNotices();
    const hit = app.hitsOf(s.path)[0]!;
    const [d] = await deliveriesOf(s.order.id);
    const [o] = await t.ownerDb.select().from(orders).where(eq(orders.id, s.order.id));
    expect(bodyOf(hit)).toEqual({
      id: d!.eventId,
      tipo: "pagamento.confirmado",
      criado_em: d!.createdAt.toISOString(),
      dados: {
        conta: s.order.account,
        pedido: s.order.publicId,
        app_code: "start_anual",
        valor_centavos: 49_700,
        metodo: "pix",
        pago_em: o!.paidAt!.toISOString(),
        sequencia: 1,
      },
    });
    const lower = hit.body.toLowerCase();
    for (const personal of [APP_BUYER.email, APP_BUYER.name, "helena", "prado", APP_BUYER.phone, APP_BUYER.cpf, s.order.id, s.storeId]) {
      expect([personal, lower.includes(personal.toLowerCase())]).toEqual([personal, false]);
    }
    // Nenhum cabeçalho leva o segredo.
    expect(JSON.stringify(hit.headers)).not.toContain(SECRET);
  });

  test("pago duas vezes (mesmo estado, e em paralelo): um aviso só", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id);
    const results = await Promise.allSettled([transition(s.storeId, order.id, "paid"), transition(s.storeId, order.id, "paid")]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.changed)).toHaveLength(1);
    expect(await transition(s.storeId, order.id, "paid")).toEqual({ changed: false });
    const ds = await deliveriesOf(order.id);
    expect(ds.map((d) => d.eventType)).toEqual(["pagamento.confirmado"]);
    expect(await noticeJobs(ds[0]!.id)).toHaveLength(1);
  });

  test("falha na transação desfaz o aviso (linha e job na mesma transação da mudança de estado)", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await withStore(s.storeId, async (tx) => {
      await transitionOrder(ctxOf(s.storeId, tx), order.id, "paid", "teste");
      throw new Error("desfaz");
    }).catch(() => undefined);
    expect(await deliveriesOf(order.id)).toHaveLength(0);
    expect(await t.ownerDb.select().from(job).where(and(eq(job.type, "notify_app"), eq(job.storeId, s.storeId)))).toHaveLength(0);
  });

  test("pedido de download continua com deliver_order e sem aviso ao app (regressão)", async () => {
    const shop = await seedPanelStore();
    const order = await seedOrder(shop, { status: "pending", method: "pix_asaas" });
    await transition(shop.storeId, order.id, "paid");
    expect(await jobsOf(order.id, "deliver_order")).toHaveLength(1);
    await transition(shop.storeId, order.id, "disputed");
    await transition(shop.storeId, order.id, "paid");
    await transition(shop.storeId, order.id, "refunded");
    expect((await jobsOf(order.id, "revoke_downloads")).length).toBe(2);
    expect(await jobsOf(order.id, "restore_downloads")).toHaveLength(1);
    expect(await deliveriesOf(order.id)).toHaveLength(0);
    expect(await t.ownerDb.select().from(job).where(and(eq(job.type, "notify_app"), eq(job.storeId, shop.storeId)))).toHaveLength(0);
  });
});

describe("novas tentativas", () => {
  test("500 do app: nova tentativa em 60 s; 2xx depois: entregue", async () => {
    const s = await appStore();
    app.plan(s.path, [500, 204]);
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    const [d] = await deliveriesOf(order.id);
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: 500, deliveredAt: null });
    const queued = (await noticeJobs(d!.id)).filter((j) => j.status === "queued");
    expect(queued.map((j) => j.runAt)).toEqual([new Date(clock.now.getTime() + 60_000)]);
    // Antes da hora nada sai.
    advance(59);
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(1);
    advance(1);
    await runNotices();
    const hits = app.hitsOf(s.path);
    expect(hits).toHaveLength(2);
    // A nova tentativa leva o MESMO id (o app deduplica) e uma assinatura do instante novo.
    expect(hits.map((h) => h.headers["funil-evento"])).toEqual([d!.eventId, d!.eventId]);
    expect(bodyOf(hits[1]!)).toEqual(bodyOf(hits[0]!));
    expect(hits[1]!.headers["funil-assinatura"]).toBe(signAppWebhook(SECRET, hits[1]!.body, Math.floor(clock.now.getTime() / 1000)));
    expect((await deliveriesOf(order.id))[0]).toMatchObject({ status: "delivered", attempts: 2, lastHttpStatus: 204, deliveredAt: clock.now });
    expect((await noticeJobs(d!.id)).filter((j) => j.status === "queued")).toHaveLength(0);
  });

  test("302 é falha: o redirecionamento nunca é seguido", async () => {
    const s = await appStore();
    app.plan(s.path, [302]);
    const before = app.hitsOf("/destino-do-redirect").length;
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    expect((await deliveriesOf(order.id))[0]).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: 302 });
    expect(app.hitsOf(s.path)).toHaveLength(1);
    expect(app.hitsOf("/destino-do-redirect")).toHaveLength(before);
  });

  test("resposta depois de 10 s é falha (tempo-limite injetado, sem espera real)", async () => {
    const s = await appStore();
    app.plan(s.path, ["hang"]);
    // O app recebeu e não respondeu: os 10 s "passam" agora.
    app.onHang = () => timeouts.fire();
    timeouts.requested.length = 0;
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    expect(APP_WEBHOOK_TIMEOUT_MS).toBe(10_000);
    expect(timeouts.requested).toEqual([10_000]);
    expect(app.hitsOf(s.path)).toHaveLength(1);
    const [d] = await deliveriesOf(order.id);
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: null });
    expect((await noticeJobs(d!.id)).filter((j) => j.status === "queued").map((j) => j.runAt)).toEqual([new Date(clock.now.getTime() + 60_000)]);
  });

  test("a primeira tentativa e as seis novas falham (1 min, 5 min, 30 min, 2 h, 6 h, 24 h): failed + alerta app_webhook_falhou, uma vez", async () => {
    expect([...APP_WEBHOOK_BACKOFF_SECONDS]).toEqual([60, 300, 1800, 7200, 21600, 86400]);
    const s = await appStore();
    app.plan(s.path, [500, 500, 500, 500, 500, 500, 503]);
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    const [d] = await deliveriesOf(order.id);
    for (const [i, wait] of APP_WEBHOOK_BACKOFF_SECONDS.entries()) {
      const row = (await deliveriesOf(order.id))[0]!;
      expect([i, row.status, row.attempts]).toEqual([i, "pending", i + 1]);
      const queued = (await noticeJobs(d!.id)).filter((j) => j.status === "queued");
      expect([i, queued.map((j) => j.runAt)]).toEqual([i, [new Date(clock.now.getTime() + wait * 1000)]]);
      expect(await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, s.storeId))).toHaveLength(0);
      advance(wait);
      await runNotices();
    }
    expect(app.hitsOf(s.path)).toHaveLength(7);
    expect((await deliveriesOf(order.id))[0]).toMatchObject({ status: "failed", attempts: 7, lastHttpStatus: 503, deliveredAt: null });
    expect((await noticeJobs(d!.id)).filter((j) => j.status === "queued")).toHaveLength(0);
    const alerts = await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, s.storeId));
    expect(alerts.map((a) => [a.kind, a.orderId, a.detail])).toEqual([["app_webhook_falhou", order.id, { httpStatus: 503 }]]);
    const sellerNotices = (await jobsOf(order.id, "notify_seller")).filter((j) => (j.payload as { reason?: string }).reason === "app_webhook_falhou");
    expect(sellerNotices.map((j) => j.payload)).toEqual([{ orderId: order.id, reason: "app_webhook_falhou", httpStatus: 503 }]);
    // O que o vendedor lê: no painel e no e-mail, com o pedido e o último código HTTP (nunca a resposta do app).
    const code = orderCode(order.publicId);
    const listed = await runAction(listAlerts, panelCall(s.storeId), {});
    expect(listed.alerts.map((a) => [a.kind, a.title])).toEqual([["app_webhook_falhou", `O app não confirmou o aviso (pedido #${code}) (HTTP 503)`]]);
    expect(listed.alerts[0]!.body).toContain("Reenviar aviso ao app");
    // As tentativas levam cerca de 32 h e o reenvio pode antecipar: o texto não promete prazo.
    for (const text of [listed.alerts[0]!.body, ...noticeFor("app_webhook_falhou", {}, code).paragraphs]) expect(text).not.toMatch(/2 dias|dois dias/i);
    const mail = noticeFor("app_webhook_falhou", { httpStatus: 503 }, code);
    expect(mail.subject).toBe(`O app não confirmou o aviso do pedido #${code}`);
    expect(mail.paragraphs.join(" ")).toContain("HTTP 503");
    // Nada mais sai sozinho depois de `failed`.
    advance(7 * 86_400);
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(7);
    expect(await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, s.storeId))).toHaveLength(1);
  });

  test("loja sem o webhook configurado: o aviso fica pendente e é entregue quando a conexão passa a existir", async () => {
    const s = await paidAppOrder({ connect: false });
    await runNotices();
    const [d] = await deliveriesOf(s.order.id);
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: null });
    expect(app.hitsOf(s.path)).toHaveLength(0);
    await connectAppWebhook(s.storeId, `${app.base}${s.path}`, SECRET);
    advance(60);
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(1);
    expect((await deliveriesOf(s.order.id))[0]).toMatchObject({ status: "delivered", attempts: 2, lastHttpStatus: 200 });
  });

  test("job repetido (at-least-once) de um aviso já entregue não envia de novo", async () => {
    const s = await paidAppOrder();
    await runNotices();
    const [d] = await deliveriesOf(s.order.id);
    await t.ownerDb.insert(job).values({ storeId: s.storeId, type: "notify_app", payload: { deliveryId: d!.id } });
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(1);
    expect((await deliveriesOf(s.order.id))[0]).toMatchObject({ status: "delivered", attempts: 1 });
  });

  test("payload inválido ou aviso de outra loja: job descartado sem enviar", async () => {
    const a = await paidAppOrder();
    const b = await appStore();
    const [d] = await deliveriesOf(a.order.id);
    await t.ownerDb.update(job).set({ status: "done" }).where(and(eq(job.type, "notify_app"), eq(job.storeId, a.storeId)));
    await t.ownerDb.insert(job).values([
      { storeId: b.storeId, type: "notify_app", payload: { deliveryId: d!.id } },
      { storeId: b.storeId, type: "notify_app", payload: { deliveryId: "não-é-uuid" } },
      { storeId: null, type: "notify_app", payload: { deliveryId: d!.id } },
    ]);
    await runNotices();
    expect(app.hitsOf(a.path)).toHaveLength(0);
    expect(app.hitsOf(b.path)).toHaveLength(0);
    expect((await deliveriesOf(a.order.id))[0]).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("destino do aviso (o funil nunca fala com host privado)", () => {
  const PUBLIC = "93.184.216.34";

  test("destino que resolve para 10.0.0.1, sem a variável de teste: falha sem conectar", async () => {
    const s = await appStore({ connect: false });
    await connectAppWebhook(s.storeId, "https://app.exemplo.test/hook", SECRET);
    const lookups: string[] = [];
    let fetched = 0;
    setAppWebhookForTests({
      allowLoopback: false,
      now: () => clock.now,
      lookup: async (host) => {
        lookups.push(host);
        return ["10.0.0.1"];
      },
      transport: async () => {
        fetched++;
        return 200;
      },
    });
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    expect(lookups).toEqual(["app.exemplo.test"]);
    expect(fetched).toBe(0);
    expect((await deliveriesOf(order.id))[0]).toMatchObject({ status: "pending", attempts: 1, lastHttpStatus: null });
  });

  test("a conexão é fixada no endereço conferido: o nome é resolvido uma vez, e Host leva o nome original", async () => {
    // `app.exemplo.test` não existe no DNS de verdade: a requisição só chega ao app falso porque a conexão usa o
    // endereço que a conferência aprovou (se o runtime resolvesse o nome de novo, falharia).
    const s = await appStore({ connect: false });
    const port = new URL(app.base).port;
    await connectAppWebhook(s.storeId, `http://app.exemplo.test:${port}${s.path}`, SECRET);
    const lookups: string[] = [];
    setAppWebhookForTests({
      allowLoopback: true,
      now: () => clock.now,
      lookup: async (host) => {
        lookups.push(host);
        return ["127.0.0.1"];
      },
    });
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    expect(lookups).toEqual(["app.exemplo.test"]);
    const hits = app.hitsOf(s.path);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers.host).toBe(`app.exemplo.test:${port}`);
    expect(hits[0]!.headers["funil-assinatura"]).toBe(signAppWebhook(SECRET, hits[0]!.body, Math.floor(clock.now.getTime() / 1000)));
    expect((await deliveriesOf(order.id))[0]).toMatchObject({ status: "delivered", attempts: 1, lastHttpStatus: 200 });
  });

  test("o endereço entregue à conexão é o conferido (nunca o nome): público passa, e nome que passa a resolver para IP privado é recusado sem conectar", async () => {
    const s = await appStore({ connect: false });
    await connectAppWebhook(s.storeId, "https://app.exemplo.test/hook", SECRET);
    const answers = [[PUBLIC, "93.184.216.35"], ["10.0.0.1"]];
    const seen: { host: string; address: string }[] = [];
    setAppWebhookForTests({
      allowLoopback: false,
      now: () => clock.now,
      lookup: async () => answers.shift() ?? [],
      transport: async ({ url, address }) => {
        seen.push({ host: url.hostname, address });
        return 500;
      },
    });
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    expect(seen).toEqual([{ host: "app.exemplo.test", address: PUBLIC }]);
    // Na nova tentativa o nome "mudou" para a rede interna: recusado antes de conectar.
    advance(60);
    await runNotices();
    expect(seen).toHaveLength(1);
    expect((await deliveriesOf(order.id))[0]).toMatchObject({ status: "pending", attempts: 2, lastHttpStatus: null });
  });

  test("sem a variável de teste: só https em endereço público; loopback, rede privada, credencial na URL e nome que não resolve são recusados", async () => {
    const answers: Record<string, string[]> = {
      "app.exemplo.test": [PUBLIC],
      "misto.exemplo.test": [PUBLIC, "192.168.0.10"],
      "interno.exemplo.test": ["10.0.0.1"],
      "metadados.exemplo.test": ["169.254.169.254"],
      "v6.exemplo.test": ["fd00::1"],
      localhost: ["127.0.0.1"],
    };
    setAppWebhookForTests({ allowLoopback: false, lookup: async (host) => answers[host] ?? [] });
    const cases: [string, boolean][] = [
      ["https://app.exemplo.test/hook", true],
      ["https://app.exemplo.test:8443/hook?x=1", true],
      [`https://${PUBLIC}/hook`, true],
      ["http://app.exemplo.test/hook", false],
      ["https://misto.exemplo.test/hook", false],
      ["https://interno.exemplo.test/hook", false],
      ["https://metadados.exemplo.test/latest/meta-data", false],
      ["https://v6.exemplo.test/hook", false],
      ["https://nao-resolve.exemplo.test/hook", false],
      ["https://localhost/hook", false],
      ["https://127.0.0.1/hook", false],
      ["https://[::1]/hook", false],
      ["https://[::ffff:10.0.0.1]/hook", false],
      ["https://10.0.0.1/hook", false],
      ["http://127.0.0.1:8080/hook", false],
      ["https://usuario:senha@app.exemplo.test/hook", false],
      ["ftp://app.exemplo.test/hook", false],
      ["não é url", false],
    ];
    for (const [url, ok] of cases) expect([url, await appWebhookDestinationAllowed(url)]).toEqual([url, ok]);
  });

  test("com a variável de teste: só o loopback é liberado (http ou https); rede privada continua recusada", async () => {
    const answers: Record<string, string[]> = { localhost: ["127.0.0.1"], "interno.exemplo.test": ["10.0.0.1"], "app.exemplo.test": [PUBLIC] };
    setAppWebhookForTests({ allowLoopback: true, lookup: async (host) => answers[host] ?? [] });
    const cases: [string, boolean][] = [
      ["http://127.0.0.1:4010/hook", true],
      ["http://localhost:4010/hook", true],
      ["https://[::1]/hook", true],
      ["https://app.exemplo.test/hook", true],
      ["http://app.exemplo.test/hook", false],
      ["http://interno.exemplo.test/hook", false],
      ["https://10.0.0.1/hook", false],
      ["http://169.254.169.254/latest", false],
    ];
    for (const [url, ok] of cases) expect([url, await appWebhookDestinationAllowed(url)]).toEqual([url, ok]);
  });
});

describe("ordem por pedido", () => {
  test("confirmação com 500 e reembolso em seguida: o reembolso espera; o app recebe confirmado antes de reembolsado, com sequência crescente", async () => {
    const s = await appStore();
    app.plan(s.path, [500]);
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    await transition(s.storeId, order.id, "refunded");
    await runNotices();
    // O reembolso não saiu: a confirmação ainda vai tentar de novo (em 60 s). Não contou tentativa.
    expect(app.hitsOf(s.path)).toHaveLength(1);
    const [confirmed, refunded] = await deliveriesOf(order.id);
    expect([confirmed!.eventType, confirmed!.sequence, confirmed!.status, confirmed!.attempts]).toEqual(["pagamento.confirmado", 1, "pending", 1]);
    expect([refunded!.eventType, refunded!.sequence, refunded!.status, refunded!.attempts]).toEqual(["pagamento.reembolsado", 2, "pending", 0]);
    // Volta a olhar logo depois da próxima tentativa da confirmação; um job só (o que esperou terminou).
    const waiting = (await noticeJobs(refunded!.id)).filter((j) => j.status === "queued");
    expect(waiting.map((j) => j.runAt)).toEqual([new Date(clock.now.getTime() + 61_000)]);
    advance(APP_WEBHOOK_ORDER_WAIT_SECONDS);
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(1);
    advance(60 - APP_WEBHOOK_ORDER_WAIT_SECONDS);
    await runNotices();
    const hits = app.hitsOf(s.path).map(bodyOf);
    expect(hits.map((b) => [b.tipo, b.dados.sequencia])).toEqual([
      ["pagamento.confirmado", 1],
      ["pagamento.confirmado", 1],
      ["pagamento.reembolsado", 2],
    ]);
    expect((await deliveriesOf(order.id)).map((d) => [d.status, d.attempts])).toEqual([
      ["delivered", 2],
      ["delivered", 1],
    ]);
    expect((await noticeJobs(refunded!.id)).filter((j) => j.status === "queued")).toHaveLength(0);
  });

  test("job do reembolso reivindicado antes do da confirmação (fila fora de ordem): ainda assim a confirmação chega primeiro", async () => {
    const s = await paidAppOrder();
    await transition(s.storeId, s.order.id, "refunded");
    const [confirmed] = await deliveriesOf(s.order.id);
    // A confirmação fica para depois na fila; o reembolso já está vencido.
    await t.ownerDb
      .update(job)
      .set({ runAt: new Date(clock.now.getTime() + 10_000) })
      .where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${confirmed!.id}`));
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(0);
    advance(10);
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => bodyOf(h).tipo)).toEqual(["pagamento.confirmado", "pagamento.reembolsado"]);
  });

  test("confirmação que falhou de vez não segura o reembolso para sempre; reenviada depois, chega com a sequência antiga", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await transition(s.storeId, order.id, "refunded");
    const [confirmed] = await deliveriesOf(order.id);
    await t.ownerDb.update(job).set({ status: "done" }).where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${confirmed!.id}`));
    await t.ownerDb.update(appWebhookDelivery).set({ status: "failed", attempts: 7 }).where(eq(appWebhookDelivery.id, confirmed!.id));
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => [bodyOf(h).tipo, bodyOf(h).dados.sequencia])).toEqual([["pagamento.reembolsado", 2]]);
  });
});

describe("a fila de avisos de um pedido não trava", () => {
  const allNoticeJobs = async (orderId: string) => {
    const ids = (await deliveriesOf(orderId)).map((d) => d.id);
    return (await t.ownerDb.select().from(job).where(eq(job.type, "notify_app"))).filter((j) => ids.includes((j.payload as { deliveryId?: string }).deliveryId ?? ""));
  };
  const failedAlerts = (storeId: string) => t.ownerDb.select().from(storeAlert).where(and(eq(storeAlert.storeId, storeId), eq(storeAlert.kind, "app_webhook_falhou")));

  test("anterior pendente sem job aberto (o job dele morreu na fila): vira failed com alerta, e o seguinte sai sem ficar voltando à fila", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    const [confirmed] = await deliveriesOf(order.id);
    // O job da confirmação falhou de vez na fila genérica (o handler lançou até esgotar): a linha ficou `pending`, órfã.
    await t.ownerDb
      .update(job)
      .set({ status: "failed", lastError: "falha na consulta ao banco" })
      .where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${confirmed!.id}`));
    await transition(s.storeId, order.id, "refunded");
    await runNotices();
    expect((await deliveriesOf(order.id)).map((d) => [d.eventType, d.status, d.attempts])).toEqual([
      ["pagamento.confirmado", "failed", 0],
      ["pagamento.reembolsado", "delivered", 1],
    ]);
    expect(app.hitsOf(s.path).map((h) => [bodyOf(h).tipo, bodyOf(h).dados.sequencia])).toEqual([["pagamento.reembolsado", 2]]);
    expect((await failedAlerts(s.storeId)).map((a) => a.orderId)).toEqual([order.id]);
    // Nenhum job novo: nem agora, nem depois de um dia de relógio.
    const before = await allNoticeJobs(order.id);
    expect(before.filter((j) => j.status === "queued" || j.status === "running")).toHaveLength(0);
    advance(86_400);
    await runNotices();
    expect(await allNoticeJobs(order.id)).toHaveLength(before.length);
    expect(await failedAlerts(s.storeId)).toHaveLength(1);
    // O vendedor ainda alcança a confirmação pelo botão.
    await runAction(resendAppNotice, panelCall(s.storeId), { orderId: order.id });
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => bodyOf(h).tipo)).toEqual(["pagamento.reembolsado", "pagamento.confirmado"]);
  });

  test("anterior com job na fila ou rodando continua sendo esperado (não é dado como falho)", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    const [confirmed] = await deliveriesOf(order.id);
    // O envio da confirmação está em andamento em outro worker.
    await t.ownerDb
      .update(job)
      .set({ status: "running", lockedAt: clock.now })
      .where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${confirmed!.id}`));
    await transition(s.storeId, order.id, "refunded");
    await runNotices();
    expect((await deliveriesOf(order.id)).map((d) => d.status)).toEqual(["pending", "pending"]);
    expect(app.hitsOf(s.path)).toHaveLength(0);
    expect(await failedAlerts(s.storeId)).toHaveLength(0);
    // O outro worker termina (aqui: o job volta a ficar disponível) e os dois saem, em ordem.
    await t.ownerDb
      .update(job)
      .set({ status: "queued", lockedAt: null })
      .where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${confirmed!.id}`));
    advance(APP_WEBHOOK_ORDER_WAIT_SECONDS);
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => bodyOf(h).tipo)).toEqual(["pagamento.confirmado", "pagamento.reembolsado"]);
  });

  test("aviso de um pedido que deixou de ser de app: failed com alerta (não fica pending sem job), e os seguintes não ficam em laço", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await transition(s.storeId, order.id, "refunded");
    // Dado inconsistente (não acontece pelo fluxo): o pedido perde a conta do app com avisos ainda na fila.
    await t.ownerDb.update(orders).set({ appAccount: null, appSessionId: null }).where(eq(orders.id, order.id));
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(0);
    expect((await deliveriesOf(order.id)).map((d) => [d.eventType, d.status])).toEqual([
      ["pagamento.confirmado", "failed"],
      ["pagamento.reembolsado", "failed"],
    ]);
    expect(await failedAlerts(s.storeId)).toHaveLength(2);
    const before = await allNoticeJobs(order.id);
    expect(before.filter((j) => j.status === "queued" || j.status === "running")).toHaveLength(0);
    advance(86_400);
    await runNotices();
    expect(await allNoticeJobs(order.id)).toHaveLength(before.length);
  });
});

describe("reembolso, contestação e estorno parcial", () => {
  const types = async (orderId: string) => (await deliveriesOf(orderId)).map((d) => d.eventType);

  test("reembolso: pagamento.reembolsado em vez de revoke_downloads", async () => {
    const s = await paidAppOrder();
    await transition(s.storeId, s.order.id, "refunded");
    expect(await types(s.order.id)).toEqual(["pagamento.confirmado", "pagamento.reembolsado"]);
    expect(await jobsOf(s.order.id, "revoke_downloads")).toHaveLength(0);
    await runNotices();
    const hits = app.hitsOf(s.path);
    expect(hits.map((h) => bodyOf(h).tipo)).toEqual(["pagamento.confirmado", "pagamento.reembolsado"]);
    expect(hits.map((h) => h.headers["funil-evento"])).toEqual([
      appEventId(s.order.id, "pagamento.confirmado", 0),
      appEventId(s.order.id, "pagamento.reembolsado", 0),
    ]);
    // Mesmos dados do pedido; só a sequência anda.
    expect(bodyOf(hits[1]!).dados).toEqual({ ...bodyOf(hits[0]!).dados, sequencia: 2 });
  });

  test("contestação, contestação revertida e nova contestação: contestado, restabelecido e contestado com outro id", async () => {
    const s = await paidAppOrder();
    await transition(s.storeId, s.order.id, "disputed");
    await transition(s.storeId, s.order.id, "paid");
    await transition(s.storeId, s.order.id, "disputed");
    const ds = await deliveriesOf(s.order.id);
    expect(ds.map((d) => [d.eventType, d.eventId])).toEqual(
      (
        [
          ["pagamento.confirmado", 0],
          ["pagamento.contestado", 0],
          ["pagamento.restabelecido", 0],
          ["pagamento.contestado", 1],
        ] as [AppEventType, number][]
      ).map(([type, n]) => [type, appEventId(s.order.id, type, n)]),
    );
    expect(ds.map((d) => d.sequence)).toEqual([1, 2, 3, 4]);
    expect(await jobsOf(s.order.id, "revoke_downloads")).toHaveLength(0);
    expect(await jobsOf(s.order.id, "restore_downloads")).toHaveLength(0);
    // Contestação revertida não é venda nova: Meta e aviso de venda saíram uma vez só.
    expect(await jobsOf(s.order.id, "meta_event")).toHaveLength(1);
    expect(await jobsOf(s.order.id, "notify_seller")).toHaveLength(1);
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => [bodyOf(h).tipo, bodyOf(h).dados.sequencia])).toEqual([
      ["pagamento.confirmado", 1],
      ["pagamento.contestado", 2],
      ["pagamento.restabelecido", 3],
      ["pagamento.contestado", 4],
    ]);
  });

  test("estorno parcial vindo do Asaas: pagamento.reembolso_parcial com valor_estornado_centavos; o mesmo valor não avisa de novo", async () => {
    const fake = createFakeAsaas();
    const shop = await seedAsaasStore(fake);
    const path = `/hook/${++seq}`;
    await connectAppWebhook(shop.storeId, `${app.base}${path}`, SECRET);
    const order = await newAsaasOrder(shop.storeId, shop.offerId);
    await startAsaasPix({ storeId: shop.storeId }, order.id);
    await makeAppOrder(shop.storeId, shop.offerId, order.id);
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    const hook = (event: string) =>
      handleAsaasWebhook(shop.storeId, new Headers({ "asaas-access-token": shop.webhookToken }), { event, payment: { id: pay!.providerId! } });
    fake.setStatus(pay!.providerId!, "RECEIVED");
    expect((await hook("PAYMENT_RECEIVED")).status).toBe(200);
    expect(await types(order.id)).toEqual(["pagamento.confirmado"]);

    fake.partialRefund(pay!.providerId!, 3);
    expect((await hook("PAYMENT_PARTIALLY_REFUNDED")).status).toBe(200);
    await hook("PAYMENT_UPDATED");
    const ds = await deliveriesOf(order.id);
    expect(ds.map((d) => [d.eventType, d.eventId])).toEqual([
      ["pagamento.confirmado", appEventId(order.id, "pagamento.confirmado", 0)],
      ["pagamento.reembolso_parcial", appEventId(order.id, "pagamento.reembolso_parcial", 0)],
    ]);
    expect((await t.ownerDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");
    await runNotices();
    const partial = app.hitsOf(path).map(bodyOf).find((b) => b.tipo === "pagamento.reembolso_parcial")!;
    expect(partial.dados).toMatchObject({ pedido: order.publicId, app_code: "creditos_50", valor_centavos: 990, valor_estornado_centavos: 300 });
    // O confirmado não leva o campo do estorno.
    expect(Object.keys(app.hitsOf(path).map(bodyOf).find((b) => b.tipo === "pagamento.confirmado")!.dados)).not.toContain("valor_estornado_centavos");

    // Outro parcial (soma ainda menor que o total): evento novo, com a soma devolvida até agora.
    fake.partialRefund(pay!.providerId!, 2);
    await hook("PAYMENT_PARTIALLY_REFUNDED");
    expect((await deliveriesOf(order.id)).map((d) => d.eventId)).toContain(appEventId(order.id, "pagamento.reembolso_parcial", 1));
    await runNotices();
    const partials = app.hitsOf(path).map(bodyOf).filter((b) => b.tipo === "pagamento.reembolso_parcial");
    expect(partials.map((b) => b.dados.valor_estornado_centavos)).toEqual([300, 500]);
  });

  test("300 e depois 500 antes de qualquer envio: dois eventos, com 300 e com 500 (o valor é o da ocorrência, não o do envio); a retentativa repete o valor", async () => {
    const fake = createFakeAsaas();
    const shop = await seedAsaasStore(fake);
    const path = `/hook/${++seq}`;
    await connectAppWebhook(shop.storeId, `${app.base}${path}`, SECRET);
    // confirmado ok; primeiro parcial falha uma vez e é reenviado.
    app.plan(path, [200, 500]);
    const order = await newAsaasOrder(shop.storeId, shop.offerId);
    await startAsaasPix({ storeId: shop.storeId }, order.id);
    await makeAppOrder(shop.storeId, shop.offerId, order.id);
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    const id = pay!.providerId!;
    const hook = (event: string) => handleAsaasWebhook(shop.storeId, new Headers({ "asaas-access-token": shop.webhookToken }), { event, payment: { id } });
    fake.setStatus(id, "RECEIVED");
    await hook("PAYMENT_RECEIVED");
    fake.partialRefund(id, 3);
    await hook("PAYMENT_PARTIALLY_REFUNDED");
    fake.partialRefund(id, 2);
    await hook("PAYMENT_PARTIALLY_REFUNDED");
    expect((await deliveriesOf(order.id)).map((d) => [d.eventType, d.sequence, d.refundedCents])).toEqual([
      ["pagamento.confirmado", 1, null],
      ["pagamento.reembolso_parcial", 2, 300],
      ["pagamento.reembolso_parcial", 3, 500],
    ]);
    await runNotices();
    advance(60);
    await runNotices();
    const partials = app.hitsOf(path).map(bodyOf).filter((b) => b.tipo === "pagamento.reembolso_parcial");
    expect(partials.map((b) => [b.dados.sequencia, b.dados.valor_estornado_centavos])).toEqual([
      [2, 300],
      [2, 300],
      [3, 500],
    ]);
  });

  test("reconsulta fora de ordem com valor menor (500 e depois 300) ou igual: nenhum evento novo", async () => {
    const fake = createFakeAsaas();
    const shop = await seedAsaasStore(fake);
    const order = await newAsaasOrder(shop.storeId, shop.offerId);
    await startAsaasPix({ storeId: shop.storeId }, order.id);
    await makeAppOrder(shop.storeId, shop.offerId, order.id);
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    const id = pay!.providerId!;
    const hook = () => handleAsaasWebhook(shop.storeId, new Headers({ "asaas-access-token": shop.webhookToken }), { event: "PAYMENT_UPDATED", payment: { id } });
    fake.setStatus(id, "RECEIVED");
    await hook();
    const refunds = (list: number[]) => void (fake.payments.get(id)!.refunds = list.map((value) => ({ status: "DONE", value })));
    const partialCents = async () => (await deliveriesOf(order.id)).filter((d) => d.eventType === "pagamento.reembolso_parcial").map((d) => d.refundedCents);
    refunds([5]);
    await hook();
    expect(await partialCents()).toEqual([500]);
    // A resposta antiga do Asaas (só os 3,00 do primeiro estorno) chega depois: ignorada.
    refunds([3]);
    await hook();
    expect(await partialCents()).toEqual([500]);
    // E a de novo com 5,00 (o valor "voltou" ao que já foi avisado): também não.
    refunds([5]);
    await hook();
    expect(await partialCents()).toEqual([500]);
    refunds([5, 1]);
    await hook();
    expect(await partialCents()).toEqual([500, 600]);
    // Direto no registro: menor ou igual ao já avisado não cria; sem valor é erro de quem chama.
    const direct = (cents?: number) =>
      withStore(shop.storeId, (tx) => enqueueAppNotice(tx, shop.storeId, order.id, "pagamento.reembolso_parcial", cents === undefined ? {} : { refundedCents: cents }));
    expect(await direct(600)).toBe(false);
    expect(await direct(1)).toBe(false);
    await expect(direct()).rejects.toThrow("reembolso parcial sem o valor devolvido");
    expect(await partialCents()).toEqual([500, 600]);
  });

  test("estorno parcial de pedido de download não avisa app nenhum (regressão)", async () => {
    const fake = createFakeAsaas();
    const shop = await seedAsaasStore(fake);
    const order = await newAsaasOrder(shop.storeId, shop.offerId);
    await startAsaasPix({ storeId: shop.storeId }, order.id);
    const [pay] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, order.id));
    const hook = (event: string) =>
      handleAsaasWebhook(shop.storeId, new Headers({ "asaas-access-token": shop.webhookToken }), { event, payment: { id: pay!.providerId! } });
    fake.setStatus(pay!.providerId!, "RECEIVED");
    await hook("PAYMENT_RECEIVED");
    fake.partialRefund(pay!.providerId!, 3);
    await hook("PAYMENT_PARTIALLY_REFUNDED");
    expect(await deliveriesOf(order.id)).toHaveLength(0);
    expect(await t.ownerDb.select().from(storeAlert).where(and(eq(storeAlert.storeId, shop.storeId), eq(storeAlert.kind, "estorno_parcial")))).toHaveLength(1);
  });
});

describe("apps.resendNotice (Reenviar aviso ao app)", () => {
  test("reenviar manda o mesmo Funil-Evento e o mesmo id, sem criar outro registro", async () => {
    const s = await paidAppOrder();
    await runNotices();
    advance(30);
    const out = await runAction(resendAppNotice, panelCall(s.storeId, "support"), { orderId: s.order.id });
    expect(out).toEqual({ orderId: s.order.id, queued: true });
    expect((await deliveriesOf(s.order.id))[0]).toMatchObject({ status: "pending", attempts: 0, deliveredAt: null });
    await runNotices();
    const hits = app.hitsOf(s.path);
    expect(hits).toHaveLength(2);
    expect(hits[1]!.headers["funil-evento"]).toBe(hits[0]!.headers["funil-evento"]);
    expect(bodyOf(hits[1]!)).toEqual(bodyOf(hits[0]!));
    expect(bodyOf(hits[1]!).id).toBe(appEventId(s.order.id, "pagamento.confirmado", 0));
    const ds = await deliveriesOf(s.order.id);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ status: "delivered", attempts: 1, lastHttpStatus: 200 });
  });

  test("com todos os avisos entregues, reenvia o último (o reembolso, não o pagamento)", async () => {
    const s = await paidAppOrder();
    await transition(s.storeId, s.order.id, "refunded");
    await runNotices();
    await runAction(resendAppNotice, panelCall(s.storeId), { orderId: s.order.id });
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => bodyOf(h).tipo)).toEqual(["pagamento.confirmado", "pagamento.reembolsado", "pagamento.reembolsado"]);
  });

  test("aviso que falhou de vez: reenviar recomeça as tentativas; com nova tentativa já na fila, ela é adiantada (sem job em dobro)", async () => {
    const s = await appStore();
    app.plan(s.path, [500, 500, 200]);
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    const [d] = await deliveriesOf(order.id);
    // Nova tentativa agendada para daqui a 60 s: o reenvio a adianta para agora.
    expect(await runAction(resendAppNotice, panelCall(s.storeId), { orderId: order.id })).toEqual({ orderId: order.id, queued: true });
    const open = (await noticeJobs(d!.id)).filter((j) => j.status === "queued");
    expect(open).toHaveLength(1);
    expect(open[0]!.runAt.getTime()).toBeLessThanOrEqual(clock.now.getTime());
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(2);
    // Marca como falho de vez (como depois da última tentativa) e reenvia.
    await t.ownerDb.update(job).set({ status: "done" }).where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${d!.id}`));
    await t.ownerDb.update(appWebhookDelivery).set({ status: "failed", attempts: 7 }).where(eq(appWebhookDelivery.id, d!.id));
    await runAction(resendAppNotice, panelCall(s.storeId), { orderId: order.id });
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(3);
    expect((await deliveriesOf(order.id))[0]).toMatchObject({ status: "delivered", attempts: 1, lastHttpStatus: 200 });
  });

  test("confirmação que falhou de vez e estorno parcial já entregue: reenviar manda a confirmação (o não entregue mais antigo), com o mesmo id", async () => {
    const s = await paidAppOrder();
    const [confirmed] = await deliveriesOf(s.order.id);
    // A confirmação esgotou as tentativas; o estorno parcial, criado depois, foi entregue.
    await t.ownerDb.update(job).set({ status: "done" }).where(and(eq(job.type, "notify_app"), sql`${job.payload}->>'deliveryId' = ${confirmed!.id}`));
    await t.ownerDb.update(appWebhookDelivery).set({ status: "failed", attempts: 7, lastHttpStatus: 500 }).where(eq(appWebhookDelivery.id, confirmed!.id));
    await withStore(s.storeId, (tx) => enqueueAppNotice(tx, s.storeId, s.order.id, "pagamento.reembolso_parcial", { refundedCents: 300 }));
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => bodyOf(h).tipo)).toEqual(["pagamento.reembolso_parcial"]);
    expect((await deliveriesOf(s.order.id)).map((d) => [d.eventType, d.status])).toEqual([
      ["pagamento.confirmado", "failed"],
      ["pagamento.reembolso_parcial", "delivered"],
    ]);
    // O painel mostra o aviso que falta (não o mais novo, entregue), e o botão o reenvia.
    const detail = await runAction(getOrderDetail, panelCall(s.storeId), { id: s.order.id });
    expect(detail.app!.notice).toMatchObject({ eventType: "pagamento.confirmado", status: "failed", attempts: 7, lastHttpStatus: 500 });
    expect(allowedOrderActions("support", detail).resendNotice).toBe(true);

    expect(await runAction(resendAppNotice, panelCall(s.storeId, "support"), { orderId: s.order.id })).toEqual({ orderId: s.order.id, queued: true });
    await runNotices();
    const hits = app.hitsOf(s.path);
    expect(hits.map((h) => [bodyOf(h).tipo, bodyOf(h).dados.sequencia, h.headers["funil-evento"]])).toEqual([
      ["pagamento.reembolso_parcial", 2, appEventId(s.order.id, "pagamento.reembolso_parcial", 0)],
      ["pagamento.confirmado", 1, appEventId(s.order.id, "pagamento.confirmado", 0)],
    ]);
    expect((await deliveriesOf(s.order.id)).map((d) => [d.eventType, d.status, d.attempts])).toEqual([
      ["pagamento.confirmado", "delivered", 1],
      ["pagamento.reembolso_parcial", "delivered", 1],
    ]);
    // Agora tudo entregue: o painel volta a mostrar o último, e reenviar manda o último.
    expect((await runAction(getOrderDetail, panelCall(s.storeId), { id: s.order.id })).app!.notice).toMatchObject({ eventType: "pagamento.reembolso_parcial", status: "delivered" });
    await runAction(resendAppNotice, panelCall(s.storeId), { orderId: s.order.id });
    await runNotices();
    expect(bodyOf(app.hitsOf(s.path)[2]!).tipo).toBe("pagamento.reembolso_parcial");
  });

  test("job de outra loja com o mesmo aviso no payload não é adiantado nem conta como envio em andamento", async () => {
    const s = await paidAppOrder();
    await runNotices();
    const other = await appStore();
    const [d] = await deliveriesOf(s.order.id);
    const far = new Date(clock.now.getTime() + 86_400_000);
    const [queued] = await t.ownerDb.insert(job).values({ storeId: other.storeId, type: "notify_app", payload: { deliveryId: d!.id }, runAt: far }).returning({ id: job.id });
    const [running] = await t.ownerDb
      .insert(job)
      .values({ storeId: other.storeId, type: "notify_app", payload: { deliveryId: d!.id }, status: "running", lockedAt: new Date(), runAt: far })
      .returning({ id: job.id });
    // Com o filtro de loja o job "rodando" da outra loja não bloqueia o reenvio, e o agendado dela não é tocado.
    expect(await runAction(resendAppNotice, panelCall(s.storeId), { orderId: s.order.id })).toEqual({ orderId: s.order.id, queued: true });
    const jobs = await noticeJobs(d!.id);
    expect(jobs.find((j) => j.id === queued!.id)).toMatchObject({ status: "queued", runAt: far, storeId: other.storeId });
    expect(jobs.find((j) => j.id === running!.id)).toMatchObject({ status: "running", storeId: other.storeId });
    const own = jobs.filter((j) => j.storeId === s.storeId && j.status === "queued");
    expect(own).toHaveLength(1);
    await runNotices();
    expect(app.hitsOf(s.path)).toHaveLength(2);
    await t.ownerDb.delete(job).where(eq(job.id, running!.id));
  });

  test("pedido sem aviso (download ou app ainda não pago) e pedido de outra loja: recusados; leitor não reenvia", async () => {
    const s = await appStore();
    const pending = await seedAppOrder(s.storeId, s.offer.id);
    const shop = await seedPanelStore();
    const download = await seedOrder(shop, { status: "paid" });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? e.code : "erro"));
    expect(await code(runAction(resendAppNotice, panelCall(s.storeId), { orderId: pending.id }))).toBe("conflict");
    expect(await code(runAction(resendAppNotice, panelCall(shop.storeId), { orderId: download.id }))).toBe("conflict");
    expect(await code(runAction(resendAppNotice, panelCall(shop.storeId), { orderId: pending.id }))).toBe("not_found");
    const paid = await paidAppOrder();
    expect(await code(runAction(resendAppNotice, panelCall(paid.storeId, "reader"), { orderId: paid.order.id }))).toBe("forbidden");
  });

  test("fora do MCP (o reenvio é do painel)", () => {
    expect(Object.keys(MCP_EXCLUDED)).toContain("apps.resendNotice");
  });
});

describe("painel do pedido de app", () => {
  test("detalhe traz a conta, o código do app e o estado do último aviso; os botões trocam o reenvio do e-mail pelo do aviso", async () => {
    const s = await appStore();
    app.plan(s.path, [500]);
    const order = await seedAppOrder(s.storeId, s.offer.id);
    await transition(s.storeId, order.id, "paid");
    await runNotices();
    const d = await runAction(getOrderDetail, panelCall(s.storeId), { id: order.id });
    expect(d.app).toMatchObject({
      account: order.account,
      appCode: "start_anual",
      notice: { eventType: "pagamento.confirmado", status: "pending", attempts: 1, maxAttempts: 7, lastHttpStatus: 500, deliveredAt: null },
    });
    expect(allowedOrderActions("owner", d)).toMatchObject({ resend: false, resendNotice: true, refund: true });
    expect(allowedOrderActions("support", d)).toMatchObject({ resend: false, resendNotice: true, refund: false });
    expect(allowedOrderActions("reader", d)).toMatchObject({ resend: false, resendNotice: false });
    await runAction(resendAppNotice, panelCall(s.storeId), { orderId: order.id });
    const again = await runAction(getOrderDetail, panelCall(s.storeId), { id: order.id });
    expect(again.timeline.map((e) => e.label)).toContain("Aviso ao app reenviado");
  });

  test("pedido de download: sem bloco de app e com os botões de sempre", async () => {
    const shop = await seedPanelStore();
    const order = await seedOrder(shop, { status: "paid" });
    const d = await runAction(getOrderDetail, panelCall(shop.storeId), { id: order.id });
    expect(d.app).toBeNull();
    expect(allowedOrderActions("owner", d)).toMatchObject({ resend: true, resendNotice: false });
  });

  test("“Reenviar acesso” (e-mail com links) não vale para pedido de app", async () => {
    const s = await paidAppOrder();
    const e = await runAction(resendOrder, panelCall(s.storeId), { orderId: s.order.id }).catch((err: unknown) => err);
    expect((e as ActionError).code).toBe("conflict");
    expect(await jobsOf(s.order.id, "deliver_order")).toHaveLength(0);
  });
});

describe("cartão aprovado pelo serviço de cartão (papel `card` do banco, que não grava em app_webhook_delivery)", () => {
  afterAll(async () => {
    await setDbForTests({ appUrl: t.appUrl, ownerUrl: t.url });
  });

  test("o pedido fica pago sem permissão nova para o card: sai deliver_order, e o worker do app o troca pelo aviso (sem e-mail ao comprador)", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id, { method: "card_asaas" });
    await setDbForTests({ appUrl: t.cardUrl, ownerUrl: t.url });
    try {
      expect(await transition(s.storeId, order.id, "paid")).toEqual({ changed: true });
    } finally {
      await setDbForTests({ appUrl: t.appUrl, ownerUrl: t.url });
    }
    expect((await t.ownerDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");
    expect(await deliveriesOf(order.id)).toHaveLength(0);
    expect((await jobsOf(order.id, "deliver_order")).map((j) => j.status)).toEqual(["queued"]);

    const run = () => runDueJobs({ deliver_order: getHandlers().deliver_order! }, 50, () => clock.now, { types: ["deliver_order"] });
    await run();
    const ds = await deliveriesOf(order.id);
    expect(ds.map((d) => [d.eventType, d.eventId, d.status])).toEqual([["pagamento.confirmado", appEventId(order.id, "pagamento.confirmado", 0), "pending"]]);
    expect(await noticeJobs(ds[0]!.id)).toHaveLength(1);
    expect(await t.ownerDb.select().from(emailLog).where(eq(emailLog.orderId, order.id))).toHaveLength(0);
    // deliver_order repetido (at-least-once): continua um aviso só.
    await t.ownerDb.insert(job).values({ storeId: s.storeId, type: "deliver_order", payload: { orderId: order.id } });
    await run();
    expect(await deliveriesOf(order.id)).toHaveLength(1);
    expect(await noticeJobs(ds[0]!.id)).toHaveLength(1);
    await runNotices();
    expect(app.hitsOf(s.path).map((h) => bodyOf(h).tipo)).toEqual(["pagamento.confirmado"]);
    expect(bodyOf(app.hitsOf(s.path)[0]!).dados.metodo).toBe("cartao");
  });

  const runDeliveries = () => runDueJobs({ deliver_order: getHandlers().deliver_order! }, 50, () => clock.now, { types: ["deliver_order"] });
  const asCard = async <T>(fn: () => Promise<T>): Promise<T> => {
    await setDbForTests({ appUrl: t.cardUrl, ownerUrl: t.url });
    try {
      return await fn();
    } finally {
      await setDbForTests({ appUrl: t.appUrl, ownerUrl: t.url });
    }
  };

  test("cartão aprovado e reembolso antes do worker pegar o deliver_order: o app recebe confirmado e depois reembolsado", async () => {
    const s = await appStore();
    const order = await seedAppOrder(s.storeId, s.offer.id, { method: "card_asaas" });
    await asCard(() => transition(s.storeId, order.id, "paid"));
    expect(await deliveriesOf(order.id)).toHaveLength(0);
    const [paid] = await t.ownerDb.select().from(orders).where(eq(orders.id, order.id));
    // O reembolso (papel `app`) chega antes do worker: ele mesmo garante a confirmação, na frente.
    await transition(s.storeId, order.id, "refunded");
    expect((await deliveriesOf(order.id)).map((d) => [d.eventType, d.sequence])).toEqual([
      ["pagamento.confirmado", 1],
      ["pagamento.reembolsado", 2],
    ]);
    // O deliver_order atrasado não cria outra confirmação nem manda e-mail.
    await runDeliveries();
    expect(await deliveriesOf(order.id)).toHaveLength(2);
    expect(await t.ownerDb.select().from(emailLog).where(eq(emailLog.orderId, order.id))).toHaveLength(0);
    await runNotices();
    const hits = app.hitsOf(s.path).map(bodyOf);
    expect(hits.map((b) => [b.tipo, b.dados.sequencia])).toEqual([
      ["pagamento.confirmado", 1],
      ["pagamento.reembolsado", 2],
    ]);
    // A confirmação leva o instante do pagamento, mesmo criada depois do reembolso.
    expect(hits[0]!.dados.pago_em).toBe(paid!.paidAt!.toISOString());
  });

  test("deliver_order de um pedido de app que já não está pago (reembolsado ou contestado) ainda cria a confirmação; nunca pago, não", async () => {
    const s = await appStore();
    for (const status of ["refunded", "disputed"] as const) {
      const order = await seedAppOrder(s.storeId, s.offer.id, { method: "card_asaas" });
      await asCard(() => transition(s.storeId, order.id, "paid"));
      // Estado mudado por fora da máquina (o pior caso: nada garantiu a confirmação antes do worker).
      await t.ownerDb.update(orders).set({ status }).where(eq(orders.id, order.id));
      await runDeliveries();
      expect([status, (await deliveriesOf(order.id)).map((d) => [d.eventType, d.sequence, d.status])]).toEqual([status, [["pagamento.confirmado", 1, "pending"]]]);
    }
    const never = await seedAppOrder(s.storeId, s.offer.id, { method: "card_asaas", status: "expired" });
    await t.ownerDb.insert(job).values({ storeId: s.storeId, type: "deliver_order", payload: { orderId: never.id } });
    await runDeliveries();
    expect(await deliveriesOf(never.id)).toHaveLength(0);
  });
});
