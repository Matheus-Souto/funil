import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { ackAlert, alertSeller, listAlerts, listDeliveryFailures } from "@/lib/alerts";
import { connectionsStatus } from "@/lib/connections";
import { withStore } from "@/lib/db/client";
import { auditLog, downloadLink, emailLog, job, offer, payment, rateLimit, store, storeAlert } from "@/lib/db/schema";
import { centsToInput, parseBrl } from "@/lib/format";
import { saveIntegration } from "@/lib/integrations";
import { enqueue } from "@/lib/jobs";
import { pixManualExpiry } from "@/lib/orders/labels";
import { allowedOrderActions, csvCell, exportOrders, getOrderDetail, listOrders, maskCpf, orderCounts, ordersCsv } from "@/lib/orders/panel";
import { firstParam, parseOrderFilters } from "@/lib/panel-params";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { alertAsaasKeyRejected } from "@/lib/payments/asaas/webhook";
import { releaseOrder } from "@/lib/payments/manual";
import { getStoreSettings, updateStoreSettings } from "@/lib/store-settings";
import { createTestDb, type TestDb } from "./db";
import { createFakeAsaas } from "./fakes/asaas";
import { panelCall, seedManyOrders, seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setAsaasFetchForTests();
  await t.drop();
});
afterEach(() => setAsaasFetchForTests());

const codeOf = (e: unknown) => (e instanceof ActionError ? e.code : String(e));
const fails = (p: Promise<unknown>) => p.then(() => "ok", codeOf);

describe("orders.list", () => {
  test("traffic recebe forbidden; support, admin e owner leem", async () => {
    const s = await seedPanelStore();
    expect(await fails(runAction(listOrders, panelCall(s.storeId, "traffic"), { page: 1 }))).toBe("forbidden");
    for (const role of ["support", "admin", "owner"] as const) {
      expect(await fails(runAction(listOrders, panelCall(s.storeId, role), { page: 1 }))).toBe("ok");
    }
  });

  test("50 por página, mais recentes primeiro, total e contagem por status", async () => {
    const s = await seedPanelStore();
    await seedOrder(s, { status: "pending", createdAt: new Date(Date.now() - 100 * 60_000) });
    await seedManyOrders(s, 50, new Date(Date.now() - 60 * 60_000));
    const p1 = await runAction(listOrders, panelCall(s.storeId), { page: 1 });
    expect(p1.items).toHaveLength(50);
    expect(p1.total).toBe(51);
    expect(p1.pageSize).toBe(50);
    expect(p1.items[0]!.createdAt.getTime()).toBeGreaterThan(p1.items[1]!.createdAt.getTime());
    expect(p1.counts).toMatchObject({ all: 51, paid: 50, pending: 1 });
    const p2 = await runAction(listOrders, panelCall(s.storeId), { page: 2 });
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0]!.status).toBe("pending");
  });

  test("filtros de status e método; busca por e-mail ou nome (sem diferenciar maiúsculas); nada de CPF na lista", async () => {
    const s = await seedPanelStore();
    await seedOrder(s, { status: "pending", method: "pix_manual", name: "Juliana Ramos", email: "juliana.ramos@hotmail.com", cpf: "52998224725" });
    await seedOrder(s, { status: "paid", method: "card_asaas", name: "Rafael Oliveira", email: "rafa@gmail.com", cpf: "52998224725" });
    const pending = await runAction(listOrders, panelCall(s.storeId), { page: 1, status: "pending" });
    expect(pending.items.map((o) => o.buyerName)).toEqual(["Juliana Ramos"]);
    expect(pending.counts).toMatchObject({ all: 2, pending: 1, paid: 1 });
    const card = await runAction(listOrders, panelCall(s.storeId), { page: 1, method: "card_asaas" });
    expect(card.items.map((o) => o.buyerName)).toEqual(["Rafael Oliveira"]);
    expect((await runAction(listOrders, panelCall(s.storeId), { page: 1, q: "JULIANA" })).items).toHaveLength(1);
    expect((await runAction(listOrders, panelCall(s.storeId), { page: 1, q: "rafa@gm" })).items).toHaveLength(1);
    expect((await runAction(listOrders, panelCall(s.storeId), { page: 1, q: "ninguém" })).items).toHaveLength(0);
    // Curingas do LIKE são texto comum.
    expect((await runAction(listOrders, panelCall(s.storeId), { page: 1, q: "%" })).items).toHaveLength(0);
    const all = await runAction(listOrders, panelCall(s.storeId), { page: 1 });
    expect(JSON.stringify(all)).not.toContain("52998224725");
    expect(all.items[0]).not.toHaveProperty("buyerCpf");
  });

  test("isolamento: não lista pedidos de outra loja", async () => {
    const a = await seedPanelStore("A");
    const b = await seedPanelStore("B");
    await seedOrder(b, {});
    expect((await runAction(listOrders, panelCall(a.storeId), { page: 1 })).total).toBe(0);
  });
});

describe("orders.counts", () => {
  test("Pix manual aguardando liberação (pendente e não vencido)", async () => {
    const s = await seedPanelStore();
    await seedOrder(s, { status: "pending", method: "pix_manual" });
    await seedOrder(s, { status: "pending", method: "pix_manual", totalCents: 991 });
    await seedOrder(s, { status: "pending", method: "pix_asaas" });
    await seedOrder(s, { status: "paid", method: "pix_manual", totalCents: 992 });
    expect(await runAction(orderCounts, panelCall(s.storeId, "support"), {})).toEqual({ pendingManual: 2 });
  });
});

describe("orders.get", () => {
  test("detalhe: itens, pagamentos com marcações, links, e-mails, CPF mascarado e histórico da auditoria", async () => {
    const s = await seedPanelStore();
    const o = await seedOrder(s, { status: "pending", method: "pix_manual", hasBump: true, cpf: "52998224725", utmSource: "ig", ref: "joao" });
    await withStore(s.storeId, (tx) => saveIntegration(tx, s.storeId, "pix_manual", { key: "contato@manakids.com.br", name: "MANA KIDS", city: "SAO PAULO" }));
    await runAction(releaseOrder, panelCall(s.storeId), { orderId: o.id });
    await t.ownerDb.insert(payment).values([
      { storeId: s.storeId, orderId: o.id, provider: "asaas", providerId: "pay_dup", status: "RECEIVED", amountCents: 2700, raw: { duplicate: true } },
      { storeId: s.storeId, orderId: o.id, provider: "asaas", providerId: "pay_old", status: "superseded", amountCents: 2700 },
    ]);
    await t.ownerDb.insert(downloadLink).values({
      storeId: s.storeId,
      orderId: o.id,
      productId: s.mainId,
      expiresAt: new Date(Date.now() + 86_400_000),
      downloads: 2,
      revokedAt: new Date(),
      revokedReason: "renewed",
    });
    await t.ownerDb.insert(emailLog).values([
      { storeId: s.storeId, orderId: o.id, toHash: "x", kind: "delivery", status: "failed", error: "ECONNREFUSED", at: new Date(Date.now() - 60_000) },
      { storeId: s.storeId, orderId: o.id, toHash: "x", kind: "delivery", status: "sent", at: new Date() },
    ]);

    const d = await runAction(getOrderDetail, panelCall(s.storeId, "support"), { id: o.id });
    expect(d.status).toBe("paid");
    expect(d.buyer.cpfMasked).toBe("***.982.247-**");
    expect(JSON.stringify(d)).not.toContain("52998224725");
    expect(d.items.map((i) => [i.name, i.kind, i.priceCents])).toEqual([
      ["Maná básica", "main", 990],
      ["Maná completa", "bump", 1710],
    ]);
    expect(d.pix).toEqual({ key: "contato@manakids.com.br", receiver: "MANA KIDS", amountCents: o.manualAmountCents });
    const flags = Object.fromEntries(d.payments.map((p) => [p.providerId ?? p.provider, p.flags]));
    expect(flags).toEqual({ manual: [], pay_dup: ["duplicate"], pay_old: ["superseded"] });
    expect(d.links).toEqual([expect.objectContaining({ productName: "Maná básica", downloads: 2, maxDownloads: 5, revokedReason: "renewed" })]);
    expect(d.emails.map((e) => [e.kind, e.status])).toEqual([
      ["delivery", "failed"],
      ["delivery", "sent"],
    ]);
    // Sem connections.read (support): só "falha no envio", nunca o texto do SMTP.
    expect(d.emails[0]!.error).toBe("falha no envio");
    expect(JSON.stringify(d)).not.toContain("ECONNREFUSED");
    const asOwner = await runAction(getOrderDetail, panelCall(s.storeId), { id: o.id });
    expect(asOwner.emails[0]!.error).toBe("ECONNREFUSED");
    expect(d.attribution).toMatchObject({ lastTouch: { utm_source: "ig" }, ref: "joao" });
    const release = d.timeline.find((e) => e.kind === "orders.release");
    expect(release).toMatchObject({ label: "Liberado manualmente", actorRole: "owner" });
    expect(d.timeline.some((e) => e.kind === "created")).toBe(true);
  });

  test("estorno: solicitado com job aberto; pendente sem processamento quando não há job nem pedido ao Asaas", async () => {
    const s = await seedPanelStore();
    const withJob = await seedOrder(s, { status: "paid", refundRequestedAt: new Date() });
    await withStore(s.storeId, (tx) => enqueue(tx, { storeId: s.storeId, type: "refund_order", payload: { orderId: withJob.id } }));
    const a = await runAction(getOrderDetail, panelCall(s.storeId), { id: withJob.id });
    expect(a.refund).toMatchObject({ state: "processing" });

    const sent = await seedOrder(s, { status: "paid", refundRequestedAt: new Date(Date.now() - 60_000) });
    await t.ownerDb.insert(payment).values({
      storeId: s.storeId,
      orderId: sent.id,
      provider: "asaas",
      providerId: "pay_sent",
      status: "RECEIVED",
      amountCents: 990,
      raw: { refundPost: { at: new Date().toISOString(), before: 0, acceptedAt: new Date().toISOString() } },
    });
    expect((await runAction(getOrderDetail, panelCall(s.storeId), { id: sent.id })).refund).toMatchObject({ state: "awaiting_provider" });

    // Marca sem aceite (POST sem resposta 2xx): não diz "aguardando o Asaas".
    const unaccepted = await seedOrder(s, { status: "paid", refundRequestedAt: new Date(Date.now() - 60_000) });
    await t.ownerDb.insert(payment).values({
      storeId: s.storeId,
      orderId: unaccepted.id,
      provider: "asaas",
      providerId: "pay_unaccepted",
      status: "RECEIVED",
      amountCents: 990,
      raw: { refundPost: { at: new Date().toISOString(), before: 0 } },
    });
    expect((await runAction(getOrderDetail, panelCall(s.storeId), { id: unaccepted.id })).refund).toMatchObject({ state: "stale" });

    const stale = await seedOrder(s, { status: "paid", refundRequestedAt: new Date() });
    expect((await runAction(getOrderDetail, panelCall(s.storeId), { id: stale.id })).refund).toMatchObject({ state: "stale" });

    const none = await seedOrder(s, { status: "paid" });
    expect((await runAction(getOrderDetail, panelCall(s.storeId), { id: none.id })).refund).toMatchObject({ state: "none" });
  });

  test("pedido de outra loja: not_found", async () => {
    const a = await seedPanelStore("A");
    const b = await seedPanelStore("B");
    const o = await seedOrder(b, {});
    expect(await fails(runAction(getOrderDetail, panelCall(a.storeId), { id: o.id }))).toBe("not_found");
  });
});

describe("botões do pedido por papel", () => {
  const paid = { status: "paid" as const, method: "card_asaas" as const, refund: { state: "none" as const } };
  const pendingManual = { status: "pending" as const, method: "pix_manual" as const, refund: { state: "none" as const } };
  test("support não vê Reembolsar nem Liberar; vê Reenviar", () => {
    expect(allowedOrderActions("support", paid)).toEqual({ release: false, resend: true, refund: false });
    expect(allowedOrderActions("support", pendingManual)).toEqual({ release: false, resend: false, refund: false });
  });
  test("owner e admin: Liberar só no Pix manual pendente/expirado; Reembolsar só pago e sem estorno em andamento", () => {
    expect(allowedOrderActions("owner", pendingManual)).toEqual({ release: true, resend: false, refund: false });
    expect(allowedOrderActions("admin", { ...pendingManual, status: "expired" })).toMatchObject({ release: true });
    expect(allowedOrderActions("owner", paid)).toEqual({ release: false, resend: true, refund: true });
    expect(allowedOrderActions("owner", { ...paid, refund: { state: "processing" } })).toMatchObject({ refund: false });
    expect(allowedOrderActions("owner", { ...paid, refund: { state: "stale" } })).toMatchObject({ refund: true });
    expect(allowedOrderActions("owner", { ...paid, status: "refunded" })).toEqual({ release: false, resend: false, refund: false });
  });
  test("Liberar no Pix Asaas só com cobrança da conta anterior que teve evento (comprador pode ter pago lá)", () => {
    const asaas = { status: "pending" as const, method: "pix_asaas" as const, refund: { state: "none" as const } };
    const oldPaid = { flags: ["superseded", "old_account_event"] as ("superseded" | "old_account_event")[] };
    expect(allowedOrderActions("owner", { ...asaas, payments: [oldPaid] })).toMatchObject({ release: true });
    expect(allowedOrderActions("owner", { ...asaas, status: "expired", payments: [oldPaid] })).toMatchObject({ release: true });
    expect(allowedOrderActions("owner", { ...asaas, payments: [{ flags: ["superseded"] }] })).toMatchObject({ release: false });
    expect(allowedOrderActions("owner", { ...asaas, payments: [] })).toMatchObject({ release: false });
    expect(allowedOrderActions("owner", { ...asaas, method: "card_asaas", payments: [oldPaid] })).toMatchObject({ release: false });
    expect(allowedOrderActions("support", { ...asaas, payments: [oldPaid] })).toMatchObject({ release: false });
  });
  test("traffic não vê nenhum", () => {
    expect(allowedOrderActions("traffic", paid)).toEqual({ release: false, resend: false, refund: false });
  });
});

describe("exportação CSV", () => {
  test("colunas do brief, sem CPF; fórmulas neutralizadas; support sem orders.export", async () => {
    const s = await seedPanelStore();
    await seedOrder(s, { status: "paid", hasBump: true, name: "=HYPERLINK(\"x\")", cpf: "52998224725", utmSource: "ig", utmCampaign: "stories", ref: "joao" });
    expect(await fails(runAction(exportOrders, panelCall(s.storeId, "support"), {}))).toBe("forbidden");
    const rows = await runAction(exportOrders, panelCall(s.storeId, "admin"), {});
    const csv = ordersCsv(rows);
    const [header, line] = csv.trim().split("\r\n");
    expect(header).toBe('"data";"status";"método";"produto(s)";"valor";"nome";"e-mail";"telefone";"utm_source";"utm_campaign";"ref"');
    expect(csv).not.toContain("52998224725");
    expect(csv).not.toMatch(/cpf/i);
    expect(line).toContain("Maná básica + Maná completa");
    expect(line).toContain("27,00");
    expect(line).toContain(';"ig";"stories";"joao"');
    expect(line).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    // Todo campo entre aspas: nenhuma vírgula ou ponto e vírgula vira separador em nenhuma configuração do Excel.
    expect(line!.split(";").every((f) => f.startsWith('"') && f.endsWith('"'))).toBe(true);
  });
});

describe("parseBrl (preço digitado no painel)", () => {
  test("vírgula decimal, milhar com ponto, inteiro e ponto decimal", () => {
    expect(parseBrl("9,90")).toBe(990);
    expect(parseBrl("R$ 1.284,70")).toBe(128470);
    expect(parseBrl("27")).toBe(2700);
    expect(parseBrl("9.9")).toBe(990);
    expect(parseBrl("1.284")).toBe(128400);
    expect(parseBrl("0,05")).toBe(5);
    for (const bad of ["", "abc", "9,999", "1,2,3", "-5"]) expect(parseBrl(bad)).toBeNull();
    expect(centsToInput(1710)).toBe("17,10");
  });
});

describe("csvCell (fórmulas neutralizadas com qualquer separador)", () => {
  test("toda célula entre aspas; apóstrofo quando começa com =,+,-,@,tab,CR ou tem um gatilho logo depois de , ou ;", () => {
    expect(csvCell("ig")).toBe('"ig"');
    expect(csvCell("=1+1")).toBe(`"'=1+1"`);
    expect(csvCell("-2")).toBe(`"'-2"`);
    expect(csvCell("Ana,=HYPERLINK(\"x\")")).toBe(`"'Ana,=HYPERLINK(""x"")"`);
    expect(csvCell("a; @SUM(A1)")).toBe(`"'a; @SUM(A1)"`);
    expect(csvCell("Maná básica + Maná completa")).toBe('"Maná básica + Maná completa"');
    expect(csvCell("27,00")).toBe('"27,00"');
  });
});

describe("parâmetros repetidos na URL", () => {
  test("pega o primeiro valor; status/método inválidos são ignorados; página inválida vira 1", () => {
    expect(firstParam(["a", "b"])).toBe("a");
    expect(firstParam("x")).toBe("x");
    expect(firstParam(undefined)).toBeUndefined();
    expect(parseOrderFilters({ q: ["ana", "bia"], status: ["paid", "pending"], method: ["pix_manual", "x"], pagina: ["2", "3"] })).toEqual({
      q: "ana",
      status: "paid",
      method: "pix_manual",
      page: 2,
    });
    expect(parseOrderFilters({ status: "nada", method: ["?"], pagina: "abc", q: "  " })).toEqual({ q: undefined, status: undefined, method: undefined, page: 1 });
  });
});

describe("Pix manual vencido", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const past = new Date("2026-11-18T11:00:00Z");
  test("expirado ou pendente com validade passada (ainda não varrido) conta como vencido, com reserva de 48 h", () => {
    expect(pixManualExpiry({ method: "pix_manual", status: "expired", expiresAt: past }, now)).toEqual({ expired: true, reservedUntil: new Date("2026-11-20T11:00:00Z") });
    expect(pixManualExpiry({ method: "pix_manual", status: "pending", expiresAt: past }, now)).toEqual({ expired: true, reservedUntil: new Date("2026-11-20T11:00:00Z") });
    expect(pixManualExpiry({ method: "pix_manual", status: "pending", expiresAt: new Date("2026-11-18T13:00:00Z") }, now)).toEqual({ expired: false, reservedUntil: null });
    expect(pixManualExpiry({ method: "pix_asaas", status: "expired", expiresAt: past }, now)).toEqual({ expired: false, reservedUntil: null });
  });
});

describe("maskCpf", () => {
  test("mostra só os dígitos do meio", () => {
    expect(maskCpf("52998224725")).toBe("***.982.247-**");
    expect(maskCpf(null)).toBeNull();
    expect(maskCpf("123")).toBe("***");
  });
});

describe("store.updateSettings / store.getSettings", () => {
  test("owner salva nome, e-mail de aviso e cor; admin recebe forbidden; cor inválida recusada", async () => {
    const s = await seedPanelStore();
    const out = await runAction(updateStoreSettings, panelCall(s.storeId), { name: " Maná Kids ", notifyEmail: "Contato@ManaKids.com.br", brandColor: "#2d55c8" });
    expect(out).toEqual({ name: "Maná Kids", notifyEmail: "contato@manakids.com.br", brandColor: "#2D55C8" });
    const [row] = await t.ownerDb.select().from(store).where(eq(store.id, s.storeId));
    expect(row).toMatchObject({ name: "Maná Kids", notifyEmail: "contato@manakids.com.br", brandColor: "#2D55C8" });
    expect(await fails(runAction(updateStoreSettings, panelCall(s.storeId, "admin"), { name: "X", notifyEmail: null }))).toBe("forbidden");
    expect(await fails(runAction(updateStoreSettings, panelCall(s.storeId), { name: "X", notifyEmail: null, brandColor: "azul" }))).toBe("invalid_input");
    // Sem e-mail e cor padrão.
    await runAction(updateStoreSettings, panelCall(s.storeId), { name: "Maná Kids", notifyEmail: null, brandColor: null });
    const got = await runAction(getStoreSettings, panelCall(s.storeId, "traffic"), {});
    expect(got).toMatchObject({ name: "Maná Kids", notifyEmail: null, brandColor: null });
    expect(got.trackingSnippet).toMatch(/^<script src="http:\/\/localhost:3000\/t\.js" data-checkout="localhost:3000" defer><\/script>$/);
    expect(got.checkoutBaseUrl).toBe("http://localhost:3000");
  });

  test("a auditoria registra a mudança", async () => {
    const s = await seedPanelStore();
    await runAction(updateStoreSettings, panelCall(s.storeId), { name: "Loja Nova", notifyEmail: null });
    const rows = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "store.updateSettings")));
    expect(rows).toHaveLength(1);
  });
});

describe("connections.status", () => {
  test("segredos nunca saem: só 'configurado'; token do webhook só para quem pode salvar conexões", async () => {
    const fake = createFakeAsaas();
    setAsaasFetchForTests(fake.fetch);
    const s = await seedPanelStore();
    const saved = await runAction(saveAsaas, panelCall(s.storeId), { env: "sandbox", apiKey: fake.apiKey });
    await withStore(s.storeId, async (tx) => {
      await saveIntegration(tx, s.storeId, "smtp", { host: "smtp.exemplo.com", port: 587, secure: false, user: "u@exemplo.com", from: "loja@exemplo.com" }, "senha-smtp-secreta");
      await saveIntegration(tx, s.storeId, "meta", { pixelId: "1234567890", testEventCode: "TEST1" }, "token-meta-secreto");
      await saveIntegration(tx, s.storeId, "pix_manual", { key: "contato@manakids.com.br", name: "MANA KIDS", city: "SAO PAULO" });
    });
    const owner = await runAction(connectionsStatus, panelCall(s.storeId), {});
    const text = JSON.stringify(owner);
    for (const secret of [fake.apiKey, "senha-smtp-secreta", "token-meta-secreto"]) expect(text).not.toContain(secret);
    expect(owner.asaas).toEqual({ env: "sandbox", apiKey: "configured", webhookUrl: saved.webhookUrl, webhookToken: saved.webhookToken });
    expect(owner.smtp).toEqual({ host: "smtp.exemplo.com", port: 587, secure: false, user: "u@exemplo.com", from: "loja@exemplo.com", password: "configured" });
    expect(owner.meta).toEqual({ pixelId: "1234567890", testEventCode: "TEST1", accessToken: "configured" });
    expect(owner.pixManual).toEqual({ key: "contato@manakids.com.br", name: "MANA KIDS", city: "SAO PAULO" });

    const traffic = await runAction(connectionsStatus, panelCall(s.storeId, "traffic"), {});
    expect(traffic.asaas).toEqual({ env: "sandbox", apiKey: "configured", webhookUrl: saved.webhookUrl, webhookToken: null });
    expect(await fails(runAction(connectionsStatus, panelCall(s.storeId, "support"), {}))).toBe("forbidden");
  });

  test("Turnstile: recomendado quando não está configurado e há oferta ativa com cartão", async () => {
    const s = await seedPanelStore(); // oferta ativa com pix e cartão; os testes rodam sem TURNSTILE_SECRET
    expect((await runAction(connectionsStatus, panelCall(s.storeId), {})).turnstile).toEqual({ configured: false, recommended: true });
    await t.ownerDb.update(offer).set({ methods: ["pix"] }).where(eq(offer.id, s.offerId));
    expect((await runAction(connectionsStatus, panelCall(s.storeId), {})).turnstile).toEqual({ configured: false, recommended: false });
    await t.ownerDb.update(offer).set({ methods: ["pix", "card"], active: false }).where(eq(offer.id, s.offerId));
    expect((await runAction(connectionsStatus, panelCall(s.storeId), {})).turnstile).toEqual({ configured: false, recommended: false });
  });

  test("loja sem conexões: tudo null", async () => {
    const s = await seedPanelStore();
    expect(await runAction(connectionsStatus, panelCall(s.storeId), {})).toMatchObject({ pixManual: null, asaas: null, smtp: null, meta: null });
  });
});

describe("avisos da loja (store_alert)", () => {
  test("alertSeller grava o aviso e enfileira notify_seller na mesma transação; lista e 'ok' escondem", async () => {
    const s = await seedPanelStore();
    const o = await seedOrder(s, {});
    await withStore(s.storeId, (tx) => alertSeller(tx, s.storeId, "estorno_cancelado", { orderId: o.id }));
    await withStore(s.storeId, (tx) => alertSeller(tx, s.storeId, "chave_asaas_invalida", { httpStatus: 401 }));
    const jobs = await t.ownerDb
      .select()
      .from(job)
      .where(and(eq(job.type, "notify_seller"), eq(job.storeId, s.storeId)));
    expect(jobs.map((j) => j.payload).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { httpStatus: 401, reason: "chave_asaas_invalida" },
      { orderId: o.id, reason: "estorno_cancelado" },
    ]);

    const list = await runAction(listAlerts, panelCall(s.storeId, "traffic"), {});
    expect(list.alerts.map((a) => a.kind).sort()).toEqual(["chave_asaas_invalida", "estorno_cancelado"]);
    const cancelled = list.alerts.find((a) => a.kind === "estorno_cancelado")!;
    expect(cancelled.orderId).toBe(o.id);
    expect(cancelled.title).toContain("Estorno cancelado");

    // "ok" exige connections.write: admin (só connections.read) não confirma.
    expect(await fails(runAction(ackAlert, panelCall(s.storeId, "admin"), { id: cancelled.id }))).toBe("forbidden");
    await runAction(ackAlert, panelCall(s.storeId), { id: cancelled.id });
    expect((await runAction(listAlerts, panelCall(s.storeId), {})).alerts.map((a) => a.kind)).toEqual(["chave_asaas_invalida"]);
    expect(await fails(runAction(listAlerts, panelCall(s.storeId, "support"), {}))).toBe("forbidden");
    // Outra loja não vê nem confirma.
    const other = await seedPanelStore("B");
    expect((await runAction(listAlerts, panelCall(other.storeId), {})).alerts).toEqual([]);
    const key = list.alerts.find((a) => a.kind === "chave_asaas_invalida")!;
    expect(await fails(runAction(ackAlert, panelCall(other.storeId), { id: key.id }))).toBe("not_found");
  });

  test("entregas que falharam (último e-mail de entrega com falha) aparecem até um envio dar certo", async () => {
    const s = await seedPanelStore();
    const o = await seedOrder(s, { status: "paid" });
    await t.ownerDb.insert(emailLog).values({ storeId: s.storeId, orderId: o.id, toHash: "x", kind: "delivery", status: "failed", error: "ECONNREFUSED" });
    const before = await runAction(listAlerts, panelCall(s.storeId), {});
    expect(before.failedDeliveries.map((f) => f.orderId)).toEqual([o.id]);
    // Quem tem orders.read (support, sem connections.read) também vê as entregas com falha.
    expect((await runAction(listDeliveryFailures, panelCall(s.storeId, "support"), {})).map((f) => f.orderId)).toEqual([o.id]);
    expect(await fails(runAction(listDeliveryFailures, panelCall(s.storeId, "traffic"), {}))).toBe("forbidden");
    await t.ownerDb.insert(emailLog).values({ storeId: s.storeId, orderId: o.id, toHash: "x", kind: "delivery", status: "sent", at: new Date(Date.now() + 1000) });
    expect((await runAction(listAlerts, panelCall(s.storeId), {})).failedDeliveries).toEqual([]);
    expect(await runAction(listDeliveryFailures, panelCall(s.storeId, "support"), {})).toEqual([]);
  });

  test("os caminhos que avisam o vendedor gravam o aviso do painel (ex.: chave do Asaas recusada)", async () => {
    const s = await seedPanelStore();
    await runAction(alertAsaasKeyRejected, { storeId: s.storeId, actor: { kind: "system" }, origin: "system" }, { httpStatus: 403 });
    const rows = await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, s.storeId));
    expect(rows.map((r) => [r.kind, r.detail])).toEqual([["chave_asaas_invalida", { httpStatus: 403 }]]);
    const list = await runAction(listAlerts, panelCall(s.storeId), {});
    expect(list.alerts[0]!.title).toBe("O Asaas recusou a chave de API da loja (HTTP 403)");
  });

  test("aviso de chave recusada: o contador do limite usa a transação da ação (sem 2ª conexão; rollback desfaz)", async () => {
    const s = await seedPanelStore();
    const key = `asaas:key_rejected:${s.storeId}`;
    const ctx = (tx: Parameters<Parameters<typeof withStore>[1]>[0]) => ({ storeId: s.storeId, actor: { kind: "system" as const }, origin: "system" as const, tx });
    const rollback = new Error("rollback");
    await withStore(s.storeId, async (tx) => {
      expect(await alertAsaasKeyRejected.run(ctx(tx), { httpStatus: 401 }, undefined)).toEqual({ alerted: true });
      throw rollback;
    }).catch((e: unknown) => {
      if (e !== rollback) throw e;
    });
    // Contador e aviso saíram na mesma transação: o rollback desfez os dois.
    expect(await t.ownerDb.select().from(rateLimit).where(eq(rateLimit.key, key))).toHaveLength(0);
    expect(await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, s.storeId))).toHaveLength(0);
    await withStore(s.storeId, async (tx) => {
      expect(await alertAsaasKeyRejected.run(ctx(tx), { httpStatus: 401 }, undefined)).toEqual({ alerted: true });
      expect(await alertAsaasKeyRejected.run(ctx(tx), { httpStatus: 401 }, undefined)).toEqual({ alerted: false });
    });
    expect((await t.ownerDb.select().from(rateLimit).where(eq(rateLimit.key, key)))[0]!.count).toBe(2);
  });

  test("store_alert tem RLS (outra loja não lê a linha)", async () => {
    const a = await seedPanelStore("A");
    const b = await seedPanelStore("B");
    await withStore(a.storeId, (tx) => alertSeller(tx, a.storeId, "disjuntor_cartao"));
    const rows = await withStore(b.storeId, (tx) => tx.select().from(storeAlert));
    expect(rows).toEqual([]);
    const count = await t.ownerDb.execute(sql`select relforcerowsecurity as f from pg_class where relname = 'store_alert'`);
    expect((count as unknown as { f: boolean }[])[0]!.f).toBe(true);
  });
});
