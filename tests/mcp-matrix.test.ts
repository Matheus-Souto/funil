// Matriz de ações do MCP (PR 6, decisões D1 a D8): quais ações pedem aprovação, os limites que só valem para ator token
// (reenvio de acesso e testes de conexão), o destino forçado dos e-mails de teste e a ativação visível do Resend.
// Nenhum literal com formato de segredo: chaves e tokens montados em tempo de execução.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { ackAlert } from "@/lib/alerts";
import { createOffer, listOffers, updateOffer } from "@/lib/catalog/offers";
import { updateProduct } from "@/lib/catalog/products";
import { resendOrder } from "@/lib/delivery/jobs";
import { saveSmtp, setMailTransportForTests, testSmtp, type SentMail } from "@/lib/delivery/mailer";
import { saveResend, setResendFetchForTests, testResend } from "@/lib/delivery/resend";
import { auditLog, mcpToken, store, storeAlert, users } from "@/lib/db/schema";
import { approveRequest, approvalStatus, requestApproval } from "@/lib/mcp/approvals";
import { saveTelegram, testTelegram } from "@/lib/notify/telegram-connection";
import { setTelegramFetchForTests } from "@/lib/notify/telegram";
import { saveMeta, setMetaFetchForTests, testMeta } from "@/lib/tracking/meta";
import { createTestDb, type TestDb } from "./db";
import { createFakeMeta } from "./fakes/meta";
import { seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setMailTransportForTests();
  await t.drop();
});

// O log vai para o stdout: captura em todos os testes (saída limpa).
let stdout: ReturnType<typeof spyOn>;
beforeEach(() => {
  stdout = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
});
afterEach(() => {
  stdout.mockRestore();
  setResendFetchForTests();
  setTelegramFetchForTests();
  setMetaFetchForTests();
});

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? e.code : String(e)));
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ActionError);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const owner: Actor = { kind: "user", userId: randomUUID(), role: "owner" };
const SMTP = { host: "smtp.exemplo.com", port: 587, secure: false, user: "loja@exemplo.com", password: randomBytes(9).toString("hex"), from: "contato@loja.com" };
const resendKey = () => ["re", randomBytes(12).toString("hex")].join("_");
const botToken = () => `${"7".repeat(9)}:${randomBytes(30).toString("hex").slice(0, 35)}`;

// SMTP falso: guarda o que "saiu".
let outbox: SentMail[] = [];
setMailTransportForTests(() => ({
  async verify() {
    return true;
  },
  async sendMail(m: SentMail) {
    outbox.push(m);
    return {};
  },
  close() {},
}));
beforeEach(() => {
  outbox = [];
});

async function seedToken(storeId: string, role: Role = "owner"): Promise<Actor> {
  const [tok] = await t.ownerDb
    .insert(mcpToken)
    .values({ storeId, name: "agente", role, tokenHash: randomBytes(32).toString("hex"), last4: "abcd" })
    .returning({ id: mcpToken.id });
  return { kind: "token", tokenId: tok!.id, role };
}

/** Loja nova (chaves de limite novas), com e-mail de avisos e um token MCP. */
async function setup(opts: { notifyEmail?: string | null } = {}) {
  const s = await seedPanelStore("Matriz");
  await t.ownerDb
    .update(store)
    .set({ notifyEmail: opts.notifyEmail === undefined ? "dono@loja.com" : opts.notifyEmail })
    .where(eq(store.id, s.storeId));
  const token = await seedToken(s.storeId);
  const asToken = { storeId: s.storeId, actor: token, origin: "mcp" as const };
  const panel = { storeId: s.storeId, actor: owner, origin: "panel" as const };
  return { s, storeId: s.storeId, token, asToken, panel };
}

describe("ações sensíveis (D1, D2, D7) e direta (D3)", () => {
  test("offers.create, offers.update e alerts.ack com ator token → approval_required; pelo painel seguem funcionando", async () => {
    const { s, asToken, panel, storeId } = await setup();
    const input = { slug: `o-${randomBytes(4).toString("hex")}`, name: "Nova", productIds: [s.mainId], priceCents: 1990, methods: ["pix" as const], pixMode: "manual" as const };
    expect(await code(runAction(createOffer, asToken, input))).toBe("approval_required");
    expect(await code(runAction(updateOffer, asToken, { id: s.offerId, name: "Outro" }))).toBe("approval_required");
    const [alert] = await t.ownerDb.insert(storeAlert).values({ storeId, kind: "telegram_falhou", detail: {} }).returning({ id: storeAlert.id });
    expect(await code(runAction(ackAlert, asToken, { id: alert!.id }))).toBe("approval_required");
    const [still] = await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.id, alert!.id));
    expect(still!.acknowledgedAt).toBeNull();

    const created = await runAction(createOffer, panel, input);
    expect(created.name).toBe("Nova");
    expect((await runAction(updateOffer, panel, { id: s.offerId, name: "Outro" })).name).toBe("Outro");
    expect(await runAction(ackAlert, panel, { id: alert!.id })).toEqual({ id: alert!.id });
  });

  test("products.update com ator token roda direto", async () => {
    const { s, asToken } = await setup();
    const out = await runAction(updateProduct, asToken, { id: s.mainId, name: "Renomeado pelo agente" });
    expect(out.name).toBe("Renomeado pelo agente");
  });

  test("offers.create pedido por token e aprovado no painel cria a oferta; o resultId do pedido é o id dela", async () => {
    const { s, asToken, panel } = await setup();
    const slug = `o-${randomBytes(4).toString("hex")}`;
    const args = { slug, name: "Pela fila", productIds: [s.mainId], priceCents: 2490, methods: ["pix"], pixMode: "manual" };
    const req = await runAction(requestApproval, asToken, { action: "offers.create", args });
    expect(req.status).toBe("pending");
    // A aprovadora é usuária de verdade (decided_by referencia users).
    const [u] = await t.ownerDb.insert(users).values({ email: `aprova-${randomUUID()}@example.com`, name: "Aprovadora", passwordHash: "x" }).returning({ id: users.id });
    await runAction(approveRequest, { ...panel, actor: { kind: "user", userId: u!.id, role: "owner" } }, { id: req.requestId });
    const [status] = (await runAction(approvalStatus, asToken, { id: req.requestId })).requests;
    expect(status!.status).toBe("approved");
    const found = (await runAction(listOffers, panel, {})).find((o) => o.slug === slug);
    expect(found).toBeDefined();
    expect(status!.resultId).toBe(found!.id);
  });
});

describe("orders.resend com limite para token (D4)", () => {
  test("2º no mesmo pedido em menos de 1 h → rate_limited; pelo painel sem limite", async () => {
    const { s, asToken, panel } = await setup();
    const order = await seedOrder(s, { status: "paid" });
    expect(await runAction(resendOrder, asToken, { orderId: order.id })).toMatchObject({ orderId: order.id });
    const err = await failure(runAction(resendOrder, asToken, { orderId: order.id, renew: true }));
    expect(err).toMatchObject({ code: "rate_limited" });
    for (let i = 0; i < 3; i++) expect(await code(runAction(resendOrder, panel, { orderId: order.id }))).toBe("ok");
  });

  test("UUID em outra caixa não ganha contador novo: 2º reenvio com maiúsculas na mesma hora → rate_limited", async () => {
    const { s, asToken } = await setup();
    const order = await seedOrder(s, { status: "paid" });
    expect(await code(runAction(resendOrder, asToken, { orderId: order.id.toLowerCase() }))).toBe("ok");
    expect(await code(runAction(resendOrder, asToken, { orderId: order.id.toUpperCase() }))).toBe("rate_limited");
  });

  test("limite por loja: 20 pedidos distintos por hora passam, o 21º → rate_limited", async () => {
    const { s, asToken } = await setup();
    for (let i = 0; i < 20; i++) {
      const o = await seedOrder(s, { status: "paid" });
      expect(await code(runAction(resendOrder, asToken, { orderId: o.id }))).toBe("ok");
    }
    const last = await seedOrder(s, { status: "paid" });
    expect(await code(runAction(resendOrder, asToken, { orderId: last.id }))).toBe("rate_limited");
  });
});

describe("testes de conexão (D5, D6)", () => {
  test("testSmtp com ator token manda para notifyEmail mesmo com outro to; sem notifyEmail → conflict; 6º na hora → rate_limited", async () => {
    const { storeId, asToken, panel } = await setup();
    await runAction(saveSmtp, panel, SMTP);
    expect(await runAction(testSmtp, asToken, { to: "outro@fora.com" })).toEqual({ sent: true });
    expect(outbox.map((m) => m.to)).toEqual(["dono@loja.com"]);
    for (let i = 0; i < 4; i++) await runAction(testSmtp, asToken, {});
    expect(await code(runAction(testSmtp, asToken, {}))).toBe("rate_limited");
    expect(outbox).toHaveLength(5);

    const semAviso = await setup({ notifyEmail: null });
    await runAction(saveSmtp, semAviso.panel, SMTP);
    const err = await failure(runAction(testSmtp, semAviso.asToken, { to: "outro@fora.com" }));
    expect(err).toMatchObject({ code: "conflict", message: "Defina o e-mail de avisos da loja para testar pelo agente" });
    expect(outbox).toHaveLength(5);

    // Pelo painel: o `to` é obrigatório e vale; sem ele, invalid_input; sem limite.
    expect(await code(runAction(testSmtp, panel, {}))).toBe("invalid_input");
    for (let i = 0; i < 6; i++) await runAction(testSmtp, panel, { to: "eu@exemplo.com" });
    expect(outbox.filter((m) => m.to === "eu@exemplo.com")).toHaveLength(6);
    void storeId;
  });

  test("testResend idem: destino forçado, conflict sem notifyEmail, 6º na hora → rate_limited", async () => {
    const { asToken, panel } = await setup();
    await runAction(saveResend, panel, { fromEmail: "vendas@loja.com", apiKey: resendKey() });
    const bodies: { to: string[] }[] = [];
    setResendFetchForTests((async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json(200, { id: "msg_teste" });
    }) as typeof fetch);
    expect(await runAction(testResend, asToken, { to: "outro@fora.com" })).toEqual({ sent: true });
    expect(bodies.map((b) => b.to)).toEqual([["dono@loja.com"]]);
    for (let i = 0; i < 4; i++) await runAction(testResend, asToken, {});
    expect(await code(runAction(testResend, asToken, {}))).toBe("rate_limited");
    expect(bodies).toHaveLength(5);

    const semAviso = await setup({ notifyEmail: null });
    await runAction(saveResend, semAviso.panel, { fromEmail: "vendas@loja.com", apiKey: resendKey() });
    expect(await failure(runAction(testResend, semAviso.asToken, { to: "outro@fora.com" }))).toMatchObject({ code: "conflict" });
    expect(bodies).toHaveLength(5);

    expect(await code(runAction(testResend, panel, {}))).toBe("invalid_input");
    expect(await runAction(testResend, panel, { to: "eu@exemplo.com" })).toEqual({ sent: true });
    expect(bodies.at(-1)!.to).toEqual(["eu@exemplo.com"]);
  });

  test("testTelegram e testMeta: 6º na hora → rate_limited (painel sem limite)", async () => {
    const { storeId, asToken, panel } = await setup();
    const token = botToken();
    setTelegramFetchForTests((async (url: string | URL | Request) =>
      String(url).endsWith("/getMe") ? json(200, { ok: true, result: { username: "loja_bot" } }) : json(200, { ok: true, result: { message_id: 1 } })) as typeof fetch);
    await runAction(saveTelegram, panel, { chatId: "-1001234567890", token });
    for (let i = 0; i < 5; i++) expect(await runAction(testTelegram, asToken, {})).toEqual({ sent: true });
    expect(await code(runAction(testTelegram, asToken, {}))).toBe("rate_limited");
    expect(await runAction(testTelegram, panel, {})).toEqual({ sent: true });

    const meta = createFakeMeta();
    setMetaFetchForTests(meta.fetch);
    await runAction(saveMeta, panel, { pixelId: "1234567890123", accessToken: meta.token });
    for (let i = 0; i < 5; i++) expect(await runAction(testMeta, asToken, {})).toEqual({ ok: true });
    expect(await code(runAction(testMeta, asToken, {}))).toBe("rate_limited");
    expect(await runAction(testMeta, panel, {})).toEqual({ ok: true });
    void storeId;
  });
});

describe("saveResend visível (D8)", () => {
  test("pelo painel em loja sem SMTP: audit_log com result.activated = true; a descrição menciona a ativação", async () => {
    const { storeId, panel } = await setup();
    const out = await runAction(saveResend, panel, { fromEmail: "vendas@loja.com", apiKey: resendKey() });
    expect(out.activated).toBe(true);
    const rows = (await t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId))).filter((a) => a.action === "connections.saveResend");
    expect(rows).toHaveLength(1);
    expect((rows[0]!.input as { result: unknown }).result).toEqual({ activated: true });
    expect(JSON.stringify(rows[0]!.input)).not.toContain("re_");
    expect(saveResend.description).toContain("ativa");
  });
});
