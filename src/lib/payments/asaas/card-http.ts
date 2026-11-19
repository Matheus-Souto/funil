// Borda HTTP do cartão (POST /api/checkout/card): HTTPS, loja pelo host, corpo com teto, IP do cliente.
// Só faz parse de HTTP e chama `payWithCard` (que não é uma ação registrada para não gravar o cartão na auditoria).
//
// IP do cliente (`TRUST_PROXY`, obrigatória em produção fora de loopback):
// - 1 (ou N proxies confiáveis): o N-ésimo endereço da DIREITA em X-Forwarded-For, isto é, o que o nosso proxy (Caddy)
//   acrescentou a partir do socket. Entradas à esquerda vêm do cliente e podem ser forjadas: nunca são usadas.
//   Com MENOS entradas que N (a requisição não passou por todos os proxies, ex.: acesso direto à origem atrás da
//   Cloudflare), vale a mais à esquerda: o Caddy descarta o cabeçalho de quem não é proxy confiável e escreve o socket.
// - 0 (sem proxy): X-Forwarded-For NÃO é lido. O Next só o preenche com o endereço do socket quando o cliente não
//   mandou o cabeçalho (`??=` em base-server.js), então ele é forjável e o app router não expõe o socket. O IP vira a
//   chave fixa "unknown": o limite por IP é pulado e valem os limites por e-mail e por cartão.
import { isIP } from "node:net";
import { ActionError, type ActionErrorCode } from "@/lib/actions/core";
import { env } from "@/lib/env";
import { readCapped } from "@/lib/http";
import { log } from "@/lib/log";
import { resolveStore as defaultResolveStore, type ResolvedStore } from "@/lib/stores";
import { payWithCard as defaultPayWithCard, UNKNOWN_IP, type CardPaymentInput, type CardResult } from "./card";

const MAX_BODY = 16 * 1024;
const INTERNAL_MESSAGE = "Não foi possível processar o pagamento. Verifique em instantes antes de tentar de novo.";

const STATUS: Record<ActionErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  approval_required: 403,
  provider_error: 502,
  rate_limited: 429,
};

export interface CardHttpOptions {
  resolveStore?: (host: string) => Promise<ResolvedStore | null>;
  payWithCard?: (call: { storeId: string }, input: CardPaymentInput) => Promise<CardResult>;
  nodeEnv?: string;
  trustProxy?: number;
}

function normalizeIp(v: string | undefined): string | null {
  if (!v) return null;
  let ip = v.trim().replace(/^\[|\]$/g, "");
  if (ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

/** IP do comprador (ver o comentário do topo); `UNKNOWN_IP` sem proxy confiável ou sem endereço válido. */
export function clientIpFrom(headers: Headers, trustProxy: number): string {
  if (trustProxy <= 0) return UNKNOWN_IP;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops.length === 0) return UNKNOWN_IP;
  // Menos entradas que proxies confiáveis: a requisição não passou por todos (ex.: acesso direto à origem, sem a
  // Cloudflare). A mais à esquerda é a que o nosso proxy (Caddy) escreveu a partir do socket; "desconhecido" aqui
  // desligaria todos os limites por IP para quem acha o IP da origem.
  return normalizeIp(hops[Math.max(0, hops.length - trustProxy)]) ?? UNKNOWN_IP;
}

function isHttps(headers: Headers, trustProxy: number): boolean {
  // `next start` só fala HTTP: sem proxy confiável, nenhuma requisição é HTTPS (X-Forwarded-Proto pode ser forjado).
  if (trustProxy <= 0) return false;
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",").map((s) => s.trim().toLowerCase());
  return proto[proto.length - 1] === "https";
}

function isLoopbackHost(host: string): boolean {
  try {
    const h = new URL(`http://${host}`).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  } catch {
    return false;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Só aceita POST do próprio checkout: `Content-Type: application/json` (não é "simple request": um formulário de outro
 * site não consegue enviá-lo sem preflight) e `Origin` igual à origem da loja (o host da requisição, que identifica a
 * loja), ou `Sec-Fetch-Site: same-origin` quando o navegador não manda Origin.
 */
function sameOriginJson(headers: Headers, trustProxy: number): boolean {
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return false;
  const origin = headers.get("origin");
  if (origin === null) return headers.get("sec-fetch-site") === "same-origin";
  const host = headers.get("host");
  if (!host) return false;
  try {
    const expected = new URL(`${isHttps(headers, trustProxy) ? "https" : "http"}://${host}`).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

export async function handleCardCheckout(req: Request, opts: CardHttpOptions = {}): Promise<Response> {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const trustProxy = opts.trustProxy ?? env.TRUST_PROXY;
  // Antes de qualquer trabalho (loja, corpo, repetição idempotente): POST de outro site nunca chega ao pagamento.
  if (!sameOriginJson(req.headers, trustProxy)) {
    return json(403, { error: "forbidden_origin", message: "Requisição recusada." });
  }
  const host = req.headers.get("host") ?? "";
  if (nodeEnv === "production" && !isHttps(req.headers, trustProxy) && !isLoopbackHost(host)) {
    return json(403, { error: "https_required", message: "Use uma conexão segura (HTTPS) para pagar com cartão." });
  }
  const store = await (opts.resolveStore ?? defaultResolveStore)(host);
  if (!store) return json(404, { error: "not_found", message: "Loja não encontrada" });

  const text = await readCapped(req, MAX_BODY);
  if (text === null) return json(413, { error: "too_large", message: "Requisição grande demais" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_input", message: "JSON inválido" });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "invalid_input", message: "JSON inválido" });
  }

  try {
    // O IP vem do servidor e sobrescreve qualquer `clientIp` enviado no corpo.
    const input = { ...(body as Record<string, unknown>), clientIp: clientIpFrom(req.headers, trustProxy) } as unknown as CardPaymentInput;
    const result = await (opts.payWithCard ?? defaultPayWithCard)({ storeId: store.id }, input);
    return json(200, result);
  } catch (e) {
    if (e instanceof ActionError) {
      // Mensagens de ActionError deste fluxo são nossas (as do Asaas no cartão são opacas); detalhes só se seguros.
      const extra =
        e.code === "invalid_input" && Array.isArray(e.details)
          ? { fields: (e.details as { path?: unknown }[]).map((d) => d.path) }
          : e.code === "rate_limited" && (e.details as { captcha?: boolean } | undefined)?.captcha
            ? { captcha: true }
            : {};
      return json(STATUS[e.code] ?? 400, { error: e.code, message: e.message, ...extra });
    }
    // `log` aplica redact (remove PAN e chaves de cartão); nunca registramos o corpo da requisição.
    log.error("checkout cartão: erro inesperado", { error: e });
    return json(500, { error: "internal", message: INTERNAL_MESSAGE });
  }
}
