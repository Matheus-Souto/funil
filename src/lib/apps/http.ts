// Borda HTTP da API de integração de apps (`/api/integracao/v1/*`): o servidor do app chama com a chave da loja
// (`Authorization: Bearer <chave>`, token com papel `integration`; ver src/lib/mcp/tokens.ts).
// Ordem: só POST → corpo até 32 KB → balde de falhas de autenticação (o mesmo do MCP) → chave `integration` (401 com o
// MESMO corpo em todo caso de falha, inclusive token MCP de outro papel) → 60 requisições por minuto por chave → JSON
// → `run` (a rota chama só `runAction`). `ActionError` vira status HTTP com `{ erro: { codigo, mensagem, detalhes? } }`;
// erro inesperado vira 500 sem a mensagem (só o nome e os códigos vão ao log). Nenhum dado do corpo vai ao log.
import { ActionError, type Actor, type ActionErrorCode } from "@/lib/actions/core";
import { clientIpFrom, UNKNOWN_IP } from "@/lib/client-ip";
import { env } from "@/lib/env";
import { readCapped } from "@/lib/http";
import { errorFields, log } from "@/lib/log";
import { unauthBucket } from "@/lib/mcp/limits";
import { authenticateMcpToken } from "@/lib/mcp/tokens";
import { checkRateLimit, ipRateKey, peekRateLimit } from "@/lib/payments/ratelimit";

const MAX_BODY = 32 * 1024;
/** Requisições por minuto por chave (§9 do design). */
const KEY_LIMIT = 60;
const WINDOW_SEC = 60;

/** O que a ação devolve: status HTTP do sucesso (ex.: 201 criado, 200 já existia) e o corpo JSON. */
export interface IntegrationResult {
  status: number;
  body: unknown;
}

export type IntegrationCall = { storeId: string; actor: Actor; origin: "api" };

export interface IntegrationHttpOptions {
  /** Relógio dos limites (testes). */
  now?: () => Date;
  /** Proxies confiáveis para o IP do cliente (padrão: `TRUST_PROXY`), como no MCP. */
  trustProxy?: number;
}

const STATUS: Partial<Record<ActionErrorCode, number>> = {
  invalid_input: 422,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  rate_limited: 429,
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const fail = (status: number, codigo: string, mensagem: string, extra: { detalhes?: unknown; headers?: Record<string, string> } = {}) =>
  json(status, { erro: { codigo, mensagem, ...(extra.detalhes === undefined ? {} : { detalhes: extra.detalhes }) } }, extra.headers);

// Sem dizer qual caso (sem chave, malformada, revogada, de outro papel ou de outra loja): corpo único.
const unauthorized = () => fail(401, "unauthorized", "Chave de integração ausente ou inválida");
const tooMany = () => fail(429, "rate_limited", "Muitas requisições; tente de novo em um minuto", { headers: { "retry-after": String(WINDOW_SEC) } });

function bearer(req: Request): string | null {
  const m = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

/** Em `invalid_input`, só campo e mensagem do zod (o `runAction` já não copia valores crus). */
function detailsOf(e: ActionError): unknown {
  if (e.code === "invalid_input" && Array.isArray(e.details)) {
    return (e.details as { path?: unknown; message?: unknown }[]).map((i) => ({
      campo: Array.isArray(i.path) ? i.path.map(String).join(".") : "",
      mensagem: typeof i.message === "string" ? i.message : "",
    }));
  }
  // `conflict` pode trazer um código estável para o app decidir (ex.: `{ code: "SESSION_INVALID" }`).
  if (e.code === "conflict" && e.details !== null && typeof e.details === "object" && !Array.isArray(e.details)) return e.details;
  return undefined;
}

/** Atende uma chamada da API de integração. `run` recebe a loja e o ator da chave e chama a ação pelo `runAction`. */
export async function handleIntegrationRequest(
  req: Request,
  run: (call: IntegrationCall, body: unknown) => Promise<IntegrationResult>,
  opts: IntegrationHttpOptions = {},
): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Método não permitido", { headers: { allow: "POST" } });
  const now = opts.now ?? (() => new Date());
  // Tudo dentro do `try`: falha de infraestrutura na leitura do corpo, nos limites ou na autenticação (ex.: banco fora)
  // também sai no envelope `{ erro }`, sem pilha nem mensagem crua.
  let tokenId: string | undefined;
  try {
    const raw = await readCapped(req, MAX_BODY);
    if (raw === null) return fail(413, "payload_too_large", "Requisição grande demais (máximo de 32 KB)");

    const ip = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
    const [unauthKey, unauthLimit] = unauthBucket(ip === UNKNOWN_IP ? null : ipRateKey(ip));
    if (!(await peekRateLimit(unauthKey, unauthLimit, WINDOW_SEC, now()))) return tooMany();
    const found = await authenticateMcpToken(bearer(req));
    // Token MCP de qualquer outro papel não serve aqui (e a chave `integration` não serve no MCP).
    const auth = found?.role === "integration" ? found : null;
    if (!auth) return (await checkRateLimit(unauthKey, unauthLimit, WINDOW_SEC, now())) ? unauthorized() : tooMany();
    tokenId = auth.tokenId;

    if (!(await checkRateLimit(`apps:${auth.tokenId}`, KEY_LIMIT, WINDOW_SEC, now()))) return tooMany();

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "invalid_json", "Corpo não é um JSON válido");
    }

    const out = await run({ storeId: auth.storeId, actor: { kind: "token", tokenId: auth.tokenId, role: "integration" }, origin: "api" }, body);
    return json(out.status, out.body);
  } catch (e) {
    if (e instanceof ActionError) {
      return fail(STATUS[e.code] ?? 500, e.code, e.message, {
        detalhes: detailsOf(e),
        ...(e.code === "rate_limited" ? { headers: { "retry-after": String(WINDOW_SEC) } } : {}),
      });
    }
    log.error("API de integração falhou", { ...(tokenId ? { tokenId } : {}), path: new URL(req.url).pathname, ...errorFields(e) });
    return fail(500, "internal", "Falha interna");
  }
}
