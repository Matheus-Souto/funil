// Cliente da API do Resend (e-mail pela conta da própria loja). Destino fixo (`api.resend.com`): sem host configurável,
// logo sem SSRF. A chave vai SÓ no header `Authorization`; a mensagem de erro vem só do status HTTP (nunca do corpo da
// resposta) e o log leva só o status. Nada aqui toca o banco nem roda dentro de transação.
// Só importa o TIPO de `./mailer` (o mailer importa este módulo: sem ciclo em runtime).
import { ActionError } from "@/lib/actions/core";
import { log } from "@/lib/log";
import type { MailMessage } from "./mailer";
import { oneLine } from "./templates";

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;
const MAX_NAME = 100;

export interface ResendSettings {
  apiKey: string;
  fromEmail: string;
  fromName: string | null;
}

export const RESEND_ERRORS = {
  key: "O Resend recusou a chave de API. Confira a chave e as permissões dela.",
  rejected: "O Resend recusou o envio. Confira se o domínio do remetente está verificado no Resend.",
  rateLimited: "O Resend limitou os envios por excesso de requisições. O envio será tentado de novo.",
  unreachable: "Não foi possível falar com o Resend agora. O envio será tentado de novo.",
} as const;

let fetchOverride: typeof fetch | undefined;
/** Testes: troca o `fetch` usado com o Resend (sem argumento volta ao normal). */
export function setResendFetchForTests(f?: typeof fetch): void {
  fetchOverride = f;
}

/** `Nome <email>` com o nome em uma linha, até 100 caracteres e sem `<`, `>`, `"` nem `\`. Nome vazio: só o e-mail. */
export function resendFrom(fromName: string, fromEmail: string): string {
  const name = oneLine(fromName).replace(/[<>"\\]/g, "").trim().slice(0, MAX_NAME).trim();
  return name ? `${name} <${fromEmail}>` : fromEmail;
}

const abortError = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new Error("envio de e-mail cancelado"));

function providerError(status: number): ActionError {
  const message =
    status === 401 || status === 403
      ? RESEND_ERRORS.key
      : status === 400 || status === 422
        ? RESEND_ERRORS.rejected
        : status === 429
          ? RESEND_ERRORS.rateLimited
          : RESEND_ERRORS.unreachable;
  return new ActionError("provider_error", message, { status });
}

/** Envia pelo Resend. `Idempotency-Key` (o id do job) evita e-mail duplicado em re-tentativa (o Resend guarda 24 h). */
export async function sendViaResend(
  s: ResendSettings,
  storeName: string,
  msg: MailMessage,
  opts: { signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<{ id: string }> {
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (fetchOverride ?? fetch)(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${s.apiKey}`,
        "Content-Type": "application/json",
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: resendFrom(s.fromName ?? storeName, s.fromEmail),
        to: [msg.to],
        subject: oneLine(msg.subject).trim().slice(0, 250),
        html: msg.html,
        text: msg.text,
      }),
      signal,
    });
  } catch {
    // Nunca repassa o erro da rede (texto do runtime; pode trazer detalhes da requisição).
    if (opts.signal?.aborted) throw abortError(opts.signal);
    log.warn("Resend recusou o envio", { status: 0 });
    throw providerError(0);
  }
  if (!res.ok) {
    log.warn("Resend recusou o envio", { status: res.status });
    throw providerError(res.status);
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || !body.id) {
    log.warn("Resend recusou o envio", { status: res.status });
    throw providerError(0);
  }
  return { id: body.id };
}
