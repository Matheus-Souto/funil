// Cloudflare Turnstile (CAPTCHA) no servidor. Sem TURNSTILE_SECRET, a verificação passa (recurso opcional).
// O desafio roda no checkout da loja (nunca no iframe do cartão): o `hostname` que o siteverify devolve (onde o
// desafio foi resolvido) precisa ser um host do checkout dessa loja. Um token resolvido em outro site com a mesma chave
// de site, ou no checkout de outra loja da plataforma, não vale aqui.
import { env } from "@/lib/env";
import { log } from "@/lib/log";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 10_000;

export interface TurnstileDeps {
  /** Padrão: env.TURNSTILE_SECRET. `undefined` explícito = não configurado. */
  secret?: string | undefined;
  fetch?: typeof fetch;
}

/** Hosts (sem esquema nem porta, minúsculas) das origens do checkout da loja (`storeCheckoutOrigins`). */
export function checkoutHostnames(origins: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of origins) {
    try {
      out.push(new URL(o).hostname.toLowerCase());
    } catch {
      /* origem malformada: fica de fora */
    }
  }
  return out;
}

/**
 * `true` se o token do Turnstile for válido para este IP e foi resolvido num dos `hosts` (checkout da loja), ou se o
 * Turnstile não estiver configurado.
 */
export async function verifyTurnstile(token: string | undefined, ip: string, opts: { hosts: readonly string[] } & TurnstileDeps): Promise<boolean> {
  const secret = "secret" in opts ? opts.secret : env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as { success?: unknown; hostname?: unknown };
    if (json?.success !== true) return false;
    const host = typeof json.hostname === "string" ? json.hostname.toLowerCase() : null;
    if (host === null || !opts.hosts.some((h) => h.toLowerCase() === host)) {
      log.warn("turnstile: token resolvido fora do checkout da loja");
      return false;
    }
    return true;
  } catch {
    log.warn("turnstile: verificação indisponível");
    return false;
  }
}
