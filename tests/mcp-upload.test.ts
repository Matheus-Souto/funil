// Upload de PDF por link (D12 e D13): `products.createUploadLink` devolve uma URL de uso único (15 min, só o hash da
// chave no banco) e o PUT nela cria o produto pelo mesmo caminho de `products.create`. A chave só é gasta quando o
// produto é criado; arquivo inválido devolve o erro e a chave segue valendo (até 5 tentativas). Toda chave recusada
// (vencida, usada, de loja inexistente, de token revogado, forjada) recebe o mesmo 404.
// Nenhum literal com o formato da chave ou do token: tudo montado em tempo de execução.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { listProducts } from "@/lib/catalog/products";
import { sha256 } from "@/lib/crypto";
import { auditLog, mcpToken, uploadLink } from "@/lib/db/schema";
import { handleMcpRequest } from "@/lib/mcp/server";
import { mintMcpToken } from "@/lib/mcp/tokens";
import { mcpTools } from "@/lib/mcp/tools";
import { completeUpload, createUploadLink, handleUploadRequest, mintUploadKey, resolveUploadKey } from "@/lib/mcp/uploads";
import { createTestDb, HEAVY_TEST_MS, seedStore, type TestDb } from "./db";
import { VALID_PDF } from "./pdf-fixtures";

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

/** Instante fixo no meio do minuto atual: o limite por IP nunca atravessa a virada da janela. */
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
const BASE = "http://localhost:3000";
const MB = 1_048_576;
const LIMIT = 52_428_800;
const INVALID = { error: "Link de upload inválido ou vencido." };
/** Prefixo da chave montado em partes (nenhum literal com o formato da chave). */
const KEY_PREFIX = ["up", "l_"].join("");

async function mkToken(storeId: string, role: Role = "owner") {
  const { token, hash, last4 } = mintMcpToken(storeId);
  const [row] = await t.ownerDb.insert(mcpToken).values({ storeId, name: `token ${role}`, role, tokenHash: hash, last4 }).returning({ id: mcpToken.id });
  return { token, id: row!.id, actor: { kind: "token", tokenId: row!.id, role } as Actor };
}

const owner: Actor = { kind: "user", userId: randomUUID(), role: "owner" };
const list = (storeId: string) => runAction(listProducts, { storeId, actor: owner, origin: "panel" }, {});
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? e.code : String(e)));

type Link = { uploadUrl: string; method: string; contentType: string; maxBytes: number; expiresAt: string };

/** Pede o link pelo endpoint MCP (como o agente faz). */
async function createLinkViaMcp(token: string, args: unknown = { name: "Curso", fileName: "curso.pdf" }) {
  const req = new Request(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "products_createUploadLink", arguments: args } }),
  });
  const res = await handleMcpRequest(req, { now: () => NOW });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return body.result;
}

/** Link criado direto pela ação, com ator token; devolve a chave. */
async function createLink(storeId: string, actor: Actor, name = "Curso"): Promise<string> {
  const link = await runAction(createUploadLink, { storeId, actor, origin: "mcp" }, { name, fileName: `${name}.pdf` });
  return link.uploadUrl.slice(`${BASE}/api/mcp/upload/`.length);
}

function put(key: string, body: BodyInit | null, opts: { headers?: Record<string, string>; method?: string; trustProxy?: number; now?: Date } = {}) {
  const req = new Request(`${BASE}/api/mcp/upload/${key}`, {
    method: opts.method ?? "PUT",
    headers: { "content-type": "application/pdf", ...opts.headers },
    body,
    // @ts-expect-error necessário para corpo em stream no runtime
    duplex: "half",
  });
  return handleUploadRequest(req, key, { now: () => opts.now ?? NOW, trustProxy: opts.trustProxy ?? 0 });
}

/** Corpo infinito de pedaços de 1 MB que conta quantos pedaços foram puxados. */
function endless() {
  const state = { pulls: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        state.pulls++;
        c.enqueue(new Uint8Array(MB));
      },
    },
    { highWaterMark: 0 },
  );
  return { state, body };
}

describe("products.createUploadLink", () => {
  test("createUploadLink devolve URL com chave no formato e expiresAt em 15 min; o banco guarda só o hash; auditoria sem a URL", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    const r = await createLinkViaMcp(tok.token);
    expect(r.isError).toBeFalsy();
    const link = JSON.parse(r.content[0]!.text) as Link;
    expect(Object.keys(link).sort()).toEqual(["contentType", "expiresAt", "maxBytes", "method", "uploadUrl"]);
    expect(link).toMatchObject({ method: "PUT", contentType: "application/pdf", maxBytes: LIMIT });
    const keyRe = new RegExp(`^${BASE}/api/mcp/upload/(${KEY_PREFIX}${storeId.replaceAll("-", "")}_[A-Za-z0-9_-]{43})$`);
    const key = keyRe.exec(link.uploadUrl)?.[1];
    expect(key).toBeDefined();
    const ttl = new Date(link.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 5_000);

    const rows = await t.ownerDb.select().from(uploadLink).where(eq(uploadLink.storeId, storeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenId: tok.id, name: "Curso", fileName: "curso.pdf", keyHash: sha256(key!), attempts: 0, usedAt: null, productId: null });
    const secret = key!.slice(-43);
    expect(JSON.stringify(rows)).not.toContain(secret);

    const audit = await t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId));
    const created = audit.find((a) => a.action === "products.createUploadLink");
    expect(created).toMatchObject({ ok: true, origin: "mcp", input: { name: "Curso", fileName: "curso.pdf" } });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(out).not.toContain(secret);
  });

  test("só ator token: membro do painel → forbidden", async () => {
    const { storeId } = await seedStore();
    expect(await codeOf(runAction(createUploadLink, { storeId, actor: owner, origin: "panel" }, { name: "Curso", fileName: "c.pdf" }))).toBe("forbidden");
  });

  test("11º link aberto na loja → rate_limited", async () => {
    const { storeId } = await seedStore();
    const a = await mkToken(storeId);
    const b = await mkToken(storeId);
    for (let i = 0; i < 10; i++) await createLink(storeId, i % 2 ? a.actor : b.actor, `Curso ${i}`);
    const r = await createLinkViaMcp(a.token);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toStartWith("rate_limited:");
    // Link usado ou vencido não conta como aberto.
    await t.ownerDb.update(uploadLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadLink.name, "Curso 0"));
    expect((await createLinkViaMcp(a.token)).isError).toBeFalsy();
  });

  test("21º link do token na hora → rate_limited (mesmo com os anteriores já usados)", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    await t.ownerDb.insert(uploadLink).values(
      Array.from({ length: 20 }, (_, i) => ({
        storeId,
        tokenId: tok.id,
        name: `Usado ${i}`,
        fileName: "u.pdf",
        keyHash: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 600_000),
        usedAt: new Date(),
      })),
    );
    expect(await codeOf(createLink(storeId, tok.actor))).toBe("rate_limited");
    // Outro token da mesma loja segue podendo.
    const other = await mkToken(storeId);
    expect(await codeOf(createLink(storeId, other.actor))).toBe("ok");
  });

  test("token reader não vê products_createUploadLink; owner e admin veem", () => {
    expect(mcpTools("reader").map((x) => x.name)).not.toContain("products_createUploadLink");
    for (const role of ["owner", "admin"] as const) expect(mcpTools(role).map((x) => x.name)).toContain("products_createUploadLink");
    for (const role of ["owner", "admin", "reader"] as const) expect(mcpTools(role).map((x) => x.name)).not.toContain("products_completeUpload");
  });

  test("mintUploadKey: prefixo, loja sem hífens, 43 caracteres de segredo e sha256 da chave inteira", () => {
    const storeId = randomUUID();
    const { key, hash } = mintUploadKey(storeId);
    expect(key.startsWith(`${KEY_PREFIX}${storeId.replaceAll("-", "")}_`)).toBe(true);
    expect(key.length).toBe(KEY_PREFIX.length + 32 + 1 + 43);
    expect(hash).toBe(sha256(key));
  });
});

describe("PUT /api/mcp/upload/[key]", () => {
  test("PUT de PDF válido cria o produto (aparece em products.list) e devolve 201; segundo PUT na mesma chave → 404", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    const key = await createLink(storeId, tok.actor);
    const res = await put(key, VALID_PDF as BodyInit);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; fileName: string; fileSize: number };
    expect(Object.keys(body).sort()).toEqual(["fileName", "fileSize", "id", "name"]);
    expect(body).toMatchObject({ name: "Curso", fileName: "Curso.pdf", fileSize: VALID_PDF.length });
    expect((await list(storeId)).map((p) => p.id)).toEqual([body.id]);
    const [row] = await t.ownerDb.select().from(uploadLink).where(eq(uploadLink.keyHash, sha256(key)));
    expect(row!.productId).toBe(body.id);
    expect(row!.usedAt).not.toBeNull();

    const again = await put(key, VALID_PDF as BodyInit);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual(INVALID);
    expect(await list(storeId)).toHaveLength(1);

    const audit = await t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId));
    const done = audit.find((a) => a.action === "products.completeUpload" && a.ok);
    expect(done).toMatchObject({ origin: "mcp", actor: { kind: "token", tokenId: tok.id } });
    expect(done!.input).toMatchObject({ fileSize: VALID_PDF.length, result: { name: "Curso", fileName: "Curso.pdf" } });
    expect(JSON.stringify(audit)).not.toContain(key.slice(-43));
    expect(out).not.toContain(key.slice(-43));
  }, HEAVY_TEST_MS);

  test("chave vencida, de loja inexistente, de token revogado ou forjada com o storeId de outra loja → 404 igual", async () => {
    const a = await seedStore("A");
    const b = await seedStore("B");
    const tokA = await mkToken(a.storeId);
    const tokB = await mkToken(b.storeId);
    const expired = await createLink(a.storeId, tokA.actor, "Vencido");
    await t.ownerDb.update(uploadLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadLink.keyHash, sha256(expired)));
    const revokedTok = await mkToken(a.storeId);
    const ofRevoked = await createLink(a.storeId, revokedTok.actor, "Revogado");
    await t.ownerDb.update(mcpToken).set({ revokedAt: new Date() }).where(eq(mcpToken.id, revokedTok.id));
    const valid = await createLink(b.storeId, tokB.actor, "Valido");
    const secretOf = (k: string) => k.slice(-43);
    const prefixOf = (storeId: string) => `${KEY_PREFIX}${storeId.replaceAll("-", "")}`;
    const cases: Record<string, string> = {
      vencida: expired,
      "loja inexistente": `${prefixOf(randomUUID())}_${secretOf(valid)}`,
      "token revogado": ofRevoked,
      "storeId de outra loja": `${prefixOf(a.storeId)}_${secretOf(valid)}`,
      "segredo inventado": `${prefixOf(b.storeId)}_${randomBytes(32).toString("base64url")}`,
      malformada: "abc",
    };
    const bodies = new Set<string>();
    for (const [label, key] of Object.entries(cases)) {
      expect([label, await resolveUploadKey(key)]).toEqual([label, null]);
      const res = await put(key, VALID_PDF as BodyInit);
      expect([label, res.status]).toEqual([label, 404]);
      bodies.add(await res.text());
    }
    expect([...bodies]).toEqual([JSON.stringify(INVALID)]);
    expect(await list(a.storeId)).toEqual([]);
    expect(await list(b.storeId)).toEqual([]);
    // A chave certa resolve para a loja, o link e o token dela.
    expect(await resolveUploadKey(valid)).toMatchObject({ storeId: b.storeId, tokenId: tokB.id, role: "owner", linkId: expect.any(String), attempts: 0 });
  });

  test("não PDF → 400 e a chave segue valendo; 6ª tentativa → 429; Content-Type errado → 415; acima de 50 MB → 413", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    const key = await createLink(storeId, tok.actor);
    for (let i = 0; i < 5; i++) {
      const res = await put(key, Buffer.from("texto") as BodyInit);
      expect([i, res.status]).toEqual([i, 400]);
      expect(((await res.json()) as { error: string }).error).toMatch(/PDF/);
    }
    // A 6ª é recusada pela rota antes de ler o corpo (sem guardar até 50 MB na memória a cada PUT).
    const sixthBody = endless();
    const sixth = await put(key, sixthBody.body);
    expect(sixth.status).toBe(429);
    expect(sixthBody.state.pulls).toBe(0);
    expect(await list(storeId)).toEqual([]);
    const [row] = await t.ownerDb.select().from(uploadLink).where(eq(uploadLink.keyHash, sha256(key)));
    expect(row).toMatchObject({ attempts: 5, usedAt: null });
    // E a ação também recusa a 6ª por conta própria (a rota só evita ler o corpo).
    const direct = runAction(completeUpload, { storeId, actor: tok.actor, origin: "mcp" }, { linkId: row!.id, file: VALID_PDF });
    expect(await codeOf(direct)).toBe("rate_limited");
    expect(await list(storeId)).toEqual([]);

    // Content-Type e tamanho são recusados antes da ação: não gastam tentativa nem a chave.
    const fresh = await createLink(storeId, tok.actor, "Outro");
    const wrongType = await put(fresh, VALID_PDF as BodyInit, { headers: { "content-type": "text/plain" } });
    expect(wrongType.status).toBe(415);
    const { state, body } = endless();
    const tooBig = await put(fresh, body, { headers: { "content-length": String(LIMIT + 1) } });
    expect(tooBig.status).toBe(413);
    expect(state.pulls).toBe(0);
    const streamed = endless();
    expect((await put(fresh, streamed.body)).status).toBe(413);
    expect(streamed.state.pulls).toBeLessThanOrEqual(LIMIT / MB + 2);
    expect((await put(fresh, VALID_PDF as BodyInit)).status).toBe(201);
    expect((await list(storeId)).map((p) => p.name)).toEqual(["Outro"]);
  }, HEAVY_TEST_MS);

  test("token revogado depois de resolver a chave: a ação recusa antes de contar a tentativa e de inspecionar o PDF", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    const key = await createLink(storeId, tok.actor);
    const link = await resolveUploadKey(key);
    await t.ownerDb.update(mcpToken).set({ revokedAt: new Date() }).where(eq(mcpToken.id, tok.id));
    const r = runAction(completeUpload, { storeId, actor: tok.actor, origin: "mcp" }, { linkId: link!.linkId, file: Buffer.from("texto") });
    expect(await codeOf(r)).toBe("conflict");
    const [row] = await t.ownerDb.select().from(uploadLink).where(eq(uploadLink.keyHash, sha256(key)));
    expect(row).toMatchObject({ attempts: 0, usedAt: null });
  });

  test("dois PUTs simultâneos válidos → um produto só", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    const key = await createLink(storeId, tok.actor);
    const statuses = (await Promise.all([put(key, VALID_PDF as BodyInit), put(key, VALID_PDF as BodyInit)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([201, 409]);
    expect(await list(storeId)).toHaveLength(1);
  }, HEAVY_TEST_MS);

  test("outros métodos → 405; 31ª requisição do mesmo IP no minuto → 429 antes de consultar a chave", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    const key = await createLink(storeId, tok.actor);
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const res = await put(key, method === "GET" ? null : (VALID_PDF as BodyInit), { method });
      expect([method, res.status, res.headers.get("allow")]).toEqual([method, 405, "PUT"]);
    }
    const ip = `198.51.100.${1 + (randomBytes(1)[0]! % 250)}`;
    const forged = () => `${KEY_PREFIX}${randomUUID().replaceAll("-", "")}_${randomBytes(32).toString("base64url")}`;
    for (let i = 0; i < 30; i++) {
      const res = await put(forged(), VALID_PDF as BodyInit, { trustProxy: 1, headers: { "x-forwarded-for": ip } });
      expect([i, res.status]).toEqual([i, 404]);
    }
    const blocked = await put(key, VALID_PDF as BodyInit, { trustProxy: 1, headers: { "x-forwarded-for": ip } });
    expect(blocked.status).toBe(429);
    // Outro IP segue passando, e a chave não foi gasta.
    expect((await put(key, VALID_PDF as BodyInit, { trustProxy: 1, headers: { "x-forwarded-for": "192.0.2.10" } })).status).toBe(201);
  }, HEAVY_TEST_MS);

  test("sem IP conhecido: balde global, 61ª requisição no minuto → 429 antes de consultar a chave", async () => {
    const { storeId } = await seedStore();
    const tok = await mkToken(storeId);
    const key = await createLink(storeId, tok.actor);
    // Outra janela (10 min depois): os PUTs sem IP dos outros testes não contam aqui.
    const later = new Date(NOW.getTime() + 600_000);
    const forged = () => `${KEY_PREFIX}${randomUUID().replaceAll("-", "")}_${randomBytes(32).toString("base64url")}`;
    for (let i = 0; i < 60; i++) {
      const res = await put(forged(), VALID_PDF as BodyInit, { now: later });
      expect([i, res.status]).toEqual([i, 404]);
    }
    const { state, body } = endless();
    const blocked = await put(key, body, { now: later });
    expect(blocked.status).toBe(429);
    expect(state.pulls).toBe(0);
    // Com IP conhecido o balde global não vale, e a chave segue valendo.
    expect((await put(key, VALID_PDF as BodyInit, { now: later, trustProxy: 1, headers: { "x-forwarded-for": "192.0.2.20" } })).status).toBe(201);
  }, HEAVY_TEST_MS);
});
