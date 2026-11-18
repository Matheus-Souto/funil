import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { buyerCsp, config, proxy } from "@/proxy";

// CSP com nonce só nas páginas do comprador (/c e /o): o Pixel do Meta roda onde se digita cartão/CPF.
test("buyerCsp: nonce, Meta só nos destinos necessários, sem frames de fora", () => {
  const csp = buyerCsp("abc123", { dev: false, turnstile: false });
  expect(csp).toContain("script-src 'self' 'nonce-abc123' https://connect.facebook.net");
  expect(csp).toContain("connect-src 'self' https://www.facebook.com https://connect.facebook.net");
  expect(csp).toContain("img-src 'self' data: https://www.facebook.com");
  for (const d of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"]) expect(csp).toContain(d);
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toContain("unsafe-inline");
  expect(buyerCsp("n", { dev: false, turnstile: true })).toContain("https://challenges.cloudflare.com");
  expect(buyerCsp("n", { dev: true, turnstile: false })).toContain("'unsafe-eval'");
});

test("proxy: CSP com nonce novo a cada requisição, na resposta e na requisição (o Next aplica o nonce nos scripts)", () => {
  const a = proxy(new NextRequest("http://127.0.0.1:3000/c/oferta"));
  const b = proxy(new NextRequest("http://127.0.0.1:3000/o/abc"));
  const cspA = a.headers.get("content-security-policy")!;
  const cspB = b.headers.get("content-security-policy")!;
  const nonce = (csp: string) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  expect(nonce(cspA)).toBeTruthy();
  expect(nonce(cspA)!.length).toBeGreaterThanOrEqual(22);
  expect(nonce(cspA)).not.toBe(nonce(cspB));
  expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(cspA);
});

test("matcher: só /c e /o; painel, API, download e t.js ficam de fora", () => {
  const m = (url: string) => unstable_doesMiddlewareMatch({ config, url });
  expect(m("/c/oferta")).toBe(true);
  expect(m("/o/abc123")).toBe(true);
  for (const url of ["/admin", "/admin/login", "/api/health", "/d/token", "/t.js", "/", "/cx", "/order"]) expect(m(url), url).toBe(false);
});
