// Cloudflare Turnstile (CAPTCHA) no servidor. Sem TURNSTILE_SECRET, a verificação passa (recurso opcional).
import { env } from "@/lib/env";
import { log } from "@/lib/log";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 10_000;

export interface TurnstileDeps {
  /** Padrão: env.TURNSTILE_SECRET. `undefined` explícito = não configurado. */
  secret?: string | undefined;
  fetch?: typeof fetch;
}

/** `true` se o token do Turnstile for válido para este IP (ou se o Turnstile não estiver configurado). */
export async function verifyTurnstile(token: string | undefined, ip: string, deps: TurnstileDeps = {}): Promise<boolean> {
  const secret = "secret" in deps ? deps.secret : env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as { success?: unknown };
    return json?.success === true;
  } catch {
    log.warn("turnstile: verificação indisponível");
    return false;
  }
}
