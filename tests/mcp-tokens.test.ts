// Token MCP por loja (src/lib/mcp/tokens.ts): formato, guarda só o hash, autenticação (só pelo RLS da loja do token),
// `last_used_at` no máximo 1 vez por minuto, ações do painel (criar, listar, revogar) e o ator `token` no runAction.
// Nenhum literal com o formato do token: tudo montado em tempo de execução.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { runAction, type Actor } from "@/lib/actions/core";
import { ROLE_PERMISSIONS, type Role } from "@/lib/actions/permissions";
import { changePassword, listTeam } from "@/lib/auth/account";
import { getOffer, listOffers } from "@/lib/catalog/offers";
import { listProducts, updateProduct } from "@/lib/catalog/products";
import { connectionsStatus } from "@/lib/connections";
import { seal, sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { auditLog, emailLog, integration, mcpToken, users } from "@/lib/db/schema";
import { authenticateMcpToken, createMcpToken, listMcpTokens, mintMcpToken, revokeMcpToken } from "@/lib/mcp/tokens";
import { metricsSummary } from "@/lib/metrics";
import { removeTelegram } from "@/lib/notify/telegram-connection";
import { exportOrders, getOrderDetail, listOrders } from "@/lib/orders/panel";
import { createTestDb, seedProduct, seedStore, type TestDb } from "./db";
import { panelCall, seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const PREFIX = ["fnl", ""].join("_");
const TOKEN_RE = new RegExp(`^${PREFIX}([0-9a-f]{32})_([A-Za-z0-9_-]{43})$`);

/** Dono de verdade (created_by → users): loja + usuário. */
async function ownerStore(name = "Loja MCP") {
  const { storeId } = await seedStore(name);
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email: `dono-${randomUUID()}@example.com`, name: "Dona Ana", passwordHash: "x" })
    .returning({ id: users.id });
  const owner: Actor = { kind: "user", userId: u!.id, role: "owner" };
  return { storeId, owner, panel: { storeId, actor: owner, origin: "panel" as const } };
}

const panelAs = (storeId: string, role: Role) => ({ storeId, actor: { kind: "user" as const, userId: randomUUID(), role }, origin: "panel" as const });
const tokenActor = (role: Role): Actor => ({ kind: "token", tokenId: randomUUID(), role });
const rowsOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(mcpToken));

describe("mintMcpToken", () => {
  test("mintMcpToken: formato fnl_<32 hex>_<43 base64url>, hash sha256, last4", () => {
    const storeId = randomUUID();
    const a = mintMcpToken(storeId);
    const m = TOKEN_RE.exec(a.token);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(storeId.replaceAll("-", ""));
    expect(a.hash).toBe(sha256(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.last4).toBe(a.token.slice(-4));
    // Aleatório: dois tokens da mesma loja nunca se repetem.
    expect(mintMcpToken(storeId).token).not.toBe(a.token);
  });
});

describe("ações do painel", () => {
  test("create devolve o token uma vez; a linha guarda só o hash; auditoria sem o token; list nunca devolve hash nem token", async () => {
    const { storeId, owner, panel } = await ownerStore();
    const created = await runAction(createMcpToken, panel, { name: "  Agente de relatórios ", role: "reader" });
    expect(created).toMatchObject({ name: "Agente de relatórios", role: "reader" });
    expect(created.token).toMatch(TOKEN_RE);
    expect(created.last4).toBe(created.token.slice(-4));

    const [row] = await rowsOf(storeId);
    expect(row).toMatchObject({ id: created.id, storeId, name: "Agente de relatórios", role: "reader", tokenHash: sha256(created.token), last4: created.last4 });
    expect(row!.createdBy).toBe((owner as { userId: string }).userId);
    expect(row!.lastUsedAt).toBeNull();
    expect(row!.revokedAt).toBeNull();
    // Nenhuma coluna guarda o token (nem o segredo depois do storeId).
    const secret = created.token.split("_").slice(2).join("_");
    expect(JSON.stringify(row)).not.toContain(secret);

    const audits = await withStore(storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "mcpTokens.create")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.input).toEqual({ name: "Agente de relatórios", role: "reader" });
    expect(JSON.stringify(audits[0])).not.toContain(secret);

    const list = await runAction(listMcpTokens, panel, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, name: "Agente de relatórios", role: "reader", last4: created.last4, createdBy: "Dona Ana", lastUsedAt: null, revokedAt: null });
    expect(list[0]!.createdAt).toBeInstanceOf(Date);
    const listed = JSON.stringify(list);
    expect(listed).not.toContain(secret);
    expect(listed).not.toContain(sha256(created.token));
    expect(Object.keys(list[0]!).sort()).toEqual(["createdAt", "createdBy", "id", "last4", "lastUsedAt", "name", "revokedAt", "role"]);
  });

  test("create valida nome (1..60) e papel (só os de token)", async () => {
    const { panel } = await ownerStore();
    for (const input of [{ name: "", role: "reader" }, { name: "x".repeat(61), role: "reader" }, { name: "ok", role: "card" }, { name: "ok", role: "dono" }]) {
      await expect(runAction(createMcpToken, panel, input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const role of ["owner", "admin", "support", "traffic", "reader"] as const) {
      expect((await runAction(createMcpToken, panel, { name: role, role })).role).toBe(role);
    }
  });

  test("revoke marca revogado (só na loja dele); id desconhecido ou de outra loja: not_found", async () => {
    const a = await ownerStore("A");
    const b = await ownerStore("B");
    const tokA = await runAction(createMcpToken, a.panel, { name: "a", role: "admin" });
    await expect(runAction(revokeMcpToken, b.panel, { id: tokA.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(runAction(revokeMcpToken, a.panel, { id: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    expect(await runAction(revokeMcpToken, a.panel, { id: tokA.id })).toEqual({ revoked: true });
    expect(await runAction(revokeMcpToken, a.panel, { id: tokA.id })).toEqual({ revoked: false });
    const [row] = await rowsOf(a.storeId);
    expect(row!.revokedAt).toBeInstanceOf(Date);
    expect((await runAction(listMcpTokens, a.panel, {}))[0]!.revokedAt).toBeInstanceOf(Date);
    expect(await runAction(listMcpTokens, b.panel, {})).toEqual([]);
  });

  test("só team.manage cria, lista e revoga; pelo MCP as três dão approval_required (create/revoke) ou ficam fora", async () => {
    const { storeId, panel } = await ownerStore();
    const tok = await runAction(createMcpToken, panel, { name: "x", role: "reader" });
    for (const role of ["admin", "support", "traffic", "reader"] as const) {
      const call = panelAs(storeId, role);
      await expect(runAction(createMcpToken, call, { name: "y", role: "reader" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(runAction(listMcpTokens, call, {})).rejects.toMatchObject({ code: "forbidden" });
      await expect(runAction(revokeMcpToken, call, { id: tok.id })).rejects.toMatchObject({ code: "forbidden" });
    }
    // Pelo MCP/IA, criar e revogar exigem aprovação mesmo para o dono (sensíveis).
    for (const origin of ["mcp", "ai"] as const) {
      const call = { ...panel, origin };
      await expect(runAction(createMcpToken, call, { name: "y", role: "owner" })).rejects.toMatchObject({ code: "approval_required" });
      await expect(runAction(revokeMcpToken, call, { id: tok.id })).rejects.toMatchObject({ code: "approval_required" });
    }
    // Token, nem de dono e por nenhuma origem, administra tokens (team.manage é recusado ao ator token).
    for (const origin of ["mcp", "api", "panel"] as const) {
      const call = { storeId, actor: tokenActor("owner"), origin };
      await expect(runAction(createMcpToken, call, { name: "y", role: "owner" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(runAction(listMcpTokens, call, {})).rejects.toMatchObject({ code: "forbidden" });
      await expect(runAction(revokeMcpToken, call, { id: tok.id })).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(createMcpToken.sensitive).toBe(true);
    expect(revokeMcpToken.sensitive).toBe(true);
    expect(createMcpToken.permission).toBe("team.manage");
    expect(listMcpTokens.permission).toBe("team.manage");
    expect(revokeMcpToken.permission).toBe("team.manage");
    expect((await rowsOf(storeId)).map((r) => r.revokedAt)).toEqual([null]);
  });
});

describe("authenticateMcpToken", () => {
  test("authenticate: válido → { storeId, tokenId, role }; revogado, malformado, loja inexistente, segredo de outra loja → null", async () => {
    const a = await ownerStore("A");
    const b = await ownerStore("B");
    const tokA = await runAction(createMcpToken, a.panel, { name: "a", role: "traffic" });
    const tokB = await runAction(createMcpToken, b.panel, { name: "b", role: "owner" });
    expect(await authenticateMcpToken(tokA.token)).toEqual({ storeId: a.storeId, tokenId: tokA.id, role: "traffic" });
    expect(await authenticateMcpToken(tokB.token)).toEqual({ storeId: b.storeId, tokenId: tokB.id, role: "owner" });

    const hex = (id: string) => id.replaceAll("-", "");
    const secretOf = (tok: string) => tok.slice(PREFIX.length + 33);
    // Malformados.
    for (const raw of [null, "", "Bearer x", tokA.token + "x", tokA.token.slice(0, -1), tokA.token.toUpperCase(), ` ${tokA.token}`, `${PREFIX}${hex(a.storeId)}_${"!".repeat(43)}`]) {
      expect(await authenticateMcpToken(raw)).toBeNull();
    }
    // storeId da loja A com o segredo do token da loja B.
    expect(await authenticateMcpToken(`${PREFIX}${hex(a.storeId)}_${secretOf(tokB.token)}`)).toBeNull();
    // Loja inexistente (formato válido).
    expect(await authenticateMcpToken(`${PREFIX}${hex(randomUUID())}_${secretOf(tokA.token)}`)).toBeNull();
    // Segredo desconhecido.
    expect(await authenticateMcpToken(`${PREFIX}${hex(a.storeId)}_${randomBytes(32).toString("base64url")}`)).toBeNull();
    // Revogado.
    await runAction(revokeMcpToken, a.panel, { id: tokA.id });
    expect(await authenticateMcpToken(tokA.token)).toBeNull();
    expect(await authenticateMcpToken(tokB.token)).not.toBeNull();
  });

  test("last_used_at só muda se passou 1 minuto", async () => {
    const { storeId, panel } = await ownerStore();
    const tok = await runAction(createMcpToken, panel, { name: "a", role: "reader" });
    const usedAt = async () => (await rowsOf(storeId))[0]!.lastUsedAt;
    expect(await usedAt()).toBeNull();

    await authenticateMcpToken(tok.token);
    const first = await usedAt();
    expect(first).toBeInstanceOf(Date);
    // Volta 30 s: ainda dentro do minuto, não muda.
    await t.ownerDb.execute(sql`update mcp_token set last_used_at = last_used_at - interval '30 seconds' where id = ${tok.id}`);
    const within = await usedAt();
    await authenticateMcpToken(tok.token);
    expect((await usedAt())!.getTime()).toBe(within!.getTime());
    // Volta mais 2 min: passou do minuto, atualiza para agora.
    await t.ownerDb.execute(sql`update mcp_token set last_used_at = last_used_at - interval '2 minutes' where id = ${tok.id}`);
    const old = await usedAt();
    await authenticateMcpToken(tok.token);
    expect((await usedAt())!.getTime()).toBeGreaterThan(old!.getTime() + 60_000);
  });
});

describe("ator token no runAction", () => {
  test("actor token: authorize aceita com o papel do token; reader só lê produtos, ofertas, métricas e orders.report", async () => {
    expect([...ROLE_PERMISSIONS.reader].sort()).toEqual(["metrics.read", "offers.read", "orders.report", "products.read"]);
    const { storeId } = await ownerStore();
    const reader = { storeId, actor: tokenActor("reader"), origin: "mcp" as const };
    expect(await runAction(listProducts, reader, {})).toEqual([]);
    expect(await runAction(listOffers, reader, {})).toEqual([]);
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() };
    expect(await runAction(metricsSummary, reader, range)).toBeDefined();
    await expect(runAction(listOrders, reader, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(runAction(exportOrders, reader, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(runAction(listMcpTokens, reader, {})).rejects.toMatchObject({ code: "forbidden" });

    // Outro papel no token: vale o papel (support lê pedidos; traffic não).
    expect(await runAction(listOrders, { storeId, actor: tokenActor("support"), origin: "mcp" }, {})).toMatchObject({ total: 0 });
    await expect(runAction(listOrders, { storeId, actor: tokenActor("traffic"), origin: "mcp" }, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  test("token de dono não herda team.manage nem account.self: team.list e mcpTokens.list dão forbidden", async () => {
    const { storeId } = await ownerStore();
    const call = { storeId, actor: tokenActor("owner"), origin: "mcp" as const };
    await expect(runAction(listTeam, call, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(runAction(listMcpTokens, call, {})).rejects.toMatchObject({ code: "forbidden" });
  });

  test("ação feita com ator token grava o tokenId e o papel no ator da auditoria; leitura do catálogo não grava", async () => {
    const { storeId } = await ownerStore();
    const { id } = await seedProduct(storeId);
    const actor = tokenActor("owner");
    await runAction(updateProduct, { storeId, actor, origin: "mcp" }, { id, name: "Renomeado" });
    const [audit] = await withStore(storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "products.update")));
    expect(audit).toMatchObject({ actor, origin: "mcp", ok: true });
    // Leituras (audit: false): pelo MCP não viram uma linha de auditoria por chamada.
    const reader = { storeId, actor: tokenActor("reader"), origin: "mcp" as const };
    await runAction(listProducts, reader, {});
    await runAction(listOffers, reader, {});
    await expect(runAction(getOffer, reader, { id: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    const reads = await withStore(storeId, (tx) =>
      tx.select().from(auditLog).where(sql`${auditLog.action} in ('products.list', 'offers.list', 'offers.get')`),
    );
    expect(reads).toEqual([]);
  });

  test("connections.status: token (mesmo de dono) nunca recebe o token do webhook do Asaas nem os finais das chaves", async () => {
    const { storeId, panel } = await ownerStore();
    const hook = randomBytes(16).toString("hex");
    const [apiLast4, whLast4, botLast4] = ["Wq7z", "Kp3m", "Rt9x"];
    const [pixKey, smtpUser] = ["52998224725", "dona.ana.smtp@exemplo.com"];
    await t.ownerDb.insert(integration).values([
      { storeId, kind: "pix_manual", config: { key: pixKey, name: "Ana", city: "Rio" }, secret: null },
      { storeId, kind: "smtp", config: { host: "smtp.exemplo.com", port: 587, secure: false, user: smtpUser, from: "vendas@loja.com" }, secret: seal("senha") },
      { storeId, kind: "asaas", config: { env: "sandbox", webhookToken: hook }, secret: "a1.selado" },
      { storeId, kind: "resend", config: { fromEmail: "vendas@loja.com", apiKeyLast4: apiLast4, webhookSecretLast4: whLast4 }, secret: seal("chave-resend") },
      { storeId, kind: "telegram", config: { chatId: "12345", tokenLast4: botLast4 }, secret: seal("token-bot") },
    ]);
    for (const role of ["owner", "traffic"] as const) {
      const st = await runAction(connectionsStatus, { storeId, actor: tokenActor(role), origin: "mcp" }, {});
      expect(st.asaas?.webhookToken).toBeNull();
      expect(st.resend).toMatchObject({ apiKey: "configured", webhookSecret: "configured" });
      expect(st.telegram?.token).toBe("configured");
      expect(st.pixManual?.key).toBe("configured");
      expect(st.smtp?.user).toBeNull();
      const json = JSON.stringify(st);
      for (const secret of [hook, apiLast4, whLast4, botLast4, pixKey, smtpUser]) expect(json).not.toContain(secret);
    }
    await expect(runAction(connectionsStatus, { storeId, actor: tokenActor("reader"), origin: "mcp" }, {})).rejects.toMatchObject({ code: "forbidden" });
    // Controle: o dono no painel vê.
    const own = await runAction(connectionsStatus, panel, {});
    expect(own.asaas?.webhookToken).toBe(hook);
    expect(own.resend?.apiKey).toEqual({ last4: apiLast4 });
    expect(own.telegram?.token).toEqual({ last4: botLast4 });
    expect(own.pixManual?.key).toBe(pixKey);
    expect(own.smtp?.user).toBe(smtpUser);
  });

  test("orders.get: token (mesmo de dono) recebe só \"falha no envio\", nunca o erro cru do SMTP", async () => {
    const s = await seedPanelStore();
    const o = await seedOrder(s, { status: "paid" });
    const raw = "550 5.1.1 <comprador.unico@exemplo.com>: Recipient address rejected";
    await t.ownerDb.insert(emailLog).values({ storeId: s.storeId, orderId: o.id, toHash: "x", kind: "delivery", status: "failed", error: raw });
    for (const role of ["owner", "admin", "support"] as const) {
      const d = await runAction(getOrderDetail, { storeId: s.storeId, actor: tokenActor(role), origin: "mcp" }, { id: o.id });
      expect(d.emails[0]!.error).toBe("falha no envio");
      expect(JSON.stringify(d.emails)).not.toContain("comprador.unico");
    }
    // Controle: o dono no painel vê o texto do provedor.
    expect((await runAction(getOrderDetail, panelCall(s.storeId, "owner"), { id: o.id })).emails[0]!.error).toBe(raw);
  });

  test("ações da própria conta (senha): o ator token é recusado (account.self) por qualquer origem", async () => {
    const { storeId } = await ownerStore();
    for (const origin of ["mcp", "api", "panel"] as const) {
      const call = { storeId, actor: tokenActor("owner"), origin };
      await expect(runAction(changePassword, call, { currentPassword: "a".repeat(12), newPassword: "b".repeat(12) })).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  test("removeTelegram pelo MCP → approval_required; pelo painel continua funcionando", async () => {
    const { storeId, panel } = await ownerStore();
    await t.ownerDb.insert(integration).values({ storeId, kind: "telegram", config: {}, secret: "v1.selado" });
    for (const origin of ["mcp", "ai"] as const) {
      await expect(runAction(removeTelegram, { ...panel, origin }, {})).rejects.toMatchObject({ code: "approval_required" });
    }
    // Ator token: aprovação por qualquer origem (não escapa chamando como "api" ou "panel").
    for (const origin of ["mcp", "api", "panel"] as const) {
      await expect(runAction(removeTelegram, { storeId, actor: tokenActor("owner"), origin }, {})).rejects.toMatchObject({ code: "approval_required" });
    }
    expect(removeTelegram.sensitive).toBe(true);
    expect(await runAction(removeTelegram, panel, {})).toEqual({ removed: true });
  });
});
