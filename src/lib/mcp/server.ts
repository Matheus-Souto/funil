// Endpoint MCP (/api/mcp): um agente de IA usa a loja com um token MCP (`Authorization: Bearer <token>`).
// Ordem: limite por IP (antes de autenticar, contra varredura de tokens) → corpo até 256 KB → balde global de falhas
// de autenticação → token (401 com o MESMO corpo em todo caso de falha) → limite por token → sem lote → um `Server` e
// um transporte por requisição (sem sessão, resposta JSON). As ferramentas vêm do catálogo (src/lib/mcp/tools.ts) pelo papel do token; `runAction` decide permissão e
// auditoria. Nenhum dado pessoal do comprador sai por aqui (projeções do catálogo) e erro inesperado nunca leva pilha.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ActionError } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { registry } from "@/lib/actions/registry";
import { clientIpFrom, UNKNOWN_IP } from "@/lib/client-ip";
import { env } from "@/lib/env";
import { readCapped } from "@/lib/http";
import { errorFields, log } from "@/lib/log";
import { checkRateLimit, ipRateKey, peekRateLimit } from "@/lib/payments/ratelimit";
import { authenticateMcpToken } from "./tokens";
import { callMcpTool, mcpTools } from "./tools";

const MAX_BODY = 256 * 1024;
const TOKEN_LIMIT = 120;
const IP_LIMIT = 300;
/** Falhas de autenticação somadas de todos os clientes (vale também sem IP conhecido, com `TRUST_PROXY=0`). */
const UNAUTH_KEY = "mcp:unauth";
const UNAUTH_LIMIT = 600;
const WINDOW_SEC = 60;
const MAX_ERROR_TEXT = 500;

const INSTRUCTIONS =
  "Servidor MCP da loja no funil (checkout de infoprodutos). As ferramentas seguem o papel do token. " +
  "Dados do comprador vêm mascarados (nome, e-mail, telefone e CPF) ou não vêm; IP, user agent e busca por e-mail ou nome " +
  "não estão disponíveis. Ações sensíveis (como reembolso, liberar pedido, preço e produtos da oferta, conexões de pagamento " +
  "e de e-mail, equipe e tokens) não estão disponíveis por aqui: peça a quem administra a loja que as faça no painel. " +
  "Valores em dinheiro estão em centavos.";

export interface McpHttpOptions {
  /** Proxies confiáveis para o IP do cliente (padrão: `TRUST_PROXY`). */
  trustProxy?: number;
  /** Relógio dos limites (testes). */
  now?: () => Date;
  /** Executor das ferramentas (testes simulam falha inesperada); padrão: `callMcpTool`. */
  callTool?: typeof callMcpTool;
}

type Auth = { storeId: string; tokenId: string; role: Role };

const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers: { "cache-control": "no-store", ...headers } });

// Sem dizer qual caso (sem token, malformado, revogado, loja ou segredo errado): corpo único.
const unauthorized = () => rpcError(401, -32001, "Não autorizado");
const tooMany = () => rpcError(429, -32000, "Muitas requisições; tente de novo em um minuto", { "retry-after": String(WINDOW_SEC) });

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** `<código>: <mensagem>`; em `invalid_input`, os campos e mensagens do zod (só `path` e `message`, sem valores crus). */
function actionErrorText(e: ActionError): string {
  let t = `${e.code}: ${e.message}`;
  if (e.code === "invalid_input" && Array.isArray(e.details) && e.details.length > 0) {
    const issues = (e.details as { path?: unknown; message?: unknown }[]).map((i) => {
      const path = Array.isArray(i.path) ? i.path.map(String).join(".") : "";
      return path ? `${path}: ${String(i.message)}` : String(i.message);
    });
    t += ` (${issues.join("; ")})`;
  }
  return t.length > MAX_ERROR_TEXT ? `${t.slice(0, MAX_ERROR_TEXT - 1)}…` : t;
}

function bearer(req: Request): string | null {
  const m = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]! : null;
}

function buildServer(auth: Auth, callTool: typeof callMcpTool): Server {
  const server = new Server({ name: "funil", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: mcpTools(auth.role).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: "object" } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    // Sempre pelo catálogo do papel: nome desconhecido ou fora do papel não chega ao runAction.
    const tool = mcpTools(auth.role).find((t) => t.name === name);
    if (!tool) return text("forbidden: ferramenta indisponível", true);
    // Escritas já ficam na auditoria (runAction); leituras sem auditoria ficam registradas aqui, sem os argumentos.
    if (registry.get(tool.action)?.audit === false) log.info("mcp: ferramenta chamada", { tokenId: auth.tokenId, tool: tool.name });
    try {
      const out = await callTool(tool, auth, request.params.arguments ?? {});
      return text(JSON.stringify(out ?? null));
    } catch (e) {
      // A mensagem das ações é segura; qualquer outro erro só vai ao log pelo nome e códigos (sem texto livre).
      if (e instanceof ActionError) return text(actionErrorText(e), true);
      log.error("ferramenta MCP falhou", { tool: tool.name, tokenId: auth.tokenId, ...errorFields(e) });
      return text("error: falha interna", true);
    }
  });

  return server;
}

/** POST /api/mcp (Streamable HTTP sem sessão). GET e DELETE não existem sem sessão: 405. */
export async function handleMcpRequest(req: Request, opts: McpHttpOptions = {}): Promise<Response> {
  // Sem sessão não há stream de GET (ficaria aberto à toa) nem sessão para DELETE.
  if (req.method !== "POST") return rpcError(405, -32000, "Método não permitido", { allow: "POST" });
  const now = opts.now ?? (() => new Date());

  const ip = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
  if (ip !== UNKNOWN_IP && !(await checkRateLimit(`mcp:ip:${ipRateKey(ip)}`, IP_LIMIT, WINDOW_SEC, now()))) return tooMany();

  const raw = await readCapped(req, MAX_BODY);
  if (raw === null) return rpcError(413, -32000, "Requisição grande demais (máximo de 256 KB)");

  // Muitas falhas de autenticação no minuto (de qualquer cliente): nenhuma transação de autenticação nova até a virada.
  if (!(await peekRateLimit(UNAUTH_KEY, UNAUTH_LIMIT, WINDOW_SEC, now()))) return tooMany();
  const auth = await authenticateMcpToken(bearer(req));
  if (!auth) return (await checkRateLimit(UNAUTH_KEY, UNAUTH_LIMIT, WINDOW_SEC, now())) ? unauthorized() : tooMany();
  if (!(await checkRateLimit(`mcp:${auth.tokenId}`, TOKEN_LIMIT, WINDOW_SEC, now()))) return tooMany();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(400, -32700, "Parse error: Invalid JSON");
  }
  // Lote (até 100 mensagens no SDK, despachadas em paralelo) furaria o limite por token e o pool do banco.
  if (Array.isArray(body)) return rpcError(400, -32600, "Lote não suportado");

  const server = buildServer(auth, opts.callTool ?? callMcpTool);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    // O corpo já foi lido (com teto): o transporte não lê de novo.
    return await transport.handleRequest(req, { parsedBody: body });
  } finally {
    await server.close();
  }
}
