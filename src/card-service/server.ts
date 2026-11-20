// Servidor HTTP do serviço de cartão isolado (node:http, sem framework). Rotas, e nada mais:
//   GET  /form/<storeId>  página do iframe (CSP estrita, frame-ancestors = origens do checkout da loja)
//   GET  /form.js, /form.css  artefatos do formulário (dois nomes fixos dentro de `assetsDir`; nunca caminho da URL)
//   POST /api/card        cobrança: Content-Type, Origin e HTTPS antes de tudo; corpo com teto; bilhete do pedido,
//                         da mesma loja da página do iframe (`storeId` no corpo)
//   GET  /healthz         200 "ok" quando o banco responde
// Qualquer outra rota ou método: 404 sem corpo.
//
// DADOS DO CARTÃO: só existem no corpo do POST, repassado a `payWithCard`. Nunca vão para log nem para a resposta
// (erros passam por `cardErrorResponse`, que só devolve códigos e mensagens nossas).
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { clientIpFrom, isHttps } from "@/lib/client-ip";
import { dbHealthy } from "@/lib/db/client";
import { isLoopbackUrl } from "@/lib/env";
import { errorFields, log } from "@/lib/log";
import { payWithCard as defaultPayWithCard, type CardPaymentInput } from "@/lib/payments/asaas/card";
import { cardErrorResponse } from "@/lib/payments/asaas/card-http";
import { verifyCardTicketDetailed } from "@/lib/payments/card-ticket";
import { storeCheckoutOrigins } from "@/lib/stores";
import { cardFormCsp, cardFormHtml } from "./page";

export interface CardServerOptions {
  /** Origem do próprio serviço (CARD_ORIGIN): o único `Origin` aceito no POST. */
  cardOrigin: string;
  /** CARD_TICKET_KEY: confere o bilhete do pedido emitido pelo app. */
  ticketKey: string;
  /** TRUST_PROXY: quantos proxies confiáveis (IP do comprador e X-Forwarded-Proto). */
  trustProxy: number;
  /** Diretório com `form.js` e `form.css` (build da Task 7). Sem ele, as duas rotas dão 404. */
  assetsDir?: string;
  payWithCard?: typeof defaultPayWithCard;
  origins?: (storeId: string) => Promise<string[]>;
}

const MAX_BODY = 16 * 1024;
/**
 * Timeouts e teto de conexões. O Node só confere os timeouts a cada `connectionsCheckingInterval` (padrão 30 s): com
 * 1 s, um corpo lento recebe 408 perto do prazo. `requestTimeout` conta só até o fim do corpo (medido: não corta a
 * resposta, então a cobrança de até 60 s segue depois dele); 15 s bastam para um corpo de 16 KB e soltam logo a
 * conexão de quem manda o corpo devagar (256 corpos lentos derrubavam o cartão de todas as lojas). O Caddy, na frente,
 * também lê o corpo inteiro antes de repassar (`request_buffers` no Caddyfile.card). `keepAliveTimeout` igual ao
 * padrão do Node.
 */
export const SERVER_LIMITS = {
  headersTimeout: 10_000,
  requestTimeout: 15_000,
  keepAliveTimeout: 5_000,
  maxConnections: 256,
  connectionsCheckingInterval: 1_000,
} as const;
/** Recusas antes de ler o corpo: a conexão fecha (o corpo não lido não fica preso nela). */
const CLOSE = { connection: "close" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORM_PATH = /^\/form\/([^/]+)$/;
/** Os únicos arquivos servidos: caminho da URL -> nome fixo no `assetsDir` e tipo. */
const ASSETS = new Map<string, { file: string; type: string }>([
  ["/form.js", { file: "form.js", type: "text/javascript; charset=utf-8" }],
  ["/form.css", { file: "form.css", type: "text/css; charset=utf-8" }],
]);

/**
 * Origens do checkout por loja (frame-ancestors) com cache em memória: `ttlMs` (60 s) por loja, inclusive a resposta
 * vazia (loja inexistente: um `GET /form/<uuid-aleatório>` em série não vira uma consulta ao banco por requisição), no
 * máximo `max` lojas (a mais antiga sai). Erro não fica guardado. Trocar o domínio da loja leva até `ttlMs` para valer.
 */
export function cacheOrigins(
  fetchOrigins: (storeId: string) => Promise<string[]>,
  opts: { ttlMs?: number; max?: number; now?: () => number } = {},
): (storeId: string) => Promise<string[]> {
  const ttl = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 1000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; origins: string[] }>();
  return async (storeId) => {
    const hit = cache.get(storeId);
    if (hit && now() - hit.at < ttl) return hit.origins;
    const origins = await fetchOrigins(storeId);
    cache.delete(storeId); // reinsere no fim (a ordem do Map é a idade)
    cache.set(storeId, { at: now(), origins });
    while (cache.size > max) cache.delete(cache.keys().next().value!);
    return origins;
  };
}

function send(res: ServerResponse, status: number, body = "", headers: Record<string, string> = {}): void {
  res.writeHead(status, { "x-content-type-options": "nosniff", ...headers, "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(body), { "content-type": "application/json", "cache-control": "no-store", ...headers });

/** Cabeçalhos da requisição como `Headers` (o que `clientIpFrom` e `isHttps` leem). */
function headersOf(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  return h;
}

/** Corpo com teto de bytes; `null` se passar do limite (declarado ou real). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  if (Number(req.headers["content-length"] ?? 0) > max) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (c: Buffer) => {
      total += c.length;
      if (total > max) {
        cleanup();
        resolve(null);
      } else chunks.push(c);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("requisição interrompida antes do fim do corpo"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/**
 * Endereço em que o serviço escuta: 127.0.0.1 quando CARD_ORIGIN é http em loopback (verify e desenvolvimento: nada
 * exposto no IP da máquina); 0.0.0.0 nos outros casos (no container, atrás do Caddy, que o alcança pela rede `card`).
 */
export function cardBindHost(cardOrigin: string | undefined): string {
  if (cardOrigin === undefined) return "0.0.0.0";
  try {
    return new URL(cardOrigin).protocol === "http:" && isLoopbackUrl(cardOrigin) ? "127.0.0.1" : "0.0.0.0";
  } catch {
    return "0.0.0.0";
  }
}

/**
 * Serviço sem CARD_ORIGIN (instalação que ainda não configurou o cartão; o container `card` sobe sempre): só
 * `GET /healthz` (200 "desligado", para o healthcheck e o `docker compose up --wait`), sem banco; o resto, 404.
 */
export function createIdleCardServer(): Server {
  const server = createServer({ connectionsCheckingInterval: SERVER_LIMITS.connectionsCheckingInterval }, (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method === "GET" && path === "/healthz") return send(res, 200, "desligado", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    send(res, 404);
  });
  server.headersTimeout = SERVER_LIMITS.headersTimeout;
  server.requestTimeout = SERVER_LIMITS.requestTimeout;
  server.keepAliveTimeout = SERVER_LIMITS.keepAliveTimeout;
  server.maxConnections = SERVER_LIMITS.maxConnections;
  return server;
}

export function createCardServer(opts: CardServerOptions): Server {
  const pay = opts.payWithCard ?? defaultPayWithCard;
  const originsOf = cacheOrigins(opts.origins ?? ((storeId: string) => storeCheckoutOrigins(storeId)));
  const cardUrl = new URL(opts.cardOrigin);
  if (cardUrl.origin !== opts.cardOrigin) throw new Error("cardOrigin deve ser só a origem (esquema, host e porta)");
  // HTTP só em loopback (desenvolvimento e testes); fora dele, a conexão do comprador precisa ser HTTPS no proxy.
  const plainLoopback = cardUrl.protocol === "http:" && isLoopbackUrl(opts.cardOrigin);
  if (cardUrl.protocol !== "https:" && !plainLoopback) throw new Error("cardOrigin deve ser https (http só em loopback)");

  async function apiCard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = headersOf(req);
    // Antes de qualquer trabalho: POST de outro site (ou do app) nunca chega ao bilhete nem ao pagamento.
    const type = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json" || headers.get("origin") !== opts.cardOrigin) {
      return json(res, 403, { error: "forbidden_origin", message: "Requisição recusada." }, CLOSE);
    }
    if (!plainLoopback && !isHttps(headers, opts.trustProxy)) {
      return json(res, 403, { error: "https_required", message: "Use uma conexão segura (HTTPS) para pagar com cartão." }, CLOSE);
    }
    const raw = await readBody(req, MAX_BODY);
    if (raw === null) return json(res, 413, { error: "too_large", message: "Requisição grande demais" }, CLOSE);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { error: "invalid_input", message: "JSON inválido" });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return json(res, 400, { error: "invalid_input", message: "JSON inválido" });
    }
    const { ticket, storeId, ...fields } = body as Record<string, unknown>;
    const check = verifyCardTicketDetailed(typeof ticket === "string" ? ticket : "", opts.ticketKey);
    if (!check.ok) return json(res, 403, { error: "ticket", ticketExpired: check.expired });
    if (fields.orderPublicId !== check.publicId) return json(res, 403, { error: "ticket", ticketExpired: false });
    // A página do iframe é de uma loja (frame-ancestors = origens dela); o bilhete precisa ser de um pedido dessa loja.
    if (storeId !== check.storeId) return json(res, 403, { error: "forbidden_store", message: "Requisição recusada." });
    try {
      // O IP vem do servidor e sobrescreve qualquer `clientIp` enviado no corpo; a loja vem do bilhete.
      const input = { ...fields, clientIp: clientIpFrom(headers, opts.trustProxy) } as unknown as CardPaymentInput;
      return json(res, 200, await pay({ storeId: check.storeId }, input));
    } catch (e) {
      const { status, body: out } = cardErrorResponse(e);
      return json(res, status, out);
    }
  }

  async function form(rawId: string, res: ServerResponse): Promise<void> {
    if (!UUID.test(rawId)) return send(res, 404);
    // Forma canônica (minúsculas, como no bilhete): o iframe a devolve no POST e o servidor compara por igualdade.
    const storeId = rawId.toLowerCase();
    const origins = await originsOf(storeId);
    if (origins.length === 0) return send(res, 404);
    send(res, 200, cardFormHtml({ storeId, allowedOrigins: origins }), {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": cardFormCsp(origins),
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
  }

  async function asset(a: { file: string; type: string }, res: ServerResponse): Promise<void> {
    if (!opts.assetsDir) return send(res, 404);
    let content: string;
    try {
      content = await readFile(join(opts.assetsDir, a.file), "utf8");
    } catch {
      return send(res, 404);
    }
    send(res, 200, content, { "content-type": a.type, "cache-control": "public, max-age=300" });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Caminho cru, sem normalizar: só casa com os nomes exatos (`/form.js/../x`, `%2e%2e` e afins dão 404).
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method === "POST" && path === "/api/card") return apiCard(req, res);
    if (req.method !== "GET") return send(res, 404);
    if (path === "/healthz") return (await dbHealthy()) ? send(res, 200, "ok", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }) : send(res, 503);
    const a = ASSETS.get(path);
    if (a) return asset(a, res);
    const m = FORM_PATH.exec(path);
    if (m) return form(m[1]!, res);
    return send(res, 404);
  }

  const server = createServer({ connectionsCheckingInterval: SERVER_LIMITS.connectionsCheckingInterval }, (req, res) => {
    handle(req, res).catch((e: unknown) => {
      // Nunca o corpo da requisição nem o texto livre do erro (ver `errorFields`).
      log.error("serviço de cartão: erro inesperado", errorFields(e));
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    });
  });
  server.headersTimeout = SERVER_LIMITS.headersTimeout;
  server.requestTimeout = SERVER_LIMITS.requestTimeout;
  server.keepAliveTimeout = SERVER_LIMITS.keepAliveTimeout;
  server.maxConnections = SERVER_LIMITS.maxConnections;
  return server;
}
