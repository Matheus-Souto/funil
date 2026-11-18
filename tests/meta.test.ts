import { VALID_PDF } from "./pdf-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ActionError, runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer, getPublicOffer, updateOffer } from "@/lib/catalog/offers";
import { createProduct } from "@/lib/catalog/products";
import { checkoutStart, getOrderPublic } from "@/lib/checkout";
import { withStore } from "@/lib/db/client";
import { auditLog, conversion, integration, job, orders } from "@/lib/db/schema";
import { parseEnv } from "@/lib/env";
import type { Job } from "@/lib/jobs";
import { getHandlers } from "@/lib/jobs/handlers";
import { createOrder } from "@/lib/orders/create";
import { releaseOrder, savePixManual } from "@/lib/payments/manual";
import { refundOrder } from "@/lib/payments/refund";
import { META_GRAPH_VERSION, buildMetaUserData, purchaseEventId, saveMeta, setMetaFetchForTests, testMeta } from "@/lib/tracking/meta";
import { createTestDb, seedStore, type TestDb } from "./db";
import { createFakeMeta, type FakeMeta } from "./fakes/meta";

let t: TestDb;
let meta: FakeMeta;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setMetaFetchForTests();
  await t.drop();
});
const freshMeta = () => {
  meta = createFakeMeta();
  setMetaFetchForTests(meta.fetch);
};
freshMeta();
afterEach(freshMeta);

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const panel = (storeId: string, actor: Actor = owner) => ({ storeId, actor, origin: "panel" as const });
const pub = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });
const systemCtx = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "system" }, origin: "system", tx });
const PIXEL = "1234567890123";
const fail = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("esperava erro");
    },
    (e: unknown) => e as ActionError,
  );

async function seedShop(opts: { meta?: boolean; testEventCode?: string } = {}) {
  const { storeId } = await seedStore("Maná Kids");
  await runAction(savePixManual, panel(storeId), { key: "contato@manakids.com.br", name: "Mana Kids", city: "Sao Paulo" });
  if (opts.meta !== false) {
    await runAction(saveMeta, panel(storeId), { pixelId: PIXEL, accessToken: meta.token, ...(opts.testEventCode ? { testEventCode: opts.testEventCode } : {}) });
  }
  const main = await runAction(createProduct, panel(storeId), { name: "Maná básica", fileName: "a.pdf", file: VALID_PDF });
  const bump = await runAction(createProduct, panel(storeId), { name: "Maná completa", fileName: "b.pdf", file: VALID_PDF });
  const offer = await runAction(createOffer, panel(storeId), {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Maná bíblico para crianças",
    productId: main.id,
    priceCents: 990,
    methods: ["pix"],
    pixMode: "manual",
    bumpProductId: bump.id,
    bumpPriceCents: 1710,
    bumpLabel: "Quero a completa",
  });
  return { storeId, offerId: offer.id, slug: offer.slug, mainId: main.id, bumpId: bump.id };
}
type Shop = Awaited<ReturnType<typeof seedShop>>;

async function paidOrder(shop: Shop) {
  const o = await withStore(shop.storeId, (tx) =>
    createOrder(systemCtx(shop.storeId, tx), {
      offerId: shop.offerId,
      withBump: true,
      method: "pix_manual",
      customer: { name: "Ana Maria Sá", email: "ana@x.com", phone: "11987654321" },
      touch: { first: null, last: { utm_source: "ig" } },
      ref: "joao",
      fbc: "fb.1.1700000000000.abc",
      fbp: "fb.1.1700000000000.999",
      clientIp: "203.0.113.7",
      userAgent: "Mozilla/5.0 teste",
    }),
  );
  await runAction(releaseOrder, panel(shop.storeId), { orderId: o.id });
  const [row] = await withStore(shop.storeId, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
  return row!;
}

const metaJobs = (orderId: string) =>
  t.ownerDb
    .select()
    .from(job)
    .where(and(eq(job.type, "meta_event"), sql`${job.payload}->>'orderId' = ${orderId}`));

async function runMetaJobs(orderId: string, signal = new AbortController().signal): Promise<Job[]> {
  const handler = getHandlers().meta_event!;
  const rows = await metaJobs(orderId);
  for (const j of rows) await handler(j, signal);
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------

describe("buildMetaUserData", () => {
  test("e-mail ' Ana@X.com ' vira o SHA-256 de 'ana@x.com'; telefone com 55; nomes minúsculos; IP e UA sem hash", () => {
    const u = buildMetaUserData({
      email: " Ana@X.com ",
      phone: "(11) 98765-4321",
      name: "  Ana Maria SÁ ",
      ip: "203.0.113.7",
      ua: "Mozilla/5.0",
      fbc: "fb.1.1.abc",
      fbp: "fb.1.2.3",
      externalId: "cliente-1",
    });
    expect(u.em).toEqual([sha("ana@x.com")]);
    expect(u.ph).toEqual([sha("5511987654321")]);
    expect(u.fn).toEqual([sha("ana")]);
    expect(u.ln).toEqual([sha("sá")]);
    expect(u.country).toEqual([sha("br")]);
    expect(u.external_id).toEqual([sha("cliente-1")]);
    expect(u.client_ip_address).toBe("203.0.113.7");
    expect(u.client_user_agent).toBe("Mozilla/5.0");
    expect(u.fbc).toBe("fb.1.1.abc");
    expect(u.fbp).toBe("fb.1.2.3");
  });

  test("telefone já com 55, nome de uma palavra, IP desconhecido e sem fbc/fbp", () => {
    const u = buildMetaUserData({ email: "a@b.co", phone: "+55 11 98765-4321", name: "Ana", ip: "unknown", ua: "" });
    expect(u.ph).toEqual([sha("5511987654321")]);
    expect(u.fn).toEqual([sha("ana")]);
    expect(u.ln).toBeUndefined();
    expect(u.client_ip_address).toBeUndefined();
    expect(u.client_user_agent).toBeUndefined();
    expect("fbc" in u).toBe(false);
    expect("fbp" in u).toBe(false);
  });
});

describe("connections.saveMeta", () => {
  test("testa o token no Meta (GET no pixel) e guarda o token selado; auditoria sem o token", async () => {
    const shop = await seedShop({ meta: false });
    const out = await runAction(saveMeta, panel(shop.storeId), { pixelId: PIXEL, accessToken: meta.token, testEventCode: "TEST123" });
    expect(out).toEqual({ pixelId: PIXEL, testEventCode: "TEST123", hasAccessToken: true });
    expect(meta.requests).toEqual([{ method: "GET", path: `/${META_GRAPH_VERSION}/${PIXEL}` }]);
    const [row] = await t.ownerDb.select().from(integration).where(and(eq(integration.storeId, shop.storeId), eq(integration.kind, "meta")));
    expect(row!.config).toEqual({ pixelId: PIXEL, testEventCode: "TEST123" });
    expect(row!.secret).not.toContain(meta.token);
    const audits = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, shop.storeId), eq(auditLog.action, "connections.saveMeta")));
    expect(JSON.stringify(audits)).not.toContain(meta.token);
  });

  test("token recusado pelo Meta: provider_error com o código, nada salvo; Pixel ID só com números", async () => {
    const shop = await seedShop({ meta: false });
    const e = await fail(runAction(saveMeta, panel(shop.storeId), { pixelId: PIXEL, accessToken: "token-errado-123" }));
    expect(e.code).toBe("provider_error");
    expect(e.message).toContain("190");
    expect(e.message).not.toContain("token-errado-123");
    const rows = await t.ownerDb.select().from(integration).where(and(eq(integration.storeId, shop.storeId), eq(integration.kind, "meta")));
    expect(rows).toHaveLength(0);
    expect((await fail(runAction(saveMeta, panel(shop.storeId), { pixelId: "12ab/../x", accessToken: meta.token }))).code).toBe("invalid_input");
  });

  test("sensível: MCP/IA pedem aprovação; tráfego e suporte não podem", async () => {
    const shop = await seedShop({ meta: false });
    const input = { pixelId: PIXEL, accessToken: meta.token };
    expect((await fail(runAction(saveMeta, { ...panel(shop.storeId), origin: "mcp" }, input))).code).toBe("approval_required");
    expect((await fail(runAction(saveMeta, panel(shop.storeId, { kind: "user", userId: "u3", role: "traffic" }), input))).code).toBe("forbidden");
    expect(meta.requests).toHaveLength(0);
  });

  test("sem token novo: mantém o guardado (e o valida de novo para o pixel informado)", async () => {
    const shop = await seedShop();
    meta.requests.length = 0;
    const out = await runAction(saveMeta, panel(shop.storeId), { pixelId: "999999999" });
    expect(out.hasAccessToken).toBe(true);
    expect(meta.requests).toEqual([{ method: "GET", path: `/${META_GRAPH_VERSION}/999999999` }]);
  });
});

test("connections.testMeta: sem conexão conflict; com conexão valida o token guardado; token revogado provider_error", async () => {
  const none = await seedShop({ meta: false });
  expect((await fail(runAction(testMeta, panel(none.storeId), {}))).code).toBe("conflict");
  const shop = await seedShop();
  meta.requests.length = 0;
  expect(await runAction(testMeta, panel(shop.storeId), {})).toEqual({ ok: true });
  expect(meta.requests).toEqual([{ method: "GET", path: `/${META_GRAPH_VERSION}/${PIXEL}` }]);
  meta.failNext(1, 400, 190);
  expect((await fail(runAction(testMeta, panel(shop.storeId), {}))).code).toBe("provider_error");
});

describe("meta_event Purchase (API de Conversões)", () => {
  test("pedido de 2700 com bump: event_id purchase:<publicId>, value 27, dados em hash; repetir o job não reenvia", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    expect(o.totalCents).toBe(2700);
    const jobs = await runMetaJobs(o.id);
    expect(jobs.map((j) => j.payload)).toEqual([{ event: "Purchase", orderId: o.id }]);
    expect(meta.events).toHaveLength(1);
    const { pixelId, version, event: ev, testEventCode } = meta.events[0]!;
    expect(version).toBe(META_GRAPH_VERSION);
    expect(pixelId).toBe(PIXEL);
    expect(testEventCode).toBeUndefined();
    expect(ev.event_name).toBe("Purchase");
    expect(ev.event_id).toBe(purchaseEventId(o.publicId));
    expect(ev.event_id).toBe(`purchase:${o.publicId}`);
    expect(ev.event_time).toBe(Math.floor(o.paidAt!.getTime() / 1000));
    expect(ev.action_source).toBe("website");
    expect(ev.event_source_url).toBe(`http://localhost:3000/o/${o.publicId}`);
    expect(ev.custom_data).toEqual({ currency: "BRL", value: 27, content_ids: [shop.mainId, shop.bumpId], content_type: "product", order_id: o.publicId });
    const ud = ev.user_data!;
    expect(ud.em).toEqual([sha("ana@x.com")]);
    expect(ud.ph).toEqual([sha("5511987654321")]);
    expect(ud.client_ip_address).toBe("203.0.113.7");
    expect(ud.client_user_agent).toBe("Mozilla/5.0 teste");
    expect(ud.fbc).toBe("fb.1.1700000000000.abc");
    expect(ud.external_id).toEqual([sha(o.customerId)]);
    expect(JSON.stringify(ev)).not.toContain("ana@x.com");
    expect(JSON.stringify(ev)).not.toContain(o.id); // id interno do pedido nunca vai ao Meta

    // at-least-once: o mesmo job de novo (ou um duplicado) não manda outra vez.
    await runMetaJobs(o.id);
    expect(meta.events).toHaveLength(1);
    const marks = await withStore(shop.storeId, (tx) => tx.select().from(conversion).where(eq(conversion.orderId, o.id)));
    expect(marks.map((m) => [m.event, m.eventId])).toEqual([["Purchase", `purchase:${o.publicId}`]]);
  });

  test("sem conexão Meta o job termina sem erro e sem chamar o Meta", async () => {
    const shop = await seedShop({ meta: false });
    const o = await paidOrder(shop);
    const jobs = await runMetaJobs(o.id);
    expect(jobs).toHaveLength(1);
    expect(meta.requests).toHaveLength(0);
  });

  test("pixel da oferta sobrescreve o da loja; test_event_code vai junto quando configurado", async () => {
    const shop = await seedShop({ testEventCode: "TEST999" });
    await runAction(updateOffer, panel(shop.storeId), { id: shop.offerId, pixelId: "5550001112" });
    const o = await paidOrder(shop);
    await runMetaJobs(o.id);
    expect(meta.events.map((e) => [e.pixelId, e.testEventCode])).toEqual([["5550001112", "TEST999"]]);
  });

  test("erro do Meta: job falha só com o código (sem token), sem marca; a nova tentativa envia", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    meta.failNext(1, 400, 190);
    const err = await runMetaJobs(o.id).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("190");
    expect(err!.message).not.toContain(meta.token);
    expect(await withStore(shop.storeId, (tx) => tx.select().from(conversion).where(eq(conversion.orderId, o.id)))).toHaveLength(0);
    await runMetaJobs(o.id);
    expect(meta.events).toHaveLength(1);
  });

  test("sinal abortado (tempo-limite do worker): não envia nem marca", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const ctrl = new AbortController();
    ctrl.abort(new Error("tempo-limite"));
    await expect(runMetaJobs(o.id, ctrl.signal)).rejects.toThrow();
    expect(meta.events).toHaveLength(0);
    expect(await withStore(shop.storeId, (tx) => tx.select().from(conversion).where(eq(conversion.orderId, o.id)))).toHaveLength(0);
  });

  test("reembolso não vai para o Meta", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    await runAction(refundOrder, panel(shop.storeId), { orderId: o.id });
    const jobs = await metaJobs(o.id);
    expect(jobs.map((j) => (j.payload as { event: string }).event)).toEqual(["Purchase"]);
  });
});

describe("meta_event InitiateCheckout (checkout.start)", () => {
  const start = (slug: string, eventId?: string) => ({
    slug,
    withBump: false,
    method: "pix",
    customer: { name: "Ana Maria Sá", email: `c-${randomUUID()}@x.com`, phone: "11987654321" },
    touch: { first: null, last: null },
    ...(eventId === undefined ? {} : { eventId }),
    clientIp: "203.0.113.9",
    userAgent: "Mozilla/5.0 teste",
  });

  test("pedido criado enfileira InitiateCheckout com o eventId da página; o job envia esse event_id", async () => {
    const shop = await seedShop();
    const eventId = randomUUID();
    const r = await runAction(checkoutStart, pub(shop.storeId), start(shop.slug, eventId));
    const jobs = await metaJobs(r.orderId);
    expect(jobs.map((j) => j.payload)).toEqual([{ event: "InitiateCheckout", orderId: r.orderId, eventId }]);
    await runMetaJobs(r.orderId);
    expect(meta.events).toHaveLength(1);
    const ev = meta.events[0]!.event;
    expect(ev.event_name).toBe("InitiateCheckout");
    expect(ev.event_id).toBe(eventId);
    expect(ev.event_source_url).toBe(`http://localhost:3000/c/${shop.slug}`);
    expect(ev.custom_data).toEqual({ currency: "BRL", value: 9.9, content_ids: [shop.mainId], content_type: "product" });
  });

  test("sem conexão Meta ou sem eventId: nada enfileirado; eventId fora do formato: invalid_input", async () => {
    const off = await seedShop({ meta: false });
    const a = await runAction(checkoutStart, pub(off.storeId), start(off.slug, randomUUID()));
    expect(await metaJobs(a.orderId)).toHaveLength(0);
    const on = await seedShop();
    const b = await runAction(checkoutStart, pub(on.storeId), start(on.slug));
    expect(await metaJobs(b.orderId)).toHaveLength(0);
    expect((await fail(runAction(checkoutStart, pub(on.storeId), start(on.slug, "curto")))).code).toBe("invalid_input");
    expect((await fail(runAction(checkoutStart, pub(on.storeId), start(on.slug, "purchase:abcdefghijklmnopq")))).code).toBe("invalid_input");
    // 16-64 caracteres url-safe também valem
    const c = await runAction(checkoutStart, pub(on.storeId), start(on.slug, "abcdefghijklmnop_-12"));
    expect(await metaJobs(c.orderId)).toHaveLength(1);
  });
});

describe("pixel nas páginas do comprador", () => {
  test("oferta pública e página do pedido expõem o Pixel ID (oferta sobrescreve a loja); sem Meta: null", async () => {
    const shop = await seedShop();
    expect((await runAction(getPublicOffer, pub(shop.storeId), { slug: shop.slug })).pixelId).toBe(PIXEL);
    const o = await paidOrder(shop);
    expect((await getOrderPublic(shop.storeId, o.publicId))!.pixelId).toBe(PIXEL);
    await runAction(updateOffer, panel(shop.storeId), { id: shop.offerId, pixelId: "5550001112" });
    expect((await runAction(getPublicOffer, pub(shop.storeId), { slug: shop.slug })).pixelId).toBe("5550001112");
    const none = await seedShop({ meta: false });
    expect((await runAction(getPublicOffer, pub(none.storeId), { slug: none.slug })).pixelId).toBeNull();
  });
});

test("META_GRAPH_BASE_URL só com BASE_URL e destino em loopback", () => {
  const base = { BASE_URL: "http://127.0.0.1:3000", DATABASE_URL: "x", OWNER_DATABASE_URL: "x", SECRET: "s".repeat(40) };
  expect(parseEnv({ ...base, META_GRAPH_BASE_URL: "http://127.0.0.1:4010/meta" }).META_GRAPH_BASE_URL).toBe("http://127.0.0.1:4010/meta");
  expect(() => parseEnv({ ...base, META_GRAPH_BASE_URL: "https://evil.example" })).toThrow(/META_GRAPH_BASE_URL/);
  expect(() => parseEnv({ ...base, BASE_URL: "https://loja.example.com", META_GRAPH_BASE_URL: "http://127.0.0.1:4010" })).toThrow(/META_GRAPH_BASE_URL/);
});
