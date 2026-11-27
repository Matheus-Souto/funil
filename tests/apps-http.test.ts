// Borda HTTP da API de integração (src/lib/apps/http.ts): só a chave `integration` da loja autentica, corpo até 32 KB,
// JSON, 60 requisições por minuto por chave, ActionError → status HTTP com `{ erro: { codigo, mensagem } }`.
// Nenhum literal com o formato do token: tudo montado em tempo de execução.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ActionError } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { handleIntegrationRequest } from "@/lib/apps/http";
import { mcpToken } from "@/lib/db/schema";
import { mintMcpToken } from "@/lib/mcp/tokens";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

/** Instante fixo no meio do minuto atual: as contagens dos limites nunca atravessam a virada da janela. */
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
const OPTS = { now: () => NOW, trustProxy: 0 };

async function mkToken(storeId: string, role: Role, opts: { revoked?: boolean } = {}) {
  const { token, hash, last4 } = mintMcpToken(storeId);
  const [row] = await t.ownerDb
    .insert(mcpToken)
    .values({ storeId, name: `chave ${role}`, role, tokenHash: hash, last4, ...(opts.revoked ? { revokedAt: new Date() } : {}) })
    .returning({ id: mcpToken.id });
  return { token, id: row!.id };
}

function req(body: string, token?: string): Request {
  return new Request("http://localhost:3000/api/integracao/v1/testes", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
}

type Seen = { storeId: string; actor: unknown; origin: string; body: unknown };
const echo = (seen: Seen[]) => async (call: { storeId: string; actor: unknown; origin: "api" }, body: unknown) => {
  seen.push({ ...call, body });
  return { status: 201, body: { id: "x" } };
};

describe("handleIntegrationRequest", () => {
  test("sem token, token reader e chave integration revogada → 401 com o mesmo corpo, sem chamar a ação", async () => {
    const { storeId } = await seedStore("API A");
    const reader = await mkToken(storeId, "reader");
    const revoked = await mkToken(storeId, "integration", { revoked: true });
    const seen: Seen[] = [];
    const bodies = new Set<string>();
    for (const token of [undefined, reader.token, revoked.token]) {
      const res = await handleIntegrationRequest(req("{}", token), echo(seen), OPTS);
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]!)).toMatchObject({ erro: { codigo: "unauthorized" } });
    expect(seen).toHaveLength(0);
  });

  test("chave integration válida: a ação recebe a loja, o ator token com papel integration, origem api e o corpo", async () => {
    const { storeId } = await seedStore("API B");
    const key = await mkToken(storeId, "integration");
    const seen: Seen[] = [];
    const res = await handleIntegrationRequest(req(JSON.stringify({ conta: "c1" }), key.token), echo(seen), OPTS);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "x" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(seen).toEqual([{ storeId, actor: { kind: "token", tokenId: key.id, role: "integration" }, origin: "api", body: { conta: "c1" } }]);
  });

  test("corpo > 32 KB → 413; JSON inválido → 400", async () => {
    const { storeId } = await seedStore("API C");
    const key = await mkToken(storeId, "integration");
    const seen: Seen[] = [];
    const big = await handleIntegrationRequest(req(JSON.stringify({ x: "a".repeat(33 * 1024) }), key.token), echo(seen), OPTS);
    expect(big.status).toBe(413);
    const bad = await handleIntegrationRequest(req("{nao é json", key.token), echo(seen), OPTS);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ erro: { codigo: "invalid_json" } });
    expect(seen).toHaveLength(0);
  });

  test("61ª chamada no minuto com a mesma chave → 429; outra chave segue", async () => {
    const { storeId } = await seedStore("API D");
    const key = await mkToken(storeId, "integration");
    const other = await mkToken(storeId, "integration");
    const seen: Seen[] = [];
    for (let i = 0; i < 60; i += 10) {
      const got = await Promise.all(Array.from({ length: 10 }, () => handleIntegrationRequest(req("{}", key.token), echo(seen), OPTS).then((r) => r.status)));
      expect(got.every((s) => s === 201)).toBe(true);
    }
    const over = await handleIntegrationRequest(req("{}", key.token), echo(seen), OPTS);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ erro: { codigo: "rate_limited" } });
    expect((await handleIntegrationRequest(req("{}", other.token), echo(seen), OPTS)).status).toBe(201);
  });

  test("ActionError vira status HTTP com { erro: { codigo, mensagem } }; erro inesperado → 500 sem a mensagem", async () => {
    const { storeId } = await seedStore("API E");
    const key = await mkToken(storeId, "integration");
    const cases: [ActionError | Error, number, string][] = [
      [new ActionError("conflict", "Já existe"), 409, "conflict"],
      [new ActionError("invalid_input", "Entrada inválida", [{ path: ["email"], message: "E-mail inválido", code: "custom" }]), 422, "invalid_input"],
      [new ActionError("not_found", "Nada"), 404, "not_found"],
      [new ActionError("forbidden", "Sem permissão"), 403, "forbidden"],
      [new ActionError("rate_limited", "Calma"), 429, "rate_limited"],
      [new ActionError("provider_error", "Fora"), 500, "provider_error"],
      [new Error("segredo interno"), 500, "internal"],
    ];
    for (const [err, status, codigo] of cases) {
      const res = await handleIntegrationRequest(req("{}", key.token), async () => {
        throw err;
      }, OPTS);
      expect([codigo, res.status]).toEqual([codigo, status]);
      const body = (await res.json()) as { erro: { codigo: string; mensagem: string; detalhes?: unknown } };
      expect(body.erro.codigo).toBe(codigo);
      if (err instanceof ActionError) expect(body.erro.mensagem).toBe(err.message);
      else expect(JSON.stringify(body)).not.toContain("segredo interno");
    }
    const invalid = await handleIntegrationRequest(req("{}", key.token), async () => {
      throw new ActionError("invalid_input", "Entrada inválida", [{ path: ["email"], message: "E-mail inválido", code: "custom" }]);
    }, OPTS);
    expect(await invalid.json()).toEqual({ erro: { codigo: "invalid_input", mensagem: "Entrada inválida", detalhes: [{ campo: "email", mensagem: "E-mail inválido" }] } });
  });

  test("só POST: outro método → 405", async () => {
    const res = await handleIntegrationRequest(new Request("http://localhost:3000/api/integracao/v1/testes", { method: "GET" }), echo([]), OPTS);
    expect(res.status).toBe(405);
  });
});
