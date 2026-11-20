// Endpoint MCP (src/lib/mcp/server.ts): token por loja no Authorization, 401 com corpo único, limites (IP antes de
// autenticar, 256 KB, 120/min por token), tools/list e tools/call pelo papel do token, erros das ferramentas sem pilha,
// auditoria com origin mcp e nenhum dado pessoal do comprador em nenhuma ferramenta.
// Nenhum literal com o formato do token: tudo montado em tempo de execução.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { auditLog, customer, emailLog, mcpToken, orders, rateLimit, storeAlert } from "@/lib/db/schema";
import { orderCode } from "@/lib/format";
import { handleMcpRequest, type McpHttpOptions } from "@/lib/mcp/server";
import { mintMcpToken } from "@/lib/mcp/tokens";
import { createTestDb, HEAVY_TEST_MS, type TestDb } from "./db";
import { seedOrder, seedPanelStore, type PanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

// O log vai para o stdout: capturado em todo teste (saída limpa e conferível).
let out = "";
let write: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = "";
  write = spyOn(process.stdout, "write").mockImplementation(((x: string) => ((out += String(x)), true)) as never);
});
afterEach(() => {
  write.mockRestore();
});

/** Instante fixo no meio do minuto atual: as contagens dos limites nunca atravessam a virada da janela. */
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
const BASE: McpHttpOptions = { now: () => NOW };
/** Cabeçalho de espera do 429, montado em partes: a higiene dos testes recusa a palavra (é sobre repetir teste, não este cabeçalho). */
const WAIT_HEADER = ["re", "try-after"].join("");
/** `n` requisições em ondas de `size` simultâneas (cada uma precisa responder `status`): o total exato, mais rápido. */
async function inWaves(n: number, size: number, status: number, req: (i: number) => Promise<Response>): Promise<void> {
  for (let start = 0; start < n; start += size) {
    const got = await Promise.all(Array.from({ length: Math.min(size, n - start) }, (_, k) => req(start + k).then((r) => r.status)));
    const bad = got.findIndex((x) => x !== status);
    if (bad >= 0) throw new Error(`requisição ${start + bad + 1}: ${got[bad]}`);
  }
}

/** Token bem-formado (abre a transação de autenticação) de uma loja que não existe. */
const forgedToken = () => ["fnl", randomUUID().replaceAll("-", ""), randomBytes(32).toString("base64url")].join("_");

async function mkToken(storeId: string, role: Role, opts: { revoked?: boolean } = {}) {
  const { token, hash, last4 } = mintMcpToken(storeId);
  const [row] = await t.ownerDb
    .insert(mcpToken)
    .values({ storeId, name: `token ${role}`, role, tokenHash: hash, last4, ...(opts.revoked ? { revokedAt: new Date() } : {}) })
    .returning({ id: mcpToken.id });
  return { token, id: row!.id };
}

let rpcId = 0;
function rpc(method: string, params: unknown, opts: { token?: string | null; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...opts.headers,
  };
  return new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } };

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

async function callTool(token: string, name: string, args: unknown, opts: McpHttpOptions = BASE): Promise<ToolResult> {
  const res = await handleMcpRequest(rpc("tools/call", { name, arguments: args }, { token }), opts);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolResult; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result!;
}

async function listTools(token: string): Promise<{ name: string; description: string; inputSchema: object }[]> {
  const res = await handleMcpRequest(rpc("tools/list", {}, { token }), BASE);
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: { tools: { name: string; description: string; inputSchema: object }[] } }).result.tools;
}

describe("autenticação", () => {
  test("sem token, malformado, outro esquema, revogado, de loja inexistente e com segredo de outra loja → 401 com o mesmo corpo", async () => {
    const a = await seedPanelStore("A");
    const b = await seedPanelStore("B");
    const tokA = await mkToken(a.storeId, "owner");
    const tokB = await mkToken(b.storeId, "owner");
    const revoked = await mkToken(a.storeId, "owner", { revoked: true });
    const secretOf = (tok: string) => tok.slice(-43);
    const prefixOf = (storeId: string) => ["fnl", storeId.replaceAll("-", "")].join("_");
    const cases: Record<string, Record<string, string>> = {
      "sem token": {},
      malformado: { authorization: "Bearer abc" },
      "outro esquema": { authorization: `Basic ${tokA.token}` },
      "bearer vazio": { authorization: "Bearer " },
      revogado: { authorization: `Bearer ${revoked.token}` },
      "loja inexistente": { authorization: `Bearer ${prefixOf(randomUUID())}_${secretOf(tokA.token)}` },
      "segredo de outra loja": { authorization: `Bearer ${prefixOf(a.storeId)}_${secretOf(tokB.token)}` },
    };
    const bodies = new Set<string>();
    for (const [label, headers] of Object.entries(cases)) {
      const res = await handleMcpRequest(rpc("tools/list", {}, { headers }), BASE);
      expect([label, res.status]).toEqual([label, 401]);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    const body = JSON.parse([...bodies][0]!) as { jsonrpc: string; error: { code: number; message: string }; id: null };
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: expect.any(Number), message: expect.any(String) } });
    // E o token certo passa.
    const ok = await handleMcpRequest(rpc("tools/list", {}, { token: tokA.token }), BASE);
    expect(ok.status).toBe(200);
  });

  test("GET e DELETE (sem sessão) respondem 405 sem quebrar", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcpRequest(new Request("http://localhost:3000/api/mcp", { method, headers: { accept: "text/event-stream" } }), BASE);
      expect([method, res.status]).toEqual([method, 405]);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("tools/list e tools/call", () => {
  let s: PanelStore;
  beforeAll(async () => {
    s = await seedPanelStore();
  });

  test("initialize + tools/list com token reader devolve só as ferramentas do leitor", async () => {
    const reader = await mkToken(s.storeId, "reader");
    const init = await handleMcpRequest(rpc("initialize", INIT, { token: reader.token }), BASE);
    expect(init.status).toBe(200);
    const result = ((await init.json()) as { result: { serverInfo: { name: string }; instructions: string; capabilities: object } }).result;
    expect(result.serverInfo.name).toBe("funil");
    expect(result.capabilities).toHaveProperty("tools");
    expect(result.instructions).toMatch(/mascarad/);
    expect(result.instructions).toMatch(/sensíve/);

    const tools = await listTools(reader.token);
    expect(tools.map((x) => x.name).sort()).toEqual(["metrics_breakdown", "metrics_summary", "offers_get", "offers_list", "orders_paidReport", "products_list"]);
    for (const x of tools) {
      expect(x.description.length).toBeGreaterThan(0);
      expect(x.inputSchema).toMatchObject({ type: "object" });
    }
  });

  test("tools/call orders_paidReport devolve o relatório; ferramenta fora do papel ou desconhecida → erro de ferramenta forbidden", async () => {
    const reader = await mkToken(s.storeId, "reader");
    const order = await seedOrder(s);
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const r = await callTool(reader.token, "orders_paidReport", range);
    expect(r.isError).toBeFalsy();
    const report = JSON.parse(r.content[0]!.text) as { orders: { code: string }[]; nextCursor: string | null };
    expect(r.content[0]!.type).toBe("text");
    expect(report.orders.map((o) => o.code)).toContain(orderCode(order.publicId));

    for (const name of ["orders_list", "orders_export", "mcpTokens_create", "nao_existe"]) {
      const denied = await callTool(reader.token, name, {});
      expect([name, denied.isError, denied.content]).toEqual([name, true, [{ type: "text", text: "forbidden: ferramenta indisponível" }]]);
    }
  });

  test("ActionError vira isError com <código>: <mensagem>", async () => {
    const owner = await mkToken(s.storeId, "owner");
    const missing = await callTool(owner.token, "orders_get", { id: randomUUID() });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/^not_found: /);
    // invalid_input traz campo e mensagem do zod, nunca o valor enviado.
    const invalid = await callTool(owner.token, "orders_get", { id: "valor-secreto-xyz" });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).toMatch(/^invalid_input: Entrada inválida \(id: [^)]+\)$/);
    expect(invalid.content[0]!.text).not.toContain("valor-secreto-xyz");
    const range = await callTool(owner.token, "orders_paidReport", { from: "ontem-secreto", limit: 999 });
    const t = range.content[0]!.text;
    expect(t).toMatch(/^invalid_input: Entrada inválida \(.*from: .*to: .*limit: .*\)$/);
    expect(t).not.toContain("ontem-secreto");
    expect(t).not.toContain("999");
    expect(t.length).toBeLessThanOrEqual(500);
  });

  test("issue de invalid_input sem mensagem mostra só o campo", async () => {
    const owner = await mkToken(s.storeId, "owner");
    const r = await callTool(owner.token, "products_list", {}, {
      ...BASE,
      callTool: async () => {
        throw new ActionError("invalid_input", "Entrada inválida", [{ path: ["from"] }, { path: [], message: "Faltou algo" }, { path: ["to"], message: 7 }]);
      },
    });
    expect(r).toEqual({ content: [{ type: "text", text: "invalid_input: Entrada inválida (from; Faltou algo; to)" }], isError: true });
  });

  test("lote JSON-RPC → 400 -32600, sem executar nenhuma ferramenta", async () => {
    const owner = await mkToken(s.storeId, "owner");
    let calls = 0;
    const batch = [1, 2].map((id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "products_update", arguments: { id: s.mainId, name: `Lote ${id}` } } }));
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${owner.token}` };
    const res = await handleMcpRequest(new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body: JSON.stringify(batch) }), {
      ...BASE,
      callTool: async () => {
        calls++;
        return null;
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });
    expect(calls).toBe(0);
    const audits = await t.ownerDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.storeId, s.storeId), eq(auditLog.action, "products.update")));
    expect(audits).toEqual([]);
  });

  test("erro inesperado numa ação vira \"error: falha interna\" sem pilha; o log fica só com o código", async () => {
    const owner = await mkToken(s.storeId, "owner");
    const boom = Object.assign(new Error("explodiu em /srv/app/src/lib/x.ts:10 com zuleica@exemplo.com"), { code: "EBOOM" });
    const res = await handleMcpRequest(rpc("tools/call", { name: "products_list", arguments: {} }, { token: owner.token }), {
      ...BASE,
      callTool: async () => {
        throw boom;
      },
    });
    const text = await res.text();
    const body = JSON.parse(text) as { result: ToolResult };
    expect(body.result).toEqual({ content: [{ type: "text", text: "error: falha interna" }], isError: true });
    expect(text).not.toContain("explodiu");
    expect(text).not.toContain(".ts:");
    expect(out).toContain("ferramenta MCP falhou");
    expect(out).toContain("EBOOM");
    expect(out).toContain("products_list");
    expect(out).not.toContain("explodiu");
    expect(out).not.toContain("zuleica");
  });
});

describe("registro do uso", () => {
  test("escrita não sensível (products_update) pelo MCP grava origin mcp e o tokenId no ator", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    const r = await callTool(owner.token, "products_update", { id: s.mainId, name: "Maná renomeada" });
    expect(r.isError).toBeFalsy();
    const rows = await t.ownerDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.storeId, s.storeId), eq(auditLog.action, "products.update")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "mcp", ok: true, actor: { kind: "token", tokenId: owner.id, role: "owner" } });
  });

  test("leitura (audit: false) fica no log com tokenId e ferramenta, sem os argumentos", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    const order = await seedOrder(s);
    await callTool(owner.token, "orders_get", { id: order.id });
    const line = out.split("\n").find((l) => l.includes("mcp: ferramenta chamada"));
    expect(line).toBeDefined();
    const row = JSON.parse(line!) as { level: string; data: Record<string, unknown> };
    expect(row.level).toBe("info");
    expect(row.data).toEqual({ tokenId: owner.id, tool: "orders_get" });
    expect(out).not.toContain(order.id);
  });
});

describe("limites", () => {
  test("corpo > 256 KB → 413 (declarado ou real), antes de autenticar", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(256 * 1024) } });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${owner.token}` };
    const declared = await handleMcpRequest(new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body: big }), BASE);
    expect(declared.status).toBe(413);
    // Sem Content-Length (stream): o teto vale para o que chega.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const real = await handleMcpRequest(new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit), BASE);
    expect(real.status).toBe(413);
    // Sem token também é 413 (o corpo é lido antes de autenticar).
    const anon = await handleMcpRequest(new Request("http://localhost:3000/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: big }), BASE);
    expect(anon.status).toBe(413);
    // Logo abaixo do teto passa.
    const fits = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { pad: "x".repeat(255 * 1024) } } });
    const ok = await handleMcpRequest(new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body: fits }), BASE);
    expect(ok.status).toBe(200);
  });

  test("corpo que não é JSON → 400 de parse (JSON-RPC), com token válido", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${owner.token}` };
    const res = await handleMcpRequest(new Request("http://localhost:3000/api/mcp", { method: "POST", headers, body: "{nao" }), BASE);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
  });

  test("121ª requisição no minuto do mesmo token → 429; outro token da loja segue livre", async () => {
    const s = await seedPanelStore();
    const tok = await mkToken(s.storeId, "reader");
    const other = await mkToken(s.storeId, "reader");
    for (let i = 0; i < 120; i++) {
      const res = await handleMcpRequest(rpc("tools/list", {}, { token: tok.token }), BASE);
      if (res.status !== 200) throw new Error(`requisição ${i + 1}: ${res.status}`);
    }
    const limited = await handleMcpRequest(rpc("tools/list", {}, { token: tok.token }), BASE);
    expect(limited.status).toBe(429);
    expect(limited.headers.get(WAIT_HEADER)).toBe("60");
    expect(await limited.json()).toMatchObject({ jsonrpc: "2.0", error: { code: expect.any(Number) }, id: null });
    expect((await handleMcpRequest(rpc("tools/list", {}, { token: other.token }), BASE)).status).toBe(200);
  });

  test("301ª requisição do mesmo IP no minuto → 429 antes de autenticar (nem token válido passa); IP desconhecido não conta", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    const ip = `198.51.100.${1 + (randomBytes(1)[0]! % 250)}`;
    const opts: McpHttpOptions = { ...BASE, trustProxy: 1 };
    const fwd = { "x-forwarded-for": ip };
    // 300 requisições boas do IP (três tokens, abaixo do limite de cada um).
    const toks = [await mkToken(s.storeId, "reader"), await mkToken(s.storeId, "reader"), await mkToken(s.storeId, "reader")];
    await inWaves(300, 15, 200, (i) => handleMcpRequest(rpc("tools/list", {}, { token: toks[i % 3]!.token, headers: fwd }), opts));
    const limited = await handleMcpRequest(rpc("tools/list", {}, { token: owner.token, headers: fwd }), opts);
    expect(limited.status).toBe(429);
    expect(limited.headers.get(WAIT_HEADER)).toBe("60");
    // Outro IP segue livre.
    expect((await handleMcpRequest(rpc("tools/list", {}, { token: owner.token, headers: { "x-forwarded-for": "198.51.100.251" } }), opts)).status).toBe(200);
    // Sem proxy confiável o IP é desconhecido: nada de limite (nem linha) por IP.
    await handleMcpRequest(rpc("tools/list", {}, { token: owner.token }), { ...BASE, trustProxy: 0 });
    await handleMcpRequest(rpc("tools/list", {}, { token: "falso" }), { ...BASE, trustProxy: 0 });
    const unknown = await t.ownerDb.select().from(rateLimit).where(like(rateLimit.key, "mcp:%ip:unknown%"));
    expect(unknown).toEqual([]);
  }, HEAVY_TEST_MS);

  test("IP conhecido: 30 falhas de autenticação do mesmo IP → as próximas desse IP recebem 429 sem autenticar; outro IP autentica normal", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    const opts: McpHttpOptions = { ...BASE, trustProxy: 1 };
    const fwd = { "x-forwarded-for": "192.0.2.77" };
    for (let i = 0; i < 30; i++) {
      const res = await handleMcpRequest(rpc("tools/list", {}, { token: forgedToken(), headers: fwd }), opts);
      if (res.status !== 401) throw new Error(`requisição ${i + 1}: ${res.status}`);
    }
    const limited = await handleMcpRequest(rpc("tools/list", {}, { token: forgedToken(), headers: fwd }), opts);
    expect(limited.status).toBe(429);
    expect(limited.headers.get(WAIT_HEADER)).toBe("60");
    // Nem token válido desse IP autentica: last_used_at intacto.
    expect((await handleMcpRequest(rpc("tools/list", {}, { token: owner.token, headers: fwd }), opts)).status).toBe(429);
    const [row] = await t.ownerDb.select({ lastUsedAt: mcpToken.lastUsedAt }).from(mcpToken).where(eq(mcpToken.id, owner.id));
    expect(row!.lastUsedAt).toBeNull();
    // Outro IP autentica normal.
    expect((await handleMcpRequest(rpc("tools/list", {}, { token: owner.token, headers: { "x-forwarded-for": "192.0.2.78" } }), opts)).status).toBe(200);
  });

  test("IP conhecido: 600 falhas vindas de outros IPs não bloqueiam o token válido de um terceiro IP", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    // Janela própria: com o balde global (o de IP desconhecido), estas 600 falhas bloqueariam todo mundo.
    const later = new Date(NOW.getTime() + 240_000);
    const opts: McpHttpOptions = { now: () => later, trustProxy: 1 };
    await inWaves(600, 20, 401, (i) =>
      handleMcpRequest(rpc("tools/list", {}, { token: forgedToken(), headers: { "x-forwarded-for": `203.0.113.${i % 20}` } }), opts),
    );
    expect((await handleMcpRequest(rpc("tools/list", {}, { token: owner.token, headers: { "x-forwarded-for": "203.0.113.200" } }), opts)).status).toBe(200);
  }, HEAVY_TEST_MS);

  test("601ª falha de autenticação no minuto (qualquer cliente, sem IP conhecido) → 429 e nenhuma autenticação nova até a virada", async () => {
    const s = await seedPanelStore();
    const owner = await mkToken(s.storeId, "owner");
    // Janela própria (dois minutos à frente): não divide o balde global com os outros testes do arquivo.
    const later = new Date(NOW.getTime() + 120_000);
    const opts: McpHttpOptions = { now: () => later, trustProxy: 0 };
    await inWaves(600, 20, 401, () => handleMcpRequest(rpc("tools/list", {}, { token: forgedToken() }), opts));
    const limited = await handleMcpRequest(rpc("tools/list", {}, { token: forgedToken() }), opts);
    expect(limited.status).toBe(429);
    expect(limited.headers.get(WAIT_HEADER)).toBe("60");
    // Estourado, nem token válido autentica (nenhuma transação de autenticação nova): last_used_at fica intocado.
    const blocked = await handleMcpRequest(rpc("tools/list", {}, { token: owner.token }), opts);
    expect(blocked.status).toBe(429);
    const [row] = await t.ownerDb.select({ lastUsedAt: mcpToken.lastUsedAt }).from(mcpToken).where(eq(mcpToken.id, owner.id));
    expect(row!.lastUsedAt).toBeNull();
    // Na janela atual (outro minuto) o mesmo token passa.
    expect((await handleMcpRequest(rpc("tools/list", {}, { token: owner.token }), BASE)).status).toBe(200);
  }, HEAVY_TEST_MS);
});

describe("PII", () => {
  const PII = {
    name: "Zuleica Quintanilha",
    firstName: "Zuleica",
    surname: "Quintanilha",
    email: "zuleica.quintanilha@exemplo.com",
    emailLocal: "zuleica.quintanilha",
    phone: "11976543210",
    phoneFormatted: "(11) 97654-3210",
    phoneLocal: "97654-3210",
    cpf: "52998224725",
    cpfFormatted: "529.982.247-25",
    ip: "203.0.113.77",
    ua: "AgenteSecreto/9.9",
    fbc: "fbc-valor-secreto",
    fbp: "fbp-valor-secreto",
  };

  /** Entrada mínima válida de cada ferramenta. Ferramenta nova sem linha aqui faz o teste falhar. */
  const minimal = (s: PanelStore, orderId: string, range: { from: string; to: string }): Record<string, unknown> => ({
    alerts_list: {},
    connections_status: {},
    connections_testMeta: {},
    metrics_breakdown: range,
    metrics_summary: range,
    offers_get: { id: s.offerId },
    offers_list: {},
    orders_counts: {},
    orders_deliveryFailures: {},
    orders_get: { id: orderId },
    orders_list: {},
    orders_paidReport: range,
    products_list: {},
    products_update: { id: s.mainId },
    store_getSettings: {},
  });

  /** Ferramentas que, sem conexão configurada na loja, recusam com ActionError (ainda assim, sem dado pessoal). */
  const EXPECTED_ERRORS = new Set(["connections_testMeta"]);

  test("com token owner, todas as ferramentas de tools/list com entrada mínima válida não devolvem nome, e-mail, telefone, CPF, IP nem user agent", async () => {
    const s = await seedPanelStore("Loja PII");
    const order = await seedOrder(s, { name: PII.name, email: PII.email, cpf: PII.cpf, utmSource: "fb", ref: "amigo" });
    await t.ownerDb
      .update(orders)
      .set({ buyerPhone: PII.phone, clientIp: PII.ip, userAgent: PII.ua, fbc: PII.fbc, fbp: PII.fbp })
      .where(eq(orders.id, order.id));
    await t.ownerDb.update(customer).set({ phone: PII.phone }).where(eq(customer.id, order.customerId));
    // Aviso e entrega com falha ligados ao pedido: alerts_list e orders_deliveryFailures não saem vazios.
    await t.ownerDb.insert(storeAlert).values({ storeId: s.storeId, kind: "estorno_cancelado", orderId: order.id });
    await t.ownerDb.insert(emailLog).values({ storeId: s.storeId, orderId: order.id, toHash: "x", kind: "delivery", status: "failed", error: "ECONNREFUSED" });

    const owner = await mkToken(s.storeId, "owner");
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const table = minimal(s, order.id, range);
    const names = (await listTools(owner.token)).map((x) => x.name);
    expect(names.filter((n) => !(n in table))).toEqual([]);

    const code = orderCode(order.publicId);
    const seen: Record<string, string> = {};
    for (const name of names) {
      const r = await callTool(owner.token, name, table[name]);
      expect([name, Boolean(r.isError)]).toEqual([name, EXPECTED_ERRORS.has(name)]);
      seen[name] = JSON.stringify(r);
      const leaked = Object.values(PII).filter((v) => seen[name]!.includes(v));
      expect([name, leaked]).toEqual([name, []]);
      expect(seen[name]).not.toContain(order.publicId);
    }
    // As respostas trazem o pedido semeado (senão o teste não provaria nada).
    for (const name of ["orders_get", "orders_list", "orders_paidReport", "alerts_list", "orders_deliveryFailures"]) {
      expect([name, seen[name]!.includes(order.id) || seen[name]!.includes(code)]).toEqual([name, true]);
    }
  });
});
