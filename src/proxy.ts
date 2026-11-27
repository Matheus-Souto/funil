// Proxy do Next (antigo middleware): CSP com nonce SÓ nas páginas do comprador (/c checkout e /o pedido), onde roda o
// Meta Pixel e se digita cartão/CPF (PCI DSS 4.0 6.4.3 / 11.6.1). O Next lê o nonce do header da REQUISIÇÃO e o aplica
// aos próprios scripts (as páginas são dinâmicas). Painel, API, /d e /t.js ficam fora do matcher.
// Inventário e justificativa de cada script: docs/seguranca-pagamento.md.
import { NextResponse, type NextRequest } from "next/server";
import { cardServiceConfigured, env } from "@/lib/env";

/**
 * Política das páginas do comprador. `turnstile`: o desafio da Cloudflare pode ser carregado no checkout.
 * `cardOrigin` (com o serviço de cartão configurado): o formulário do cartão vem em iframe desse domínio.
 */
export function buyerCsp(nonce: string, opts: { dev: boolean; turnstile: boolean; cardOrigin?: string }): string {
  const scripts = ["'self'", `'nonce-${nonce}'`, "https://connect.facebook.net"];
  if (opts.turnstile) scripts.push("https://challenges.cloudflare.com");
  // Só em `next dev`: o React usa eval para as pilhas de erro (não em produção).
  if (opts.dev) scripts.push("'unsafe-eval'");
  const frames: string[] = [];
  if (opts.turnstile) frames.push("https://challenges.cloudflare.com");
  if (opts.cardOrigin) frames.push(opts.cardOrigin);
  return [
    `script-src ${scripts.join(" ")}`,
    "connect-src 'self' https://www.facebook.com https://connect.facebook.net",
    "img-src 'self' data: https://www.facebook.com",
    ...(frames.length > 0 ? [`frame-src ${frames.join(" ")}`] : []),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Páginas com segredo na URL não mandam o endereço adiante (Referer) para nenhum recurso ou link: o checkout aberto
 * pela sessão do app (`/c/<slug>?s=<id>`: o `s` dá acesso ao nome e ao e-mail da sessão) e a página do pedido
 * (`/o/<publicId>`, que no pedido de app leva o link de volta ao checkout da sessão). `null`: política padrão.
 */
export function buyerReferrerPolicy(pathname: string, search: URLSearchParams): "no-referrer" | null {
  if (pathname.startsWith("/o/")) return "no-referrer";
  if (pathname.startsWith("/c/") && search.has("s")) return "no-referrer";
  return null;
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buyerCsp(nonce, {
    dev: process.env.NODE_ENV === "development",
    turnstile: Boolean(env.TURNSTILE_SITE_KEY),
    cardOrigin: cardServiceConfigured(env) ? env.CARD_ORIGIN : undefined,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  const referrer = buyerReferrerPolicy(request.nextUrl.pathname, request.nextUrl.searchParams);
  if (referrer) response.headers.set("referrer-policy", referrer);
  return response;
}

export const config = {
  matcher: ["/c/:path*", "/o/:path*"],
};
