// Conexão do app no painel (Task 10): URL do webhook (só https em host público, sem credencial), hosts de retorno,
// origem pública do app, segredo mostrado uma vez e rotação, `ping` assinado, chaves `integration` listadas à parte
// das do MCP e as três ações fora do MCP. O app é um servidor HTTP local (loopback liberado só onde o teste pede);
// a resolução de nomes é injetada (nenhum DNS de verdade). Nenhum literal com formato de segredo.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { rotateAppWebhookSecret, saveAppWebhook, testAppWebhook } from "@/lib/apps/connection";
import { setAppWebhookForTests } from "@/lib/apps/webhook";
import { connectionsStatus } from "@/lib/connections";
import { withStore } from "@/lib/db/client";
import { auditLog, membership, users } from "@/lib/db/schema";
import { readIntegration } from "@/lib/integrations";
import { createMcpToken, listMcpTokens } from "@/lib/mcp/tokens";
import { MCP_EXCLUDED, mcpTools } from "@/lib/mcp/tools";
import { startFakeApp, type FakeApp } from "./apps-helpers";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
let app: FakeApp;
beforeAll(async () => {
  t = await createTestDb();
  app = await startFakeApp();
});
afterAll(async () => {
  setAppWebhookForTests();
  await app.close();
  await t.drop();
});

/** Nomes resolvem para um IP público de documentação; loopback desligado (o padrão do painel em produção). */
const publicDns = () => setAppWebhookForTests({ allowLoopback: false, lookup: async () => ["93.184.216.34"] });
/** App falso em loopback: só nos testes de envio. */
const loopback = () => setAppWebhookForTests({ allowLoopback: true });
beforeEach(publicDns);

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? e.code : String(e)));
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ActionError);
const as = (storeId: string, role: Role = "owner") => ({ storeId, actor: { kind: "user", userId: randomUUID(), role } as Actor, origin: "panel" as const });
const sign = (secret: string, body: string, ts: string) => createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
/** `t=<unix>,v1=<hex>` → partes. */
const sigParts = (h: string) => Object.fromEntries(h.split(",").map((kv) => kv.split("=") as [string, string])) as { t: string; v1: string };

let seq = 0;
async function store() {
  const { storeId } = await seedStore("Loja do app");
  return { storeId, panel: as(storeId), path: `/conexao/${++seq}` };
}

describe("connections.saveAppWebhook", () => {
  test("URL http, https em IP de loopback ou privado e URL com usuário e senha → invalid_input; nada é gravado", async () => {
    const { storeId, panel } = await store();
    for (const url of ["http://app.exemplo.com.br/webhook", "https://127.0.0.1/webhook", "https://10.0.0.1/webhook", "https://user:pw@x.com/webhook", "não é url"]) {
      expect([url, await code(runAction(saveAppWebhook, panel, { url }))]).toEqual([url, "invalid_input"]);
    }
    // Nome que resolve para endereço privado também é recusado (a mesma regra do envio).
    setAppWebhookForTests({ allowLoopback: false, lookup: async () => ["10.1.2.3"] });
    expect(await code(runAction(saveAppWebhook, panel, { url: "https://interno.exemplo.com.br/webhook" }))).toBe("invalid_input");
    expect(await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook"))).toBeNull();
  });

  test("mensagens claras: https obrigatório e sem usuário e senha", async () => {
    const { panel } = await store();
    expect((await failure(runAction(saveAppWebhook, panel, { url: "http://app.exemplo.com.br/webhook" })))?.message).toContain("https");
    expect((await failure(runAction(saveAppWebhook, panel, { url: "https://user:pw@x.com/webhook" })))?.message).toContain("usuário e senha");
  });

  test("primeira gravação devolve o segredo uma vez; a seguinte não; o status mostra só 'configurado'", async () => {
    const { storeId, panel } = await store();
    const first = await runAction(saveAppWebhook, panel, { url: "https://app.exemplo.com.br/funil/webhook" });
    expect(typeof first.secret).toBe("string");
    expect(first.secret!.length).toBeGreaterThanOrEqual(43);
    const secret = first.secret!;

    const second = await runAction(saveAppWebhook, panel, { url: "https://app.exemplo.com.br/funil/webhook-novo" });
    expect(second.secret).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain(secret);

    const conn = await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook"));
    expect(conn?.secret).toBe(secret);
    expect(conn?.config.url).toBe("https://app.exemplo.com.br/funil/webhook-novo");

    const st = await runAction(connectionsStatus, panel, {});
    expect(st.app).toMatchObject({ url: "https://app.exemplo.com.br/funil/webhook-novo", secret: "configured" });
    expect(JSON.stringify(st)).not.toContain(secret);

    // Auditoria das duas gravações sem o segredo (e sem o caminho da URL, que pode carregar credencial do app).
    const audits = await withStore(storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "connections.saveAppWebhook")));
    expect(audits).toHaveLength(2);
    const raw = JSON.stringify(audits);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("/funil/webhook");
  });

  test("hosts de retorno: só nomes de host (sem esquema, caminho, porta nem IP), no máximo 10; gravados em minúsculas em config.returnHosts", async () => {
    const { storeId, panel } = await store();
    const url = "https://app.exemplo.com.br/webhook";
    for (const bad of [["https://app.exemplo.com.br"], ["app.exemplo.com.br/retorno"], ["app.exemplo.com.br:8443"], ["203.0.113.9"], ["localhost"], ["-x.exemplo.com"], ["a b.com"]]) {
      expect([bad, await code(runAction(saveAppWebhook, panel, { url, returnHosts: bad }))]).toEqual([bad, "invalid_input"]);
    }
    const eleven = Array.from({ length: 11 }, (_, i) => `h${i}.exemplo.com.br`);
    expect(await code(runAction(saveAppWebhook, panel, { url, returnHosts: eleven }))).toBe("invalid_input");

    await runAction(saveAppWebhook, panel, { url, returnHosts: [" App.Exemplo.com.br ", "exemplo.com.br", "app.exemplo.com.br"] });
    const conn = await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook"));
    expect(conn?.config.returnHosts).toEqual(["app.exemplo.com.br", "exemplo.com.br"]);
    // Omitido mantém; lista vazia apaga.
    await runAction(saveAppWebhook, panel, { url });
    expect((await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook")))?.config.returnHosts).toEqual(["app.exemplo.com.br", "exemplo.com.br"]);
    await runAction(saveAppWebhook, panel, { url, returnHosts: [] });
    expect((await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook")))?.config.returnHosts).toEqual([]);
    expect((await runAction(connectionsStatus, panel, {})).app?.returnHosts).toEqual([]);
  });

  test("origem pública do app: só https e só a origem; gravada sem barra final em config.publicOrigin; null apaga", async () => {
    const { storeId, panel } = await store();
    const url = "https://app.exemplo.com.br/webhook";
    for (const bad of ["http://app.exemplo.com.br", "https://app.exemplo.com.br/cadastro", "https://app.exemplo.com.br/?x=1", "https://u:p@app.exemplo.com.br", "app.exemplo.com.br"]) {
      expect([bad, await code(runAction(saveAppWebhook, panel, { url, publicOrigin: bad }))]).toEqual([bad, "invalid_input"]);
    }
    await runAction(saveAppWebhook, panel, { url, publicOrigin: "https://App.Exemplo.com.br/" });
    expect((await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook")))?.config.publicOrigin).toBe("https://app.exemplo.com.br");
    expect((await runAction(connectionsStatus, panel, {})).app?.publicOrigin).toBe("https://app.exemplo.com.br");
    await runAction(saveAppWebhook, panel, { url, publicOrigin: null });
    expect((await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook")))?.config.publicOrigin).toBeUndefined();
  });

  test("papel admin (sem connections.write) não salva, não gira o segredo e não testa", async () => {
    const { storeId } = await store();
    const admin = as(storeId, "admin");
    expect(await code(runAction(saveAppWebhook, admin, { url: "https://app.exemplo.com.br/webhook" }))).toBe("forbidden");
    expect(await code(runAction(rotateAppWebhookSecret, admin, {}))).toBe("forbidden");
    expect(await code(runAction(testAppWebhook, admin, {}))).toBe("forbidden");
  });
});

describe("connections.rotateAppWebhookSecret e connections.testAppWebhook", () => {
  test("ping chega ao app assinado com o segredo; devolve o código HTTP; corpo sem segredo", async () => {
    const { panel, path } = await store();
    loopback();
    const { secret } = await runAction(saveAppWebhook, panel, { url: `${app.base}${path}` });
    const r = await runAction(testAppWebhook, panel, {});
    expect(r).toEqual({ httpStatus: 200 });
    const [hit] = app.hitsOf(path);
    expect(hit?.method).toBe("POST");
    const body = JSON.parse(hit!.body) as { id: string; tipo: string; criado_em: string; dados: unknown };
    expect(body.tipo).toBe("ping");
    expect(body.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(hit!.headers["funil-evento"]).toBe(body.id);
    const sig = sigParts(String(hit!.headers["funil-assinatura"]));
    expect(Math.abs(Number(sig.t) - Date.now() / 1000)).toBeLessThan(60);
    expect(sig.v1).toBe(sign(secret!, hit!.body, sig.t));
    expect(hit!.body).not.toContain(secret!);
  });

  test("app respondendo fora de 2xx → erro com o código HTTP", async () => {
    const { panel, path } = await store();
    loopback();
    await runAction(saveAppWebhook, panel, { url: `${app.base}${path}` });
    app.plan(path, [500]);
    const e = await failure(runAction(testAppWebhook, panel, {}));
    expect(e?.code).toBe("provider_error");
    expect(e?.message).toBe("O app não respondeu com 2xx (HTTP 500)");
  });

  test("sem webhook configurado: testar e girar o segredo → conflict", async () => {
    const { panel } = await store();
    expect(await code(runAction(testAppWebhook, panel, {}))).toBe("conflict");
    expect(await code(runAction(rotateAppWebhookSecret, panel, {}))).toBe("conflict");
  });

  test("rotação devolve um segredo novo uma vez e invalida o anterior (assinatura velha não confere)", async () => {
    const { storeId, panel, path } = await store();
    loopback();
    const { secret: old } = await runAction(saveAppWebhook, panel, { url: `${app.base}${path}` });
    const rotated = await runAction(rotateAppWebhookSecret, panel, {});
    expect(typeof rotated.secret).toBe("string");
    expect(rotated.secret).not.toBe(old);
    expect((await withStore(storeId, (tx) => readIntegration(tx, storeId, "app_webhook")))?.secret).toBe(rotated.secret);

    await runAction(testAppWebhook, panel, {});
    const hit = app.hitsOf(path).at(-1)!;
    const sig = sigParts(String(hit.headers["funil-assinatura"]));
    expect(sig.v1).toBe(sign(rotated.secret, hit.body, sig.t));
    expect(sig.v1).not.toBe(sign(old!, hit.body, sig.t));

    const audits = await withStore(storeId, (tx) =>
      tx.select().from(auditLog).where(inArray(auditLog.action, ["connections.saveAppWebhook", "connections.rotateAppWebhookSecret", "connections.testAppWebhook"])),
    );
    expect(audits.map((a) => a.action).sort()).toEqual(["connections.rotateAppWebhookSecret", "connections.saveAppWebhook", "connections.testAppWebhook"]);
    const raw = JSON.stringify(audits);
    expect(raw).not.toContain(old!);
    expect(raw).not.toContain(rotated.secret);
  });
});

describe("MCP", () => {
  const ACTIONS = ["connections.saveAppWebhook", "connections.rotateAppWebhookSecret", "connections.testAppWebhook"];

  test("as três ações ficam fora do MCP (nenhum papel as vê) e as duas que devolvem o segredo são sensíveis", () => {
    for (const a of ACTIONS) expect([a, Object.hasOwn(MCP_EXCLUDED, a)]).toEqual([a, true]);
    const owner = mcpTools("owner").map((x) => x.action);
    for (const a of ACTIONS) expect(owner).not.toContain(a);
    expect(saveAppWebhook.sensitive).toBe(true);
    expect(rotateAppWebhookSecret.sensitive).toBe(true);
    expect([saveAppWebhook.permission, rotateAppWebhookSecret.permission, testAppWebhook.permission]).toEqual(["connections.write", "connections.write", "connections.write"]);
  });

  test("token (mesmo dono) chamando direto: as sensíveis exigem aprovação; o status não mostra a URL", async () => {
    const { storeId, panel } = await store();
    await runAction(saveAppWebhook, panel, { url: "https://app.exemplo.com.br/webhook/c4e1" });
    const token = { storeId, actor: { kind: "token", tokenId: randomUUID(), role: "owner" } as Actor, origin: "mcp" as const };
    expect(await code(runAction(saveAppWebhook, token, { url: "https://app.exemplo.com.br/webhook" }))).toBe("approval_required");
    expect(await code(runAction(rotateAppWebhookSecret, token, {}))).toBe("approval_required");
    const st = await runAction(connectionsStatus, token, {});
    expect(st.app).toMatchObject({ url: null, secret: "configured" });
    expect(JSON.stringify(st)).not.toContain("webhook/c4e1");
  });
});

describe("chaves de integração", () => {
  async function ownerStore() {
    const { storeId } = await seedStore("Loja com chave");
    const [u] = await t.ownerDb.insert(users).values({ email: `dono-${randomUUID()}@example.com`, name: "Dona Ana", passwordHash: "x" }).returning({ id: users.id });
    await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role: "owner" });
    return { storeId, panel: { storeId, actor: { kind: "user", userId: u!.id, role: "owner" } as Actor, origin: "panel" as const } };
  }

  test("a tela de Tokens MCP (padrão) não lista as chaves integration; o cartão do app lista só elas", async () => {
    const { panel } = await ownerStore();
    const mcp = await runAction(createMcpToken, panel, { name: "Claude da loja", role: "reader" });
    const key = await runAction(createMcpToken, panel, { name: "PeticionaAqui", role: "integration" });
    expect((await runAction(listMcpTokens, panel, {})).map((x) => x.id)).toEqual([mcp.id]);
    expect((await runAction(listMcpTokens, panel, { kind: "mcp" })).map((x) => x.id)).toEqual([mcp.id]);
    expect((await runAction(listMcpTokens, panel, { kind: "integration" })).map((x) => x.id)).toEqual([key.id]);
  });
});
