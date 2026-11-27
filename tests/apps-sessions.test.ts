// Sessão de pagamento do app (src/lib/apps/sessions.ts, Task 7 do plano de cobrança de apps): `apps.createPayment` cria
// a sessão (URL sem dado pessoal), `checkout.start` com `sessionId` usa nome, e-mail e conta da sessão e recusa sessão
// vencida, de outra oferta/loja ou já paga (`SESSION_INVALID`); a página lê a sessão por `checkout.appSession`; a captura
// de contato não guarda nada na oferta de app; e a retenção (`sweep_app_trials`) limpa as sessões vencidas.
// Nenhum literal com o formato do token: tudo montado em tempo de execução.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import {
  APP_OFFER_NOT_FOUND_MESSAGE,
  SESSION_INVALID_MESSAGE,
  SESSION_RETENTION_DAYS,
  SESSION_TTL_MS,
  checkoutAppSession,
  createPayment,
  loadCheckoutSession,
} from "@/lib/apps/sessions";
import { registerTrial, sweepAppTrialsJob } from "@/lib/apps/trials";
import { createOffer } from "@/lib/catalog/offers";
import { ASAAS_LIMITS, checkoutStart, getOrderPublic, regenerateOrderPix, renewCardTicket, startCheckout } from "@/lib/checkout";
import { notifyAppJob } from "@/lib/apps/webhook";
import { enqueue } from "@/lib/jobs";
import { payWithCard } from "@/lib/payments/asaas/card";
import { sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { appCheckoutSession, auditLog, checkoutLead, customer, integration, mcpToken, offer, orders, store } from "@/lib/db/schema";
import type { Job } from "@/lib/jobs";
import { checkoutSaveLead } from "@/lib/leads/capture";
import { MCP_EXCLUDED } from "@/lib/mcp/tools";
import { mintMcpToken } from "@/lib/mcp/tokens";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { recoveryEmailHash } from "@/lib/recovery/rules";
import { POST } from "@/app/api/integracao/v1/pagamentos/route";
import { appGate } from "@/app/c/[slug]/app-gate";
import { submitCoupon } from "@/app/c/[slug]/coupon-logic";
import { enqueueAppNotice } from "@/lib/apps/events";
import { PRICE_CHANGED_MESSAGE } from "@/lib/coupons/messages";
import { appWebhookDelivery, job, payment as paymentRow, storeAlert } from "@/lib/db/schema";
import { createOrder } from "@/lib/orders/create";
import { transitionOrder } from "@/lib/orders/state";
import { buyerReferrerPolicy, proxy } from "@/proxy";
import { createTestDb, seedProduct, seedStore, type TestDb } from "./db";
import { createFakeAsaas } from "./fakes/asaas";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setAsaasFetchForTests();
  await t.drop();
});
afterEach(() => setAsaasFetchForTests());

const owner: Actor = { kind: "user", userId: randomUUID(), role: "owner" };
const api = (storeId: string) => ({ storeId, actor: { kind: "token", tokenId: randomUUID(), role: "integration" } as Actor, origin: "api" as const });
const pub = (storeId: string, now?: Date) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const, ...(now ? { server: { now } } : {}) });

const CPF = "52998224725";
const PRICES: Record<string, number> = { "start-anual": 49_700, "plus-anual": 99_700, guia: 990 };
const DOMAIN = "checkout.peticionaaqui.com.br";
let ipSeq = 0;
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

/** Loja do app com domínio próprio, Asaas (fake) e duas ofertas de app; uma oferta de download para comparar. */
async function seedAppStore(name = "PeticionaAqui") {
  const fake = createFakeAsaas();
  const { storeId } = await seedStore(name);
  const domain = `${randomUUID().slice(0, 8)}.${DOMAIN}`;
  await t.ownerDb.update(store).set({ domain }).where(eq(store.id, storeId));
  const call = { storeId, actor: owner, origin: "panel" as const };
  setAsaasFetchForTests(fake.fetch);
  await runAction(saveAsaas, call, { env: "sandbox", apiKey: fake.apiKey });
  const app = (slug: string, appCode: string, priceCents: number) =>
    runAction(createOffer, call, { slug, name: `Plano ${slug}`, delivery: "app", appCode, productIds: [], priceCents, methods: ["pix", "card"], pixMode: "asaas" });
  const start = await app("start-anual", "start_anual", 49_700);
  const plus = await app("plus-anual", "plus_anual", 99_700);
  const main = await seedProduct(storeId, "Guia");
  const download = await runAction(createOffer, call, { slug: "guia", name: "Guia", productIds: [main.id], priceCents: 990, methods: ["pix"], pixMode: "asaas" });
  return { storeId, domain, start, plus, download, fake };
}

const payment = (over: Record<string, unknown> = {}) => ({
  conta: "tenant-77",
  oferta: "start-anual",
  email: "Ana.Souza@Escritorio.com.br",
  nome: "Ana Souza",
  ...over,
});

const sessionIdOf = (url: string) => new URL(url).searchParams.get("s")!;
const sessionsOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(appCheckoutSession));
const ordersOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(orders));

/** Entrada do `checkout.start` pela página da sessão: sem nome nem e-mail (vêm da sessão). */
function sessionStart(slug: string, sessionId: string, over: Record<string, unknown> & { customer?: Record<string, unknown> } = {}) {
  const { customer: c, ...rest } = over;
  return {
    slug,
    sessionId,
    withBump: false,
    method: "pix",
    customer: { phone: "(11) 98765-4321", cpf: CPF, ...c },
    // Todo pedido de app manda o total que a tela mostrou (o preço da oferta).
    expectedTotalCents: PRICES[slug] ?? 990,
    touch: { first: null, last: { utm_source: "navegador" } },
    eventId: randomUUID(),
    clientIp: nextIp(),
    userAgent: "bun-test",
    ...rest,
  };
}

const failOf = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("esperava erro");
    },
    (e: unknown) => e as ActionError,
  );

describe("apps.createPayment", () => {
  test("cria a sessão: URL da loja sem e-mail, nome nem conta; expira em 60 min; auditoria sem dado pessoal", async () => {
    const s = await seedAppStore();
    const before = Date.now();
    const r = await runAction(createPayment, api(s.storeId), payment({ telefone: "(11) 98765-4321", origem: { utm_campaign: "black", fbclid: "IwAR77" } }));
    expect(r.criado).toBe(true);
    const url = new URL(r.url);
    expect(url.origin).toBe(`https://${s.domain}`);
    expect(url.pathname).toBe("/c/start-anual");
    expect([...url.searchParams.keys()]).toEqual(["s"]);
    for (const needle of ["ana", "souza", "escritorio", "tenant-77", "987654321"]) expect([needle, r.url.toLowerCase().includes(needle)]).toEqual([needle, false]);
    const expires = new Date(r.expira_em).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + SESSION_TTL_MS - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS);
    expect(SESSION_TTL_MS).toBe(60 * 60_000);

    const [row] = await sessionsOf(s.storeId);
    expect(row).toMatchObject({
      id: sessionIdOf(r.url),
      offerId: s.start.id,
      account: "tenant-77",
      buyerName: "Ana Souza",
      buyerEmail: "ana.souza@escritorio.com.br",
      buyerPhone: "11987654321",
      touch: { utm_campaign: "black", fbclid: "IwAR77" },
      orderId: null,
    });
    expect(row!.fbc).toMatch(/^fb\.1\.\d+\.IwAR77$/);

    const [audit] = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "apps.createPayment")));
    expect(audit!.input).toEqual({ oferta: "start-anual", conta_hash: sha256("tenant-77"), emailHash: recoveryEmailHash("Ana.Souza@Escritorio.com.br") });
    const dump = JSON.stringify(audit).toLowerCase();
    for (const needle of ["tenant-77", "ana souza", "escritorio", sessionIdOf(r.url)]) expect([needle, dump.includes(needle)]).toEqual([needle, false]);
  });

  test("oferta inexistente, inativa ou de download → not_found 'Oferta de app não encontrada'", async () => {
    const s = await seedAppStore();
    await t.ownerDb.update(offer).set({ active: false }).where(eq(offer.id, s.plus.id));
    for (const oferta of ["nao-existe", "plus-anual", "guia"]) {
      const e = await failOf(runAction(createPayment, api(s.storeId), payment({ oferta })));
      expect([oferta, e.code, e.message]).toEqual([oferta, "not_found", APP_OFFER_NOT_FOUND_MESSAGE]);
    }
    // Oferta de app de outra loja não aparece (RLS).
    const other = await seedAppStore("Outra");
    await t.ownerDb.update(offer).set({ active: false }).where(eq(offer.id, s.start.id));
    expect(await runAction(createPayment, api(other.storeId), payment()).then((r) => r.criado)).toBe(true);
    expect((await failOf(runAction(createPayment, api(s.storeId), payment()))).code).toBe("not_found");
    expect(await sessionsOf(s.storeId)).toHaveLength(0);
  });

  test("retorno: só https no domínio da loja ou num host de config.returnHosts do app_webhook", async () => {
    const s = await seedAppStore();
    const code = (retorno: string, conta = randomUUID()) =>
      runAction(createPayment, api(s.storeId), payment({ conta, retorno })).then(
        () => "ok",
        (e: ActionError) => e.code,
      );
    expect(await code(`https://${s.domain}/obrigado`)).toBe("ok");
    expect(await code(`https://${s.domain.toUpperCase()}/obrigado?x=1`)).toBe("ok");
    expect(await code("https://app.peticionaaqui.com.br/pagamento/ok")).toBe("invalid_input");
    expect(await code(`http://${s.domain}/obrigado`)).toBe("invalid_input");
    expect(await code(`https://${s.domain}.evil.com/`)).toBe("invalid_input");
    expect(await code(`https://user:pw@${s.domain}/`)).toBe("invalid_input");
    expect(await code("javascript:alert(1)")).toBe("invalid_input");
    // Hosts do app configurados na integração (`app_webhook`, Task 10): passam a valer.
    await t.ownerDb.insert(integration).values({ storeId: s.storeId, kind: "app_webhook", config: { url: "https://app.peticionaaqui.com.br/webhook", returnHosts: ["app.peticionaaqui.com.br"] } });
    expect(await code("https://app.peticionaaqui.com.br/pagamento/ok")).toBe("ok");
    expect(await code("https://outro.peticionaaqui.com.br/")).toBe("invalid_input");
    const rows = await sessionsOf(s.storeId);
    expect(rows.map((r) => r.returnUrl).sort()).toEqual(
      [`https://${s.domain}/obrigado`, `https://${s.domain}/obrigado?x=1`, "https://app.peticionaaqui.com.br/pagamento/ok"].sort(),
    );
  });

  test("nova tentativa do app (mesmo pedido, em paralelo ou logo depois) devolve a mesma sessão", async () => {
    const s = await seedAppStore();
    const results = await Promise.all([0, 1, 2, 3].map(() => runAction(createPayment, api(s.storeId), payment())));
    expect(new Set(results.map((r) => r.url)).size).toBe(1);
    expect(results.filter((r) => r.criado)).toHaveLength(1);
    const again = await runAction(createPayment, api(s.storeId), payment());
    expect(again).toMatchObject({ url: results[0]!.url, criado: false });
    // Outro e-mail, outra oferta ou outra conta: sessão nova.
    await runAction(createPayment, api(s.storeId), payment({ email: "outro@escritorio.com.br" }));
    await runAction(createPayment, api(s.storeId), payment({ oferta: "plus-anual" }));
    await runAction(createPayment, api(s.storeId), payment({ conta: "tenant-78" }));
    expect(await sessionsOf(s.storeId)).toHaveLength(4);
  });

  test("entrada inválida → invalid_input (conta com @, e-mail, nome, telefone, origem longa)", async () => {
    const s = await seedAppStore();
    const cases: Record<string, unknown> = {
      "conta com @": payment({ conta: "ana@x.com" }),
      "conta longa": payment({ conta: "x".repeat(65) }),
      "e-mail": payment({ email: "nao-e-email" }),
      "sem nome": payment({ nome: undefined }),
      "nome curto": payment({ nome: "A" }),
      telefone: payment({ telefone: "1234" }),
      "utm longa": payment({ origem: { utm_source: "x".repeat(501) } }),
      "sem oferta": payment({ oferta: "" }),
    };
    for (const [label, input] of Object.entries(cases)) {
      const code = await runAction(createPayment, api(s.storeId), input).then(
        () => "ok",
        (e: ActionError) => e.code,
      );
      expect([label, code]).toEqual([label, "invalid_input"]);
    }
    expect(await sessionsOf(s.storeId)).toHaveLength(0);
  });

  test("só a chave integration: painel e token MCP → forbidden; fora do MCP", async () => {
    const s = await seedAppStore();
    await expect(runAction(createPayment, { storeId: s.storeId, actor: owner, origin: "panel" }, payment())).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      runAction(createPayment, { storeId: s.storeId, actor: { kind: "token", tokenId: randomUUID(), role: "owner" }, origin: "mcp" }, payment()),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(MCP_EXCLUDED["apps.createPayment"]).toBeDefined();
  });
});

describe("POST /api/integracao/v1/pagamentos", () => {
  test("201 { url, expira_em } na sessão nova, 200 na repetida; 404 oferta; 422 com o campo", async () => {
    const s = await seedAppStore();
    const { token, hash, last4 } = mintMcpToken(s.storeId);
    await t.ownerDb.insert(mcpToken).values({ storeId: s.storeId, name: "App", role: "integration", tokenHash: hash, last4 });
    const call = (body: unknown) =>
      POST(new Request("http://localhost:3000/api/integracao/v1/pagamentos", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    const first = await call(payment());
    expect(first.status).toBe(201);
    const body = (await first.json()) as { url: string; expira_em: string };
    expect(Object.keys(body).sort()).toEqual(["expira_em", "url"]);
    expect(body.url).toStartWith(`https://${s.domain}/c/start-anual?s=`);
    const again = await call(payment());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
    const missing = await call(payment({ oferta: "nao-existe" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ erro: { codigo: "not_found", mensagem: APP_OFFER_NOT_FOUND_MESSAGE } });
    const bad = await call(payment({ email: undefined }));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ erro: { codigo: "invalid_input", detalhes: [{ campo: "email" }] } });
  });
});

describe("checkout.start com a sessão do app", () => {
  async function session(s: Awaited<ReturnType<typeof seedAppStore>>, over: Record<string, unknown> = {}) {
    const r = await runAction(createPayment, api(s.storeId), payment({ conta: `conta-${randomUUID().slice(0, 8)}`, ...over }));
    return sessionIdOf(r.url);
  }

  test("pedido grava app_account e app_session_id e usa nome e e-mail da sessão, mesmo com outros no corpo", async () => {
    const s = await seedAppStore();
    const id = await session(s, { conta: "tenant-1" });
    const out = await runAction(
      checkoutStart,
      pub(s.storeId),
      sessionStart("start-anual", id, { customer: { name: "Outra Pessoa", email: "intruso@exemplo.com" } }),
    );
    expect(out.method).toBe("pix_asaas");
    const [o] = await ordersOf(s.storeId);
    expect(o).toMatchObject({ id: out.orderId, appAccount: "tenant-1", appSessionId: id, buyerName: "Ana Souza", totalCents: 49_700, hasBump: false, couponId: null });
    const [c] = await withStore(s.storeId, (tx) => tx.select().from(customer).where(eq(customer.id, o!.customerId)));
    expect(c!.email).toBe("ana.souza@escritorio.com.br");
    const [row] = await sessionsOf(s.storeId);
    expect(row!.orderId).toBe(out.orderId);
    // Auditoria do checkout sem o id da sessão (é o segredo da URL) nem dado pessoal.
    const audits = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "checkout.start")));
    const dump = JSON.stringify(audits);
    for (const needle of [id, "Ana Souza", "escritorio", "intruso"]) expect([needle, dump.includes(needle)]).toEqual([needle, false]);
  });

  test("oferta de app sem sessão → invalid_input 'Abra o pagamento pelo app'", async () => {
    const s = await seedAppStore();
    const input: Record<string, unknown> = sessionStart("start-anual", randomUUID(), { customer: { name: "Ana Souza", email: "a@exemplo.com" } });
    delete input.sessionId;
    const e = await failOf(runAction(checkoutStart, pub(s.storeId), input));
    expect([e.code, e.message]).toEqual(["invalid_input", "Abra o pagamento pelo app"]);
    expect(await ordersOf(s.storeId)).toEqual([]);
  });

  test("sessão vencida (61 min), de outra oferta, de outra loja, inexistente ou numa oferta de download → SESSION_INVALID", async () => {
    const s = await seedAppStore();
    const other = await seedAppStore("Outra loja");
    const id = await session(s);
    const expect409 = async (label: string, storeId: string, slug: string, sid: string, now?: Date) => {
      const e = await failOf(runAction(checkoutStart, pub(storeId, now), sessionStart(slug, sid, slug === "guia" ? { customer: { name: "Ana Souza", email: "a@exemplo.com" } } : {})));
      expect([label, e.code, e.message, e.details]).toEqual([label, "conflict", SESSION_INVALID_MESSAGE, { code: "SESSION_INVALID" }]);
    };
    await expect409("vencida", s.storeId, "start-anual", id, new Date(Date.now() + 61 * 60_000));
    await expect409("outra oferta", s.storeId, "plus-anual", id);
    await expect409("outra loja", other.storeId, "start-anual", id);
    await expect409("inexistente", s.storeId, "start-anual", randomUUID());
    await expect409("download", s.storeId, "guia", id);
    expect(await ordersOf(s.storeId)).toEqual([]);
    // Dentro dos 60 min (relógio injetado em 59 min) a mesma sessão vale.
    const ok = await runAction(checkoutStart, pub(s.storeId, new Date(Date.now() + 59 * 60_000)), sessionStart("start-anual", id));
    expect(ok.method).toBe("pix_asaas");
  });

  test("sessão com pedido pago (ou pago e reembolsado) → SESSION_INVALID; nenhum pedido novo", async () => {
    const s = await seedAppStore();
    for (const status of ["paid", "refunded"] as const) {
      const id = await session(s);
      const first = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
      await t.ownerDb.update(orders).set({ status, paidAt: new Date() }).where(eq(orders.id, first.orderId));
      const e = await failOf(runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" })));
      expect([status, e.code, e.details]).toEqual([status, "conflict", { code: "SESSION_INVALID" }]);
      await withStore(s.storeId, async (tx) => expect(await loadCheckoutSession(tx, s.storeId, id)).toBeNull());
    }
    expect(await ordersOf(s.storeId)).toHaveLength(2);
  });

  test("Pix pendente e depois cartão na mesma sessão: dois pedidos, a sessão aponta para o último", async () => {
    const s = await seedAppStore();
    const id = await session(s);
    const pix = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    const card = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" }));
    expect(card.method).toBe("card_asaas");
    const rows = await ordersOf(s.storeId);
    expect(rows.map((o) => o.id).sort()).toEqual([pix.orderId, card.orderId].sort());
    expect(rows.every((o) => o.appSessionId === id)).toBe(true);
    expect((await sessionsOf(s.storeId))[0]!.orderId).toBe(card.orderId);
  });

  test("cupom ou bump com sessão → invalid_input, sem pedido", async () => {
    const s = await seedAppStore();
    const id = await session(s);
    const coupon = await failOf(runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { couponCode: "PROMO10", expectedTotalCents: 44_730 })));
    expect(coupon.code).toBe("invalid_input");
    const bump = await failOf(runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { withBump: true })));
    expect(bump.code).toBe("invalid_input");
    expect(await ordersOf(s.storeId)).toEqual([]);
  });

  test("telefone: o da sessão vale quando o navegador não manda; sem nenhum → invalid_input no campo", async () => {
    const s = await seedAppStore();
    const withPhone = await session(s, { telefone: "(21) 99812-3044" });
    const noPhone: Record<string, unknown> = { ...sessionStart("start-anual", withPhone).customer };
    delete noPhone.phone;
    const out = await runAction(checkoutStart, pub(s.storeId), { ...sessionStart("start-anual", withPhone), customer: noPhone });
    const [o] = (await ordersOf(s.storeId)).filter((x) => x.id === out.orderId);
    expect(o!.buyerPhone).toBe("21998123044");
    const without = await session(s);
    const e = await failOf(runAction(checkoutStart, pub(s.storeId), { ...sessionStart("start-anual", without), customer: noPhone }));
    expect(e.code).toBe("invalid_input");
    expect(e.details).toEqual([expect.objectContaining({ path: ["customer", "phone"] })]);
  });

  test("toque do pedido: da sessão quando ela trouxe origem; senão do teste da conta; nunca da URL do checkout", async () => {
    const s = await seedAppStore();
    await runAction(registerTrial, api(s.storeId), { conta: "conta-trial", email: "t@exemplo.com", origem: { utm_source: "facebook", utm_campaign: "teste-gratis", ref: "parceiro", fbc: "fb.1.1.trial", fbp: "fb.1.1.fbp-trial" } });
    const fromTrial = await session(s, { conta: "conta-trial" });
    const a = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", fromTrial, { ref: "url", fbc: "fb.1.1.url", fbp: "fb.1.1.url" }));
    const fromSession = await session(s, { conta: "conta-trial", oferta: "plus-anual", origem: { utm_source: "google", utm_campaign: "pagar", fbp: "fb.1.1.fbp-sessao" } });
    const b = await runAction(checkoutStart, pub(s.storeId), sessionStart("plus-anual", fromSession));
    const byId = new Map((await ordersOf(s.storeId)).map((o) => [o.id, o]));
    expect(byId.get(a.orderId)).toMatchObject({
      firstTouch: { utm_source: "facebook", utm_campaign: "teste-gratis" },
      lastTouch: { utm_source: "facebook", utm_campaign: "teste-gratis" },
      ref: "parceiro",
      fbc: "fb.1.1.trial",
      fbp: "fb.1.1.fbp-trial",
    });
    expect(byId.get(b.orderId)).toMatchObject({
      firstTouch: { utm_source: "google", utm_campaign: "pagar" },
      lastTouch: { utm_source: "google", utm_campaign: "pagar" },
      ref: null,
      fbc: null,
      fbp: "fb.1.1.fbp-sessao",
    });
    // Conta sem teste e sessão sem origem: pedido sem toque (o da URL é ignorado).
    const bare = await session(s, { conta: "sem-teste", oferta: "start-anual", email: "x@exemplo.com" });
    const c = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", bare));
    expect((await ordersOf(s.storeId)).find((o) => o.id === c.orderId)).toMatchObject({ firstTouch: null, lastTouch: null, ref: null, fbc: null, fbp: null });
  });
});

describe("página do pedido de app (getOrderPublic)", () => {
  test("pendente: sessão para o cartão; pago: retorno do app, sem a sessão; uma linha com a oferta e sem dado pessoal", async () => {
    const s = await seedAppStore();
    const r = await runAction(createPayment, api(s.storeId), payment({ conta: "pagina", retorno: `https://${s.domain}/voltar` }));
    const id = sessionIdOf(r.url);
    const out = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    const [o] = await ordersOf(s.storeId);
    const pending = (await getOrderPublic(s.storeId, o!.publicId))!;
    expect(pending.offer.delivery).toBe("app");
    expect(pending.app).toEqual({ returnUrl: `https://${s.domain}/voltar`, sessionId: id, sessionClosed: null });
    expect(pending.items).toEqual([{ name: "Plano start-anual", priceCents: 49_700 }]);
    await t.ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, out.orderId));
    const paid = (await getOrderPublic(s.storeId, o!.publicId))!;
    expect(paid.app).toEqual({ returnUrl: `https://${s.domain}/voltar`, sessionId: null, sessionClosed: "paid" });
    const dump = JSON.stringify(paid);
    for (const needle of ["escritorio", "pagina", id]) expect([needle, dump.includes(needle)]).toEqual([needle, false]);
  });
});

describe("checkout.appSession (página /c/<slug>?s=<id>)", () => {
  test("sessão válida → nome, e-mail e se já tem telefone; inválida → SESSION_INVALID", async () => {
    const s = await seedAppStore();
    const r = await runAction(createPayment, api(s.storeId), payment({ telefone: "(11) 98765-4321" }));
    const id = sessionIdOf(r.url);
    expect(await runAction(checkoutAppSession, pub(s.storeId), { slug: "start-anual", sessionId: id })).toEqual({
      buyerName: "Ana Souza",
      buyerEmail: "ana.souza@escritorio.com.br",
      hasPhone: true,
    });
    for (const [label, slug, sid, now] of [
      ["outra oferta", "plus-anual", id, undefined],
      ["inexistente", "start-anual", randomUUID(), undefined],
      ["vencida", "start-anual", id, new Date(Date.now() + 61 * 60_000)],
    ] as const) {
      const e = await failOf(runAction(checkoutAppSession, pub(s.storeId, now), { slug, sessionId: sid }));
      expect([label, e.code, e.details]).toEqual([label, "conflict", { code: "SESSION_INVALID" }]);
    }
    expect((await failOf(runAction(checkoutAppSession, pub(s.storeId), { slug: "start-anual", sessionId: "nao-e-uuid" }))).code).toBe("invalid_input");
  });
});

describe("captura de contato na oferta de app", () => {
  test("checkout.saveLead não guarda contato nem agenda aviso numa oferta de app", async () => {
    const s = await seedAppStore();
    await t.ownerDb.update(store).set({ leadCapture: true, privacyEmail: "privacidade@exemplo.com" }).where(eq(store.id, s.storeId));
    const out = await runAction(checkoutSaveLead, pub(s.storeId), { slug: "start-anual", leadKey: randomUUID(), email: "lead@exemplo.com", phone: "(11) 98765-4321", clientIp: nextIp() });
    expect(out).toEqual({ created: false, leadId: null });
    expect(await withStore(s.storeId, (tx) => tx.select().from(checkoutLead))).toEqual([]);
    // A oferta de download da mesma loja continua capturando.
    expect((await runAction(checkoutSaveLead, pub(s.storeId), { slug: "guia", leadKey: randomUUID(), email: "lead@exemplo.com", clientIp: nextIp() })).created).toBe(true);
  });
});

describe("retenção das sessões (sweep_app_trials)", () => {
  const noJob = { id: randomUUID(), storeId: null, type: "sweep_app_trials", payload: {} } as unknown as Job;
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

  test("sem pedido: apagada 7 dias depois de vencer; com pedido: fica, sem nome/e-mail/telefone depois de vencer", async () => {
    expect(SESSION_RETENTION_DAYS).toBe(7);
    const s = await seedAppStore();
    const mk = async (conta: string, expiresAt: Date) => {
      const r = await runAction(createPayment, api(s.storeId), payment({ conta, telefone: "(11) 98765-4321" }));
      const id = sessionIdOf(r.url);
      return { id, expiresAt };
    };
    const live = await mk("ativa", new Date());
    const recent = await mk("vencida-ha-6-dias", daysAgo(6));
    const old = await mk("vencida-ha-8-dias", daysAgo(8));
    const paidLive = await mk("com-pedido-ativa", new Date());
    const paidOld = await mk("com-pedido-vencida", daysAgo(1));
    for (const x of [paidLive, paidOld]) await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", x.id));
    for (const x of [recent, old, paidOld]) await t.ownerDb.update(appCheckoutSession).set({ expiresAt: x.expiresAt }).where(eq(appCheckoutSession.id, x.id));

    await sweepAppTrialsJob(noJob, new AbortController().signal);

    const rows = new Map((await sessionsOf(s.storeId)).map((r) => [r.id, r]));
    expect(rows.has(old.id)).toBe(false);
    expect(rows.get(recent.id)).toMatchObject({ buyerName: "Ana Souza", buyerPhone: "11987654321" });
    expect(rows.get(live.id)).toMatchObject({ buyerName: "Ana Souza" });
    expect(rows.get(paidLive.id)).toMatchObject({ buyerName: "Ana Souza", buyerEmail: "ana.souza@escritorio.com.br" });
    const cleared = rows.get(paidOld.id)!;
    expect(cleared).toMatchObject({ buyerName: "", buyerEmail: "", buyerPhone: null, account: "com-pedido-vencida" });
    expect(cleared.orderId).not.toBeNull();
    // O pedido continua com os dados dele.
    const [o] = await withStore(s.storeId, (tx) => tx.select().from(orders).where(eq(orders.id, cleared.orderId!)));
    expect(o!.buyerName).toBe("Ana Souza");
    // Repetir não muda nada.
    await sweepAppTrialsJob(noJob, new AbortController().signal);
    expect((await sessionsOf(s.storeId)).length).toBe(rows.size);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Correções da revisão de segurança do PR #43

const ctxOf = (storeId: string, tx: Parameters<Parameters<typeof withStore>[1]>[0]) => ({ storeId, actor: { kind: "system" } as Actor, origin: "system" as const, tx });
const move = (storeId: string, orderId: string, to: "paid" | "refunded" | "disputed") =>
  withStore(storeId, (tx) => transitionOrder(ctxOf(storeId, tx), orderId, to, "teste"));
const deliveriesOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(appWebhookDelivery));
const duplicateAlerts = (storeId: string) =>
  withStore(storeId, (tx) => tx.select().from(storeAlert).where(eq(storeAlert.kind, "pagamento_duplicado_app")));

describe("uma liberação por sessão (pagamento em dobro)", () => {
  test("Pix e cartão da mesma sessão confirmados ao mesmo tempo: um aviso ao app, um alerta; estornar o duplicado não avisa nem mexe no válido", async () => {
    const s = await seedAppStore();
    const r = await runAction(createPayment, api(s.storeId), payment({ conta: "dobro" }));
    const id = sessionIdOf(r.url);
    const pix = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    const card = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" }));
    expect(pix.orderId).not.toBe(card.orderId);

    await Promise.all([move(s.storeId, pix.orderId, "paid"), move(s.storeId, card.orderId, "paid")]);

    const [session] = await sessionsOf(s.storeId);
    const valid = session!.releasedOrderId!;
    const dup = valid === pix.orderId ? card.orderId : pix.orderId;
    expect([pix.orderId, card.orderId]).toContain(valid);
    const notices = await deliveriesOf(s.storeId);
    expect(notices.map((d) => [d.orderId, d.eventType])).toEqual([[valid, "pagamento.confirmado"]]);
    const alerts = await duplicateAlerts(s.storeId);
    expect(alerts.map((a) => a.orderId)).toEqual([dup]);

    // O worker do cartão (deliver_order) chamando de novo para o duplicado: nada de aviso nem de segundo alerta.
    expect(await withStore(s.storeId, (tx) => enqueueAppNotice(tx, s.storeId, dup, "pagamento.confirmado"))).toBe(false);
    expect(await duplicateAlerts(s.storeId)).toHaveLength(1);

    // Estorno do duplicado: nenhum aviso ao app; a compra válida continua paga e liberada.
    await move(s.storeId, dup, "refunded");
    expect((await deliveriesOf(s.storeId)).map((d) => [d.orderId, d.eventType])).toEqual([[valid, "pagamento.confirmado"]]);
    const byId = new Map((await ordersOf(s.storeId)).map((o) => [o.id, o.status]));
    expect([byId.get(valid), byId.get(dup)]).toEqual(["paid", "refunded"]);
    expect((await sessionsOf(s.storeId))[0]!.releasedOrderId).toBe(valid);

    // Já o reembolso da compra válida avisa o app normalmente.
    await move(s.storeId, valid, "refunded");
    expect((await deliveriesOf(s.storeId)).map((d) => d.eventType).sort()).toEqual(["pagamento.confirmado", "pagamento.reembolsado"]);
  });

  test("duas abas pelo mesmo método reaproveitam o pedido pendente (um pedido por método)", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "abas" }))).url);
    const [a, b] = await Promise.all([
      runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id)),
      runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id)),
    ]);
    expect(a.orderId).toBe(b.orderId);
    const c1 = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" }));
    const c2 = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" }));
    expect(c1.orderId).toBe(c2.orderId);
    expect(await ordersOf(s.storeId)).toHaveLength(2);
    expect((await sessionsOf(s.storeId))[0]!.orderId).toBe(c2.orderId);
    // Pedido que não está mais pendente (Pix vencido) não é reaproveitado.
    await t.ownerDb.update(orders).set({ status: "expired" }).where(eq(orders.id, a.orderId));
    const again = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    expect(again.orderId).not.toBe(a.orderId);
  });
});

describe("trava da oferta e entrega", () => {
  test("createOrder recusa pedido de app em oferta de download e oferta de app sem a sessão", async () => {
    const s = await seedAppStore();
    const base = { withBump: false, method: "pix_asaas" as const, customer: { name: "Ana Souza", email: "a@exemplo.com", phone: "11987654321", cpf: CPF }, touch: { first: null, last: null }, clientIp: nextIp(), userAgent: "t" };
    const sid = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "trava" }))).url);
    const errOf = (offerId: string, app?: { account: string; sessionId: string }) =>
      withStore(s.storeId, (tx) => createOrder({ storeId: s.storeId, actor: { kind: "public" }, origin: "public", tx }, { ...base, offerId, ...(app ? { app } : {}) })).then(
        () => "ok",
        (e: ActionError) => e.code,
      );
    expect(await errOf(s.download.id, { account: "trava", sessionId: sid })).toBe("conflict");
    expect(await errOf(s.start.id)).toBe("conflict");
    // Oferta de download sem produtos (lista esvaziada) nunca vira pedido sem itens.
    await t.ownerDb.execute(sql`delete from offer_product where offer_id = ${s.download.id}`);
    expect(await errOf(s.download.id)).toBe("not_found");
    expect(await ordersOf(s.storeId)).toEqual([]);
  });

  test("oferta virou download depois da sessão: o checkout com a sessão é recusado e nada é criado", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "virou" }))).url);
    await t.ownerDb.update(offer).set({ delivery: "download", appCode: null }).where(eq(offer.id, s.start.id));
    const e = await failOf(runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id)));
    expect(e.details).toEqual({ code: "SESSION_INVALID" });
    expect(await ordersOf(s.storeId)).toEqual([]);
  });
});

describe("privacidade do link (?s=)", () => {
  test("appGate: download com s → link vencido (sem formulário nem Pixel); download sem s → checkout normal; app sem s → abrir pelo app", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "gate" }))).url);
    expect(await appGate(s.storeId, "guia", "download", id)).toEqual({ blocked: SESSION_INVALID_MESSAGE });
    expect(await appGate(s.storeId, "guia", "download", "")).toEqual({ blocked: SESSION_INVALID_MESSAGE });
    expect(await appGate(s.storeId, "guia", "download", undefined)).toBeNull();
    expect(await appGate(s.storeId, "start-anual", "app", undefined)).toEqual({ blocked: "Abra o pagamento pelo app" });
    expect(await appGate(s.storeId, "start-anual", "app", "lixo")).toEqual({ blocked: SESSION_INVALID_MESSAGE });
    expect(await appGate(s.storeId, "start-anual", "app", id, new Date(Date.now() + 61 * 60_000))).toEqual({ blocked: SESSION_INVALID_MESSAGE });
    expect(await appGate(s.storeId, "start-anual", "app", id)).toMatchObject({ session: { sessionId: id, name: "Ana Souza" } });
  });

  test("Referrer-Policy: strict-origin no /c com s e em /o (só a origem; o Origin do POST nativo continua); checkout comum sem a política", () => {
    const q = (x: string) => new URLSearchParams(x);
    expect(buyerReferrerPolicy("/c/start-anual", q("s=abc"))).toBe("strict-origin");
    expect(buyerReferrerPolicy("/o/pedido", q(""))).toBe("strict-origin");
    expect(buyerReferrerPolicy("/c/guia", q("utm_source=ig"))).toBeNull();
    expect(proxy(new NextRequest("http://127.0.0.1:3000/c/start-anual?s=abc")).headers.get("referrer-policy")).toBe("strict-origin");
    expect(proxy(new NextRequest("http://127.0.0.1:3000/o/abc")).headers.get("referrer-policy")).toBe("strict-origin");
    expect(proxy(new NextRequest("http://127.0.0.1:3000/c/guia")).headers.get("referrer-policy")).toBeNull();
  });
});

describe("preço conferido no pedido de app", () => {
  test("sem expectedTotalCents → invalid_input; total diferente do preço atual → PRICE_CHANGED com a mensagem de nova confirmação", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "preco" }))).url);
    const missing: Record<string, unknown> = sessionStart("start-anual", id);
    delete missing.expectedTotalCents;
    const e1 = await failOf(runAction(checkoutStart, pub(s.storeId), missing));
    expect([e1.code, e1.details]).toEqual(["invalid_input", [expect.objectContaining({ path: ["expectedTotalCents"] })]]);
    // O preço subiu com a página aberta: nenhum pedido pelo valor novo sem o comprador ver.
    await t.ownerDb.update(offer).set({ priceCents: 59_700 }).where(eq(offer.id, s.start.id));
    const e2 = await failOf(runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" })));
    expect([e2.code, e2.message, (e2.details as { code?: string }).code]).toEqual(["conflict", PRICE_CHANGED_MESSAGE, "PRICE_CHANGED"]);
    expect(await ordersOf(s.storeId)).toEqual([]);
    // Um pendente do preço antigo não é reaproveitado depois da mudança.
    expect((await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { expectedTotalCents: 59_700 }))).totalCents).toBe(59_700);
  });

  test("submitCoupon: com alwaysTotal (app) o total vai mesmo sem cupom", () => {
    const closed = { kind: "closed" } as Parameters<typeof submitCoupon>[0];
    expect(submitCoupon(closed, 49_700)).toEqual({});
    expect(submitCoupon(closed, 49_700, { alwaysTotal: true })).toEqual({ expectedTotalCents: 49_700 });
  });
});

describe("repetição em 2 min compara a origem", () => {
  test("mesma origem (com fbclid) → mesma sessão; outra campanha ou outro clique → sessão nova", async () => {
    const s = await seedAppStore();
    const o1 = { utm_campaign: "black", fbclid: "IwAR1" };
    const a = await runAction(createPayment, api(s.storeId), payment({ conta: "origem", origem: o1 }));
    const b = await runAction(createPayment, api(s.storeId), payment({ conta: "origem", origem: { fbclid: "IwAR1", utm_campaign: "black" } }));
    expect(b).toMatchObject({ url: a.url, criado: false });
    const c = await runAction(createPayment, api(s.storeId), payment({ conta: "origem", origem: { utm_campaign: "outra", fbclid: "IwAR1" } }));
    const d = await runAction(createPayment, api(s.storeId), payment({ conta: "origem", origem: { utm_campaign: "black", fbclid: "IwAR2" } }));
    const e = await runAction(createPayment, api(s.storeId), payment({ conta: "origem" }));
    expect([c.criado, d.criado, e.criado]).toEqual([true, true, true]);
    expect(new Set([a.url, c.url, d.url, e.url]).size).toBe(4);
  });
});

describe("tentativa direta só com a sessão utilizável", () => {
  test("Pix vencido com a sessão ainda válida: link com s; sessão vencida ou com pedido pago: sem s (voltar ao app)", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "de-novo", retorno: `https://${s.domain}/app` }))).url);
    const out = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    const [o] = await ordersOf(s.storeId);
    await t.ownerDb.update(orders).set({ status: "expired" }).where(eq(orders.id, out.orderId));
    expect((await getOrderPublic(s.storeId, o!.publicId))!.app).toEqual({ returnUrl: `https://${s.domain}/app`, sessionId: id, sessionClosed: null });
    await t.ownerDb.update(appCheckoutSession).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(appCheckoutSession.id, id));
    expect((await getOrderPublic(s.storeId, o!.publicId))!.app).toEqual({ returnUrl: `https://${s.domain}/app`, sessionId: null, sessionClosed: "expired" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Correções da re-revisão do PR #43

const KEY = "k".repeat(32) + "-chave-do-bilhete-de-teste";

describe("ordem das travas: retomar o Pix enquanto o webhook confirma", () => {
  test("com o pedido travado pelo webhook (FOR UPDATE), a aba que retoma o Pix termina sem esperar e o webhook confirma depois", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "travas" }))).url);
    const pix = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    // Depois um cartão: a sessão passa a apontar para ele (retomar o Pix mudaria o ponteiro de volta, o caso do impasse).
    const card = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" }));
    expect((await sessionsOf(s.storeId))[0]!.orderId).toBe(card.orderId);
    await withStore(s.storeId, async (tx) => {
      // Como o webhook do Asaas: segura o pedido e, ao mudar o estado, trava a sessão (enqueueAppNotice).
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, pix.orderId)).for("update");
      const again = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
      expect(again.orderId).toBe(pix.orderId);
      expect(await transitionOrder(ctxOf(s.storeId, tx), pix.orderId, "paid", "asaas CONFIRMED")).toEqual({ changed: true });
    });
    expect((await deliveriesOf(s.storeId)).map((d) => [d.orderId, d.eventType])).toEqual([[pix.orderId, "pagamento.confirmado"]]);
    expect((await sessionsOf(s.storeId))[0]!.releasedOrderId).toBe(pix.orderId);
  });
});

describe("repetição com fbclid longo", () => {
  test("fbclid de 450 caracteres (o fbc gravado corta em 400): a mesma chamada devolve a mesma sessão", async () => {
    const s = await seedAppStore();
    const fbclid = "IwAR" + "x".repeat(446);
    const a = await runAction(createPayment, api(s.storeId), payment({ conta: "fbclid-longo", origem: { fbclid } }));
    const b = await runAction(createPayment, api(s.storeId), payment({ conta: "fbclid-longo", origem: { fbclid } }));
    expect(b).toMatchObject({ url: a.url, criado: false });
    const [row] = await sessionsOf(s.storeId);
    expect(row!.fbc!.length).toBeLessThan(fbclid.length);
    const c = await runAction(createPayment, api(s.storeId), payment({ conta: "fbclid-longo", origem: { fbclid: fbclid.slice(0, 449) + "y" } }));
    // Diferença só depois do corte de 400 no fbc, mas o toque guarda o fbclid inteiro: é outro clique, outra sessão.
    expect(c.criado).toBe(true);
  });
});

describe("reaproveitamento só com os mesmos dados de cobrança", () => {
  test("telefone ou CPF/CNPJ corrigidos criam pedido novo; os mesmos dados reaproveitam; reaproveitar não consome a cota", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "cobranca" }))).url);
    const first = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    const otherPhone = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { customer: { phone: "(21) 99812-3044" } }));
    expect(otherPhone.orderId).not.toBe(first.orderId);
    const otherDoc = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { customer: { cpf: "11144477735" } }));
    expect(new Set([first.orderId, otherPhone.orderId, otherDoc.orderId]).size).toBe(3);
    const rows = new Map((await ordersOf(s.storeId)).map((o) => [o.id, o]));
    expect([rows.get(otherPhone.orderId)!.buyerPhone, rows.get(otherDoc.orderId)!.buyerCpf]).toEqual(["21998123044", "11144477735"]);
    // Os mesmos dados: o mesmo pedido, quantas vezes for, sem bater no limite por e-mail (5 por hora).
    const sameDoc = sessionStart("start-anual", id, { customer: { cpf: "11144477735" } });
    for (let i = 0; i <= ASAAS_LIMITS.perEmailPerHour; i++) {
      const again = await runAction(checkoutStart, pub(s.storeId), { ...sameDoc, clientIp: nextIp() });
      expect(again.orderId).toBe(otherDoc.orderId);
    }
    expect(await ordersOf(s.storeId)).toHaveLength(3);
  });
});

describe("cartão depois do Pix pago na mesma sessão", () => {
  test("renovar o bilhete com a sessão já paga ou vencida: recusa (SESSION_INVALID) e o pedido de cartão pendente é encerrado", async () => {
    const s = await seedAppStore();
    for (const caso of ["pago", "vencida"] as const) {
      const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: `cartao-${caso}` }))).url);
      const card = await startCheckout({ storeId: s.storeId }, sessionStart("start-anual", id, { method: "card" }), { cardTicketKey: KEY });
      // Com a sessão servindo, a renovação funciona.
      const fresh = await renewCardTicket({ storeId: s.storeId }, { publicId: card.publicId, ticket: card.cardTicket }, KEY);
      expect(fresh.length).toBeGreaterThan(10);
      let now: Date | undefined;
      if (caso === "pago") {
        const pix = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
        await move(s.storeId, pix.orderId, "paid");
      } else now = new Date(Date.now() + 61 * 60_000);
      const e = await failOf(renewCardTicket({ storeId: s.storeId }, { publicId: card.publicId, ticket: fresh }, KEY, now));
      expect([caso, e.code, e.details]).toEqual([caso, "conflict", { code: "SESSION_INVALID" }]);
      const [o] = (await ordersOf(s.storeId)).filter((x) => x.publicId === card.publicId);
      expect([caso, o!.status]).toEqual([caso, "expired"]);
    }
  });
});

describe("oferta na auditoria", () => {
  test("oferta fora do formato de slug (um e-mail) → invalid_input, e a auditoria não guarda o valor", async () => {
    const s = await seedAppStore();
    const e = await failOf(runAction(createPayment, api(s.storeId), payment({ oferta: "ana.souza@escritorio.com.br" })));
    expect(e.code).toBe("invalid_input");
    const audits = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "apps.createPayment")));
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits)).not.toContain("escritorio");
    // Slug válido, mas inexistente: a auditoria guarda só o slug.
    await failOf(runAction(createPayment, api(s.storeId), payment({ oferta: "nao-existe" })));
    const after = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "apps.createPayment")));
    expect(after.map((a) => (a.input as { oferta?: string } | null)?.oferta).filter(Boolean)).toEqual(["nao-existe"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Correções da 3ª rodada do PR #43

const tick = () => new Promise<void>((r) => setImmediate(r));
/** Volta quando alguma conexão deste banco está esperando uma trava (sem espera fixa: olha a cada volta do laço). */
async function someoneWaitsForLock(): Promise<void> {
  for (;;) {
    const rows = (await t.ownerDb.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as { n: number }[];
    if ((rows[0]?.n ?? 0) > 0) return;
    await tick();
  }
}

/** Segura o POST /payments (cobrança do cartão) até `release()`; `arrived` resolve quando ele chega ao "Asaas". */
function gateCardCharge(fake: ReturnType<typeof createFakeAsaas>) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  setAsaasFetchForTests((async (i: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(i).endsWith("/payments") && String(init.body ?? "").includes("CREDIT_CARD")) {
      reached();
      await gate;
    }
    return fake.fetch(i, init);
  }) as unknown as typeof fetch);
  return { release, arrived };
}

const cardInput = (publicId: string) => ({
  orderPublicId: publicId,
  idempotencyKey: randomUUID(),
  installments: 1,
  card: { holderName: "TITULAR UNICO ZETA", number: "4444444444444444", expiryMonth: "08", expiryYear: "2034", ccv: "987" },
  holder: { cpf: CPF, postalCode: "01310-100", addressNumber: "100" },
  clientIp: nextIp(),
});

describe("cartão aprovado em pedido de app que expirou no meio da cobrança", () => {
  for (const caso of ["pix pago", "sessão vencida"] as const) {
    test(`${caso}: a aprovação vira pagamento real e a eleição da sessão decide`, async () => {
      const s = await seedAppStore();
      const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: `tarde-${caso}` }))).url);
      const card = await startCheckout({ storeId: s.storeId }, sessionStart("start-anual", id, { method: "card" }), { cardTicketKey: KEY });
      const [cardOrder] = (await ordersOf(s.storeId)).filter((o) => o.publicId === card.publicId);
      const gate = gateCardCharge(s.fake);
      const charging = payWithCard({ storeId: s.storeId }, cardInput(card.publicId), { wait: tick });
      await gate.arrived;
      // Enquanto o Asaas cobra (fora da trava), a renovação do bilhete encerra o pedido de cartão.
      let pixId: string | null = null;
      let now: Date | undefined;
      if (caso === "pix pago") {
        const pix = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
        await move(s.storeId, pix.orderId, "paid");
        pixId = pix.orderId;
      } else now = new Date(Date.now() + 61 * 60_000);
      await failOf(renewCardTicket({ storeId: s.storeId }, { publicId: card.publicId, ticket: card.cardTicket }, KEY, now));
      expect((await ordersOf(s.storeId)).find((o) => o.id === cardOrder!.id)!.status).toBe("expired");
      gate.release();
      expect(await charging).toEqual({ status: "approved" });

      const rows = new Map((await ordersOf(s.storeId)).map((o) => [o.id, o]));
      expect(rows.get(cardOrder!.id)!.status).toBe("paid");
      const [p] = await withStore(s.storeId, (tx) => tx.select().from(paymentRow).where(eq(paymentRow.orderId, cardOrder!.id)));
      expect((p!.raw as { duplicate?: boolean } | null)?.duplicate).toBeUndefined();
      const notices = (await deliveriesOf(s.storeId)).map((d) => [d.orderId, d.eventType]);
      const alerts = (await duplicateAlerts(s.storeId)).map((a) => a.orderId);
      if (caso === "pix pago") {
        // O Pix liberou; o cartão é o duplicado: sem aviso ao app, com alerta de reembolso.
        expect(notices).toEqual([[pixId, "pagamento.confirmado"]]);
        expect(alerts).toEqual([cardOrder!.id]);
      } else {
        // Só a sessão venceu: o cartão pago libera no app.
        expect(notices).toEqual([[cardOrder!.id, "pagamento.confirmado"]]);
        expect(alerts).toEqual([]);
        expect((await sessionsOf(s.storeId))[0]!.releasedOrderId).toBe(cardOrder!.id);
      }
    });
  }
});

describe("ordem de travas: reenvio do aviso × aviso anterior abandonado", () => {
  test("com o pedido travado pelo reenvio, o job do aviso seguinte espera o pedido antes de mexer no anterior (sem impasse)", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "reenvio" }))).url);
    const pix = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
    await move(s.storeId, pix.orderId, "paid");
    await move(s.storeId, pix.orderId, "refunded");
    const byType = new Map((await deliveriesOf(s.storeId)).map((d) => [d.eventType, d]));
    const confirmed = byType.get("pagamento.confirmado")!;
    const refunded = byType.get("pagamento.reembolsado")!;
    // O aviso anterior ficou pendente sem job (abandonado): o job do seguinte o daria como falho, com alerta.
    await t.ownerDb.delete(job).where(sql`${job.type} = 'notify_app' and ${job.payload}->>'deliveryId' = ${confirmed.id}`);

    const { running } = await withStore(s.storeId, async (tx) => {
      // Como o "Reenviar": trava o pedido...
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, pix.orderId)).for("update");
      const running = notifyAppJob({ id: randomUUID(), storeId: s.storeId, type: "notify_app", payload: { deliveryId: refunded.id } } as unknown as Job, new AbortController().signal);
      await someoneWaitsForLock();
      // ...e reabre o aviso anterior com um job novo.
      await tx.update(appWebhookDelivery).set({ status: "pending", attempts: 0 }).where(eq(appWebhookDelivery.id, confirmed.id));
      await enqueue(tx, { storeId: s.storeId, type: "notify_app", payload: { deliveryId: confirmed.id } });
      return { running };
    });
    await running;
    const after = new Map((await deliveriesOf(s.storeId)).map((d) => [d.eventType, d.status]));
    // O reenvio venceu: o anterior segue pendente (com job) e o seguinte espera por ele; nenhum alerta de falha.
    expect([after.get("pagamento.confirmado"), after.get("pagamento.reembolsado")]).toEqual(["pending", "pending"]);
    const failedAlerts = await withStore(s.storeId, (tx) => tx.select().from(storeAlert).where(eq(storeAlert.kind, "app_webhook_falhou")));
    expect(failedAlerts).toEqual([]);
  });
});

describe("Gerar novo código Pix depois de a sessão fechar", () => {
  test("sessão vencida ou já paga: recusa (SESSION_INVALID) e o pedido pendente expira; a página não oferece o botão", async () => {
    const s = await seedAppStore();
    for (const caso of ["vencida", "paga"] as const) {
      const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: `regerar-${caso}` }))).url);
      const pix = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id));
      const [o] = (await ordersOf(s.storeId)).filter((x) => x.id === pix.orderId);
      if (caso === "vencida") await t.ownerDb.update(appCheckoutSession).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(appCheckoutSession.id, id));
      else {
        const card = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" }));
        await move(s.storeId, card.orderId, "paid");
      }
      // A página (antes do clique) já não oferece um novo código: a sessão não serve mais.
      expect((await getOrderPublic(s.storeId, o!.publicId))!.app?.sessionId).toBeNull();
      const e = await failOf(runAction(regenerateOrderPix, pub(s.storeId), { publicId: o!.publicId }));
      expect([caso, e.code, e.details]).toEqual([caso, "conflict", { code: "SESSION_INVALID" }]);
      expect((await ordersOf(s.storeId)).find((x) => x.id === pix.orderId)!.status).toBe("expired");
    }
  });
});

describe("retomar o Pix com o QR guardado", () => {
  test("a segunda aba no mesmo Pix não busca o QR no Asaas de novo", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "qr" }))).url);
    const qrCalls = () => s.fake.calls.filter((c) => c.method === "GET" && c.path.endsWith("/pixQrCode")).length;
    const first = await startCheckout({ storeId: s.storeId }, sessionStart("start-anual", id));
    expect(qrCalls()).toBe(1);
    const again = await startCheckout({ storeId: s.storeId }, sessionStart("start-anual", id));
    expect(again.publicId).toBe(first.publicId);
    expect(qrCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Correção da 4ª rodada do PR #43

describe("página do pedido Pix depois de a sessão ser paga", () => {
  test("Pix com QR guardado e cartão pago na mesma sessão: o pedido Pix não traz QR, código nem novo código; sessão vencida idem", async () => {
    const s = await seedAppStore();
    const id = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "pix-depois", retorno: `https://${s.domain}/app` }))).url);
    const pix = await startCheckout({ storeId: s.storeId }, sessionStart("start-anual", id));
    const before = (await getOrderPublic(s.storeId, pix.publicId))!;
    expect(before.pix?.copyPaste).toBeTruthy();
    expect(before.app?.sessionClosed).toBeNull();

    const card = await runAction(checkoutStart, pub(s.storeId), sessionStart("start-anual", id, { method: "card" }));
    await move(s.storeId, card.orderId, "paid");
    const after = (await getOrderPublic(s.storeId, pix.publicId))!;
    expect(after.status).toBe("pending");
    expect(after.app).toEqual({ returnUrl: `https://${s.domain}/app`, sessionId: null, sessionClosed: "paid" });
    expect(after.pix).toBeUndefined();
    expect(after.pixUnavailable).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(before.pix!.copyPaste);

    // Sessão só vencida (nenhum pedido pago): o mesmo, com o desfecho "expired".
    const id2 = sessionIdOf((await runAction(createPayment, api(s.storeId), payment({ conta: "pix-vencido" }))).url);
    const pix2 = await startCheckout({ storeId: s.storeId }, sessionStart("start-anual", id2));
    await t.ownerDb.update(appCheckoutSession).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(appCheckoutSession.id, id2));
    const expired = (await getOrderPublic(s.storeId, pix2.publicId))!;
    expect([expired.app?.sessionClosed, expired.pix, expired.pixUnavailable]).toEqual(["expired", undefined, undefined]);
  });
});
