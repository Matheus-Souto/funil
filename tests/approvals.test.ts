// Fila de aprovação do MCP (src/lib/mcp/approvals.ts e approval-summary.ts): pedido do token (selado, resumo mascarado,
// limites e deduplicação), leitura pelo token (approvals.status) e pelo painel (approvals.list/pendingCount), decisão
// (approve executa a ação-alvo com o aprovador; reject), cancelamento ao revogar o token e a varredura sweep_mcp.
// Nenhum literal com formato de segredo: chaves e tokens montados em tempo de execução.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, runAction, TOKEN_DENIED, type Action, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { registry } from "@/lib/actions/registry";
import { updateOffer } from "@/lib/catalog/offers";
import { open, seal, sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { approvalRequest, auditLog, job, mcpToken, offer, uploadLink, users } from "@/lib/db/schema";
import { orderCode } from "@/lib/format";
import { runDueJobs, enqueue } from "@/lib/jobs";
import { getHandlers } from "@/lib/jobs/handlers";
import { SECRET_FIELDS, SHOWN_IN_FULL, summarizeRequest } from "@/lib/mcp/approval-summary";
import {
  approvalStatus,
  approveRequest,
  listApprovals,
  pendingApprovalsCount,
  rejectRequest,
  requestApproval,
} from "@/lib/mcp/approvals";
import { revokeMcpToken } from "@/lib/mcp/tokens";
import { setTelegramFetchForTests } from "@/lib/notify/telegram";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { createTestDb, type TestDb } from "./db";
import { createFakeAsaas } from "./fakes/asaas";
import { seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

// O log vai para o stdout: captura em todos os testes (saída limpa) e o teste dos segredos confere o conteúdo.
let out = "";
let stdout: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = "";
  stdout = spyOn(process.stdout, "write").mockImplementation(((s: string) => ((out += String(s)), true)) as never);
});
afterEach(() => {
  stdout.mockRestore();
  setTelegramFetchForTests();
  setAsaasFetchForTests();
});

const DAY_MS = 86_400_000;
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? e.code : String(e)));
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ActionError);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Segredos no formato que as ações aceitam, montados em tempo de execução.
const resendKey = () => ["re", randomBytes(12).toString("hex")].join("_");
const resendWebhookSecret = () => ["whsec", randomBytes(18).toString("base64")].join("_");
const botToken = () => `${"7".repeat(9)}:${randomBytes(30).toString("hex").slice(0, 35)}`;

async function seedUser(name = "Aprovadora"): Promise<string> {
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email: `aprovador-${randomUUID()}@example.com`, name, passwordHash: "x" })
    .returning({ id: users.id });
  return u!.id;
}

async function seedToken(storeId: string, role: Role = "owner", name = "agente"): Promise<string> {
  const [tok] = await t.ownerDb
    .insert(mcpToken)
    .values({ storeId, name, role, tokenHash: randomBytes(32).toString("hex"), last4: "abcd" })
    .returning({ id: mcpToken.id });
  return tok!.id;
}

/** Loja com oferta e produtos, um token MCP e uma aprovadora dona (usuária de verdade: decided_by → users). */
async function setup(tokenRole: Role = "owner") {
  const s = await seedPanelStore("Aprovações");
  const userId = await seedUser();
  const owner: Actor = { kind: "user", userId, role: "owner" };
  const tokenId = await seedToken(s.storeId, tokenRole);
  const token: Actor = { kind: "token", tokenId, role: tokenRole };
  const asToken = (actor: Actor = token) => ({ storeId: s.storeId, actor, origin: "mcp" as const });
  const panel = (actor: Actor = owner) => ({ storeId: s.storeId, actor, origin: "panel" as const });
  const request = (action: string, args: unknown, actor: Actor = token) => runAction(requestApproval, asToken(actor), { action, args });
  return { s, storeId: s.storeId, userId, owner, tokenId, token, asToken, panel, request };
}

const requestRow = async (id: string) => (await t.ownerDb.select().from(approvalRequest).where(eq(approvalRequest.id, id)))[0]!;
const auditRows = (storeId: string) => t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId));

/** Linha semeada direto (papel dono): para limites, vencidos e pedidos de outro token. */
async function seedRow(storeId: string, tokenId: string, extra: Partial<typeof approvalRequest.$inferInsert> = {}) {
  const input = { n: randomUUID() };
  const [row] = await t.ownerDb
    .insert(approvalRequest)
    .values({
      storeId,
      tokenId,
      action: "offers.setSlug",
      inputSealed: seal(JSON.stringify(input)),
      inputSha256: sha256(JSON.stringify(input)),
      summary: { fields: [], notes: [] },
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      ...extra,
    })
    .returning({ id: approvalRequest.id });
  return row!.id;
}

const fieldsOf = (summary: unknown) => (summary as { fields: { label: string; value: string }[] }).fields;
const valueOf = (summary: unknown, label: string) => fieldsOf(summary).find((f) => f.label === label)?.value;

describe("approvals.request", () => {
  test("request: grava selado, resumo mascarado e expira em 7 dias; pedido idêntico devolve o mesmo id", async () => {
    const { s, storeId, request } = await setup();
    const args = { id: s.offerId, slug: "novo-endereco" };
    const before = Date.now();
    const res = await request("offers.setSlug", args);
    expect(res).toEqual({ requestId: expect.any(String), status: "pending", expiresAt: expect.any(Date) });
    const row = await requestRow(res.requestId);
    expect(row).toMatchObject({ storeId, action: "offers.setSlug", status: "pending", decidedAt: null, decidedBy: null, resultId: null, error: null });
    expect(open(row.inputSealed!)).toBe(JSON.stringify(args));
    expect(row.inputSha256).toBe(sha256(JSON.stringify(args)));
    expect(row.summary).toEqual({
      fields: [
        { label: "id", value: "Maná bíblico" },
        { label: "slug", value: "novo-endereco" },
      ],
      notes: [],
    });
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(7 * DAY_MS - 60_000);
    expect(ttl).toBeLessThan(7 * DAY_MS + 60_000);
    expect(res.expiresAt.getTime()).toBe(row.expiresAt.getTime());

    const again = await request("offers.setSlug", { id: s.offerId, slug: "novo-endereco" });
    expect(again.requestId).toBe(res.requestId);
    expect(await t.ownerDb.select().from(approvalRequest).where(eq(approvalRequest.storeId, storeId))).toHaveLength(1);
    // Auditoria do pedido: só o nome da ação-alvo.
    const audits = (await auditRows(storeId)).filter((a) => a.action === "approvals.request");
    expect(audits.map((a) => a.input)).toEqual([{ action: "offers.setSlug" }, { action: "offers.setSlug" }]);
  });

  test("request: ação não sensível, de permissão fora do papel, de TOKEN_DENIED ou desconhecida → forbidden; args inválidos → invalid_input; 17 KB → invalid_input; 31º na hora e 51º pendente → rate_limited", async () => {
    const { s, storeId, owner, tokenId, request } = await setup();
    const traffic: Actor = { kind: "token", tokenId: await seedToken(storeId, "traffic"), role: "traffic" };
    const order = await seedOrder(s);
    expect(await code(request("offers.list", {}))).toBe("forbidden");
    expect(await code(request("orders.refund", { orderId: order.id }, traffic))).toBe("forbidden");
    expect(await code(request("mcpTokens.revoke", { id: tokenId }))).toBe("forbidden");
    expect(await code(request("account.changePassword", { currentPassword: "a", newPassword: "b" }))).toBe("forbidden");
    expect(await code(request("nao.existe", {}))).toBe("forbidden");
    // Só token pede pela fila.
    expect(await code(runAction(requestApproval, { storeId, actor: owner, origin: "panel" }, { action: "offers.setSlug", args: { id: s.offerId, slug: "abc" } }))).toBe(
      "forbidden",
    );

    const invalid = await failure(request("offers.setSlug", { id: s.offerId, slug: "A" }));
    expect(invalid).toMatchObject({ code: "invalid_input" });
    expect((invalid!.details as { path: unknown[] }[]).map((i) => i.path)).toEqual([["slug"]]);
    const big = await failure(request("offers.setSlug", { id: s.offerId, slug: "abc", pad: "x".repeat(17 * 1024) }));
    expect(big).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify(big!.details)).not.toContain("xxxx");
    expect(await t.ownerDb.select().from(approvalRequest).where(eq(approvalRequest.storeId, storeId))).toHaveLength(0);

    // 30 pedidos deste token na última hora (já decididos: não contam como pendentes) → o 31º é recusado.
    for (let i = 0; i < 30; i++) await seedRow(storeId, tokenId, { status: "rejected", inputSealed: null });
    expect(await code(request("offers.setSlug", { id: s.offerId, slug: "abc" }))).toBe("rate_limited");

    // 50 pendentes na loja (de outro token) → o 51º é recusado, mesmo de um token sem pedidos na hora.
    const other = await setup();
    const otherToken = await seedToken(other.storeId);
    for (let i = 0; i < 50; i++) await seedRow(other.storeId, otherToken);
    expect(await code(other.request("offers.setSlug", { id: other.s.offerId, slug: "abc" }))).toBe("rate_limited");
    // Vencido não conta como pendente.
    await t.ownerDb.update(approvalRequest).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvalRequest.tokenId, otherToken));
    expect(await code(other.request("offers.setSlug", { id: other.s.offerId, slug: "abc" }))).toBe("ok");
  });

  test("segredos: saveResend, saveTelegram e saveAsaas pedidos pelo token → nem o segredo nem a entrada selada aparecem em approvals.list, approvals.status, audit_log nem na resposta; o resumo mostra ••••<4 últimos>", async () => {
    const { storeId, request, panel, asToken } = await setup();
    const apiKey = resendKey();
    const webhookSecret = resendWebhookSecret();
    const token = botToken();
    const asaas = createFakeAsaas({ apiKey: randomBytes(16).toString("hex") });
    setAsaasFetchForTests(asaas.fetch);
    setTelegramFetchForTests((async (url: string | URL | Request) =>
      String(url).endsWith("/getMe") ? json(200, { ok: true, result: { username: "loja_bot" } }) : json(200, { ok: true, result: { message_id: 1 } })) as typeof fetch);
    const secrets = [apiKey, webhookSecret, token, asaas.apiKey];

    const responses = [
      await request("connections.saveResend", { fromEmail: "vendas@loja.com", apiKey, webhookSecret }),
      await request("connections.saveTelegram", { chatId: "@loja_avisos", token }),
      await request("connections.saveAsaas", { env: "sandbox", apiKey: asaas.apiKey }),
    ];
    const [resend, telegram, asaasReq] = await Promise.all(responses.map((r) => requestRow(r.requestId)));
    expect(valueOf(resend!.summary, "apiKey")).toBe(`••••${apiKey.slice(-4)}`);
    expect(valueOf(resend!.summary, "webhookSecret")).toBe(`••••${webhookSecret.slice(-4)}`);
    expect(valueOf(telegram!.summary, "token")).toBe(`••••${token.slice(-4)}`);
    expect(valueOf(asaasReq!.summary, "apiKey")).toBe(`••••${asaas.apiKey.slice(-4)}`);
    const sealed = [resend!.inputSealed!, telegram!.inputSealed!, asaasReq!.inputSealed!];

    const leaks = (label: string, v: unknown) => {
      const text = JSON.stringify(v);
      expect([label, [...secrets, ...sealed].filter((x) => text.includes(x))]).toEqual([label, []]);
    };
    leaks("respostas", responses);
    leaks("approvals.list", await runAction(listApprovals, panel(), {}));
    leaks("approvals.status", await runAction(approvalStatus, asToken(), {}));
    for (const r of responses) leaks("approvals.status (id)", await runAction(approvalStatus, asToken(), { id: r.requestId }));

    // Aprovados: execução com o segredo aberto só dentro do servidor; a entrada selada some.
    const approved = [];
    for (const r of responses) approved.push(await runAction(approveRequest, panel(), { id: r.requestId }));
    leaks("respostas do approve", approved);
    for (const r of responses) expect(await requestRow(r.requestId)).toMatchObject({ status: "approved", inputSealed: null });
    leaks("approvals.list depois", await runAction(listApprovals, panel(), {}));
    leaks("approvals.status depois", await runAction(approvalStatus, asToken(), {}));
    leaks("audit_log", await auditRows(storeId));
    leaks("log", out);
  });
});

describe("resumo", () => {
  test("resumo: savePixManual mostra a chave inteira; setProducts mostra nomes dos produtos; refund mostra o código do pedido; saveResend em loja sem SMTP traz a nota de ativação", async () => {
    const { s, request } = await setup();
    const pix = await requestRow((await request("connections.savePixManual", { key: "pix@loja.com.br", name: "Loja", city: "Recife" })).requestId);
    expect(fieldsOf(pix.summary)).toEqual([
      { label: "key", value: "pix@loja.com.br" },
      { label: "name", value: "Loja" },
      { label: "city", value: "Recife" },
    ]);

    const products = await requestRow(
      (
        await request("offers.setProducts", {
          id: s.offerId,
          productIds: [s.mainId],
          bump: { productIds: [s.bumpId], priceCents: 1710, label: "Leve também" },
          priceCents: 1290,
        })
      ).requestId,
    );
    expect(fieldsOf(products.summary)).toEqual([
      { label: "id", value: "Maná bíblico" },
      { label: "productIds", value: "Maná básica" },
      { label: "bump.productIds", value: "Maná completa" },
      { label: "bump.priceCents", value: "R$ 17,10" },
      { label: "bump.label", value: "Leve também" },
      { label: "priceCents", value: "R$ 12,90" },
    ]);

    const order = await seedOrder(s);
    const refund = await requestRow((await request("orders.refund", { orderId: order.id })).requestId);
    expect(fieldsOf(refund.summary)).toEqual([{ label: "orderId", value: orderCode(order.publicId) }]);
    expect(JSON.stringify(refund.summary)).not.toContain(order.id);

    const resend = await requestRow((await request("connections.saveResend", { fromEmail: "vendas@loja.com" })).requestId);
    expect(resend.summary).toEqual({
      fields: [
        { label: "fromEmail", value: "vendas@loja.com" },
        { label: "apiKey", value: "(mantém o atual)" },
        { label: "webhookSecret", value: "(mantém o atual)" },
      ],
      notes: ["Também passa a usar o Resend para enviar os e-mails da loja"],
    });
  });

  test("resumo: booleanos, vazio, id inexistente e a nota de reativar oferta", async () => {
    const { s, storeId } = await setup();
    const offersUpdate = updateOffer as unknown as Action<unknown, unknown>;
    const summary = await withStore(storeId, (tx) =>
      summarizeRequest(tx, offersUpdate, { id: s.offerId, active: true, thankYouText: null, maxInstallments: 3 }),
    );
    expect(summary).toEqual({
      fields: [
        { label: "id", value: "Maná bíblico" },
        { label: "active", value: "sim" },
        { label: "thankYouText", value: "(vazio)" },
        { label: "maxInstallments", value: "3" },
      ],
      notes: ["Reativa a oferta: o link volta a vender"],
    });
    const missing = await withStore(storeId, (tx) => summarizeRequest(tx, offersUpdate, { id: randomUUID(), active: false }));
    expect(missing).toEqual({
      fields: [
        { label: "id", value: "(não encontrado)" },
        { label: "active", value: "não" },
      ],
      notes: [],
    });
  });
});

/** Caminhos das folhas de texto do schema (desembrulha opcional, nulo, default, pipe e refinamentos). */
function stringLeaves(schema: z.ZodType, path: string[] = []): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  switch (def.type) {
    case "string":
      return [path.join(".")];
    case "object":
      return Object.entries(def.shape as Record<string, z.ZodType>).flatMap(([k, v]) => stringLeaves(v, [...path, k]));
    case "optional":
    case "nullable":
    case "default":
    case "nonoptional":
    case "readonly":
      return stringLeaves(def.innerType as z.ZodType, path);
    case "pipe":
      return stringLeaves(def.in as z.ZodType, path);
    case "array":
      return stringLeaves(def.element as z.ZodType, path);
    default:
      return [];
  }
}

describe("classificação dos segredos", () => {
  test("classificação: toda ação sensível com campo de texto que casa /key|token|secret|password/i está em SECRET_FIELDS ou SHOWN_IN_FULL", () => {
    const unclassified: string[] = [];
    let checked = 0;
    for (const a of registry.values()) {
      // Ações de TOKEN_DENIED (troca de senha, tokens) nunca passam pela fila.
      if (!a.sensitive || a.permission === "public" || a.permission === "system" || TOKEN_DENIED.includes(a.permission)) continue;
      for (const leaf of stringLeaves(a.input)) {
        if (!/key|token|secret|password/i.test(leaf.split(".").at(-1)!)) continue;
        checked++;
        const full = `${a.name}.${leaf}`;
        if (!(SECRET_FIELDS[a.name] ?? []).includes(leaf) && !Object.hasOwn(SHOWN_IN_FULL, full)) unclassified.push(full);
      }
    }
    expect(unclassified).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(7);
    for (const reason of Object.values(SHOWN_IN_FULL)) expect(reason.length).toBeGreaterThan(10);
    expect(SECRET_FIELDS).toEqual({
      "connections.saveAsaas": ["apiKey"],
      "connections.saveSmtp": ["password"],
      "connections.saveMeta": ["accessToken"],
      "connections.saveResend": ["apiKey", "webhookSecret"],
      "connections.saveTelegram": ["token"],
    });
    expect(Object.keys(SHOWN_IN_FULL)).toEqual(["connections.savePixManual.key"]);
  });
});

describe("approvals.approve e reject", () => {
  test("approve: executa com o aprovador, auditoria com approval; dois approve simultâneos → a ação roda uma vez e o outro recebe conflict", async () => {
    const { s, storeId, userId, owner, tokenId, request, panel } = await setup();
    const first = await request("offers.setSlug", { id: s.offerId, slug: "endereco-aprovado" });
    expect(await runAction(approveRequest, panel(), { id: first.requestId })).toEqual({ status: "approved", resultId: s.offerId });
    const [o] = await t.ownerDb.select().from(offer).where(eq(offer.id, s.offerId));
    expect(o!.slug).toBe("endereco-aprovado");
    expect(await requestRow(first.requestId)).toMatchObject({ status: "approved", decidedBy: userId, inputSealed: null, resultId: s.offerId });
    const setSlugAudits = (await auditRows(storeId)).filter((a) => a.action === "offers.setSlug");
    expect(setSlugAudits).toHaveLength(1);
    expect(setSlugAudits[0]).toMatchObject({ ok: true, origin: "mcp", actor: { ...owner, approval: { requestId: first.requestId, tokenId } } });
    const approveAudit = (await auditRows(storeId)).filter((a) => a.action === "approvals.approve");
    expect(approveAudit).toMatchObject([{ ok: true, origin: "panel", input: { id: first.requestId } }]);

    // Aprovar de novo um pedido decidido: conflict, nada roda.
    expect(await code(runAction(approveRequest, panel(), { id: first.requestId }))).toBe("conflict");

    const second = await request("offers.setSlug", { id: s.offerId, slug: "corrida-dupla" });
    const results = await Promise.allSettled([
      runAction(approveRequest, panel(), { id: second.requestId }),
      runAction(approveRequest, panel(), { id: second.requestId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "conflict" });
    const okRuns = (await auditRows(storeId)).filter((a) => a.action === "offers.setSlug" && a.ok);
    expect(okRuns).toHaveLength(2);
    expect(await requestRow(second.requestId)).toMatchObject({ status: "approved" });
  });

  test("approve: aprovador sem a permissão da ação-alvo → forbidden e o pedido segue pendente; pedido inexistente → not_found", async () => {
    const { s, storeId, request, panel } = await setup();
    const order = await seedOrder(s);
    const req = await request("orders.refund", { orderId: order.id });
    const support: Actor = { kind: "user", userId: await seedUser("Suporte"), role: "support" };
    expect(await code(runAction(approveRequest, panel(support), { id: req.requestId }))).toBe("forbidden");
    expect(await code(runAction(rejectRequest, panel(support), { id: req.requestId }))).toBe("forbidden");
    const row = await requestRow(req.requestId);
    expect(row).toMatchObject({ status: "pending", decidedBy: null });
    expect(row.inputSealed).not.toBeNull();
    expect(await code(runAction(approveRequest, panel(), { id: randomUUID() }))).toBe("not_found");
    // Token nunca decide.
    const tokenId = await seedToken(storeId);
    expect(await code(runAction(approveRequest, { storeId, actor: { kind: "token", tokenId, role: "owner" }, origin: "mcp" }, { id: req.requestId }))).toBe(
      "forbidden",
    );
  });

  test("approve: falha do provedor → failed com o erro e input_sealed nulo", async () => {
    const { storeId, request, panel } = await setup();
    // O Asaas falso aceita outra chave: a chave pedida é recusada no teste de saldo (prepare de saveAsaas).
    const asaas = createFakeAsaas({ apiKey: randomBytes(16).toString("hex") });
    setAsaasFetchForTests(asaas.fetch);
    const req = await request("connections.saveAsaas", { env: "sandbox", apiKey: randomBytes(16).toString("hex") });
    const err = await failure(runAction(approveRequest, panel(), { id: req.requestId }));
    expect(err).toMatchObject({ code: "provider_error" });
    const row = await requestRow(req.requestId);
    expect(row).toMatchObject({ status: "failed", inputSealed: null, decidedAt: expect.any(Date) });
    expect(row.error).toStartWith("provider_error: ");
    expect(await code(runAction(approveRequest, panel(), { id: req.requestId }))).toBe("conflict");
    const audits = (await auditRows(storeId)).filter((a) => a.action === "approvals.approve");
    expect(audits).toMatchObject([{ ok: false }, { ok: false }]);
  });

  test("approve: conflict da reivindicação (hash da linha adulterado) não marca failed; a linha segue pendente", async () => {
    const { s, request, panel } = await setup();
    const req = await request("offers.setSlug", { id: s.offerId, slug: "hash-adulterado" });
    await t.ownerDb.update(approvalRequest).set({ inputSha256: sha256("outra entrada") }).where(eq(approvalRequest.id, req.requestId));
    const err = await failure(runAction(approveRequest, panel(), { id: req.requestId }));
    expect(err).toMatchObject({ code: "conflict", details: { approval: "unclaimed" } });
    const row = await requestRow(req.requestId);
    expect(row).toMatchObject({ status: "pending", error: null, decidedAt: null });
    expect(row.inputSealed).not.toBeNull();
  });

  test("reject → rejected e input_sealed nulo", async () => {
    const { s, userId, request, panel } = await setup();
    const req = await request("offers.setSlug", { id: s.offerId, slug: "recusado" });
    expect(await runAction(rejectRequest, panel(), { id: req.requestId })).toEqual({ status: "rejected" });
    expect(await requestRow(req.requestId)).toMatchObject({ status: "rejected", decidedBy: userId, inputSealed: null, decidedAt: expect.any(Date) });
    expect(await code(runAction(rejectRequest, panel(), { id: req.requestId }))).toBe("conflict");
    expect(await code(runAction(approveRequest, panel(), { id: req.requestId }))).toBe("conflict");
    const [o] = await t.ownerDb.select().from(offer).where(eq(offer.id, s.offerId));
    expect(o!.slug).not.toBe("recusado");
  });
});

describe("leituras", () => {
  test("status: o token vê só os próprios pedidos; pendente vencido aparece expired; resultId de offers.setSlug é o id da oferta", async () => {
    const { s, storeId, tokenId, request, panel, asToken } = await setup();
    const mine = await request("offers.setSlug", { id: s.offerId, slug: "status-ok" });
    await runAction(approveRequest, panel(), { id: mine.requestId });
    const expired = await seedRow(storeId, tokenId, { expiresAt: new Date(Date.now() - 1000) });
    const otherToken = await seedToken(storeId);
    const others = await seedRow(storeId, otherToken);

    const list = await runAction(approvalStatus, asToken(), {});
    expect(list.requests.map((r) => r.id).sort()).toEqual([mine.requestId, expired].sort());
    const ok = list.requests.find((r) => r.id === mine.requestId)!;
    expect(ok).toEqual({
      id: mine.requestId,
      tool: "offers_setSlug",
      status: "approved",
      createdAt: expect.any(Date),
      expiresAt: expect.any(Date),
      decidedAt: expect.any(Date),
      resultId: s.offerId,
      error: null,
    });
    expect(list.requests.find((r) => r.id === expired)!.status).toBe("expired");
    expect((await runAction(approvalStatus, asToken(), { id: expired })).requests).toMatchObject([{ id: expired, status: "expired" }]);
    expect(await code(runAction(approvalStatus, asToken(), { id: others }))).toBe("not_found");

    // O painel também mostra o vencido como expired (antes da varredura) e não o conta como pendente.
    const panelList = await runAction(listApprovals, panel(), {});
    expect(panelList.pending.map((r) => r.id)).toEqual([others]);
    expect(panelList.pending[0]).toMatchObject({ tokenName: "agente", tokenRole: "owner", action: "offers.setSlug", canDecide: true, status: "pending" });
    expect(panelList.history.find((r) => r.id === expired)).toMatchObject({ status: "expired" });
    expect(panelList.history.find((r) => r.id === mine.requestId)).toMatchObject({ status: "approved", decidedBy: "Aprovadora", canDecide: false });
    expect(await runAction(pendingApprovalsCount, panel(), {})).toEqual({ count: 1 });

    // Token de outro papel (leitor) lê os próprios: nenhum.
    const reader: Actor = { kind: "token", tokenId: await seedToken(storeId, "reader"), role: "reader" };
    expect(await runAction(approvalStatus, asToken(reader), {})).toEqual({ requests: [] });
    // Membro do painel não usa approvals.status.
    expect(await code(runAction(approvalStatus, panel(), {}))).toBe("forbidden");
  });
});

describe("revogação e varredura", () => {
  test("revogar o token cancela os pendentes dele (input_sealed nulo); aprovar depois → conflict", async () => {
    const { s, storeId, tokenId, request, panel } = await setup();
    const req = await request("offers.setSlug", { id: s.offerId, slug: "antes-de-revogar" });
    const otherToken = await seedToken(storeId);
    const kept = await seedRow(storeId, otherToken);
    expect(await runAction(revokeMcpToken, panel(), { id: tokenId })).toEqual({ revoked: true });
    expect(await requestRow(req.requestId)).toMatchObject({ status: "canceled", inputSealed: null, decidedAt: expect.any(Date) });
    expect(await requestRow(kept)).toMatchObject({ status: "pending" });
    expect(await code(runAction(approveRequest, panel(), { id: req.requestId }))).toBe("conflict");
    const [o] = await t.ownerDb.select().from(offer).where(eq(offer.id, s.offerId));
    expect(o!.slug).not.toBe("antes-de-revogar");
  });

  test("sweep_mcp: vencido vira expired com input_sealed nulo; link de upload vencido há mais de 24 h some", async () => {
    const { storeId, tokenId } = await setup();
    const due = await seedRow(storeId, tokenId, { expiresAt: new Date(Date.now() - 1000) });
    const live = await seedRow(storeId, tokenId);
    const link = (expiresAt: Date, usedAt: Date | null = null) =>
      t.ownerDb
        .insert(uploadLink)
        .values({ storeId, tokenId, name: "PDF", fileName: "a.pdf", keyHash: randomBytes(32).toString("hex"), expiresAt, usedAt })
        .returning({ id: uploadLink.id })
        .then((r) => r[0]!.id);
    const old = await link(new Date(Date.now() - 25 * 3_600_000));
    const recent = await link(new Date(Date.now() - 3_600_000));
    const used = await link(new Date(Date.now() - 25 * 3_600_000), new Date(Date.now() - 26 * 3_600_000));

    await t.ownerDb.transaction((tx) => enqueue(tx, { storeId: null, type: "sweep_mcp", payload: {} }));
    expect(await runDueJobs(getHandlers(), 10, new Date(), { types: ["sweep_mcp"] })).toBe(1);
    const [j] = await t.ownerDb.select().from(job).where(and(eq(job.type, "sweep_mcp")));
    expect(j!.status).toBe("done");

    expect(await requestRow(due)).toMatchObject({ status: "expired", inputSealed: null });
    expect((await requestRow(live)).status).toBe("pending");
    const links = (await t.ownerDb.select({ id: uploadLink.id }).from(uploadLink).where(eq(uploadLink.storeId, storeId))).map((r) => r.id).sort();
    expect(links).toEqual([recent, used].sort());
    expect(links).not.toContain(old);
  });
});
