// Cliente da API do Resend (e-mail pela conta da própria loja). Destino fixo (`api.resend.com`): sem host configurável,
// logo sem SSRF. A chave vai SÓ no header `Authorization`; a mensagem de erro vem só do status HTTP (nunca do corpo da
// resposta) e o log leva só o status. Nada aqui toca o banco nem roda dentro de transação.
// Também guarda a conexão, a escolha do provedor ativo e o teste (ações). Só importa o TIPO de `./mailer` (o mailer importa este módulo: sem ciclo em runtime).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { sha256 } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { integration, store } from "@/lib/db/schema";
import { IntegrationSecretUnreadable, getIntegration, saveIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { NOT_CONFIGURED, logEmail } from "./email-log";
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

/**
 * `Idempotency-Key` = `<id do job>:<sha256 da mensagem>`. O Resend responde 409 quando a mesma chave chega com corpo
 * diferente, e cada execução do job gera links novos (corpo novo): com o hash, só a repetição idêntica da mesma
 * mensagem reaproveita a chave. Sempre abaixo de 256 caracteres (o id do job é um UUID; 36 + 1 + 64).
 */
export function resendIdempotencyKey(jobId: string, msg: MailMessage): string {
  return `${jobId.slice(0, 150)}:${sha256(`${msg.subject}\n${msg.text}\n${msg.html}`)}`;
}

/** Envia pelo Resend. `idempotencyKey` é o id do job; o cabeçalho leva a chave composta com o hash da mensagem (o Resend guarda 24 h). */
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
        ...(opts.idempotencyKey ? { "Idempotency-Key": resendIdempotencyKey(opts.idempotencyKey, msg) } : {}),
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

/** E-mail de remetente/destinatário: sem espaços nas pontas, em minúsculas, até 254 caracteres. Usado também pelo mailer. */
export const EMAIL = z.string().trim().toLowerCase().max(254).pipe(z.email());

/**
 * Conexão Resend da loja (config `{ fromEmail, fromName, apiKeyLast4, webhookSecretLast4 }`; segredo selado
 * `{ apiKey, webhookSecret }`). `null` quando não há conexão ou o segredo não abre (SECRET trocado): o envio vira o
 * erro genérico "não configurado" e o painel mostra "ilegível". Outros erros propagam.
 */
export async function loadResend(tx: Tx, storeId: string): Promise<(ResendSettings & { webhookSecret: string | null }) | null> {
  let conn: Awaited<ReturnType<typeof getIntegration>>;
  try {
    conn = await getIntegration(tx, storeId, "resend");
  } catch (e) {
    if (!(e instanceof IntegrationSecretUnreadable)) throw e;
    log.warn("segredo da conexão não pode ser aberto", { storeId, kind: "resend" });
    return null;
  }
  const sealed = parseSealed(conn?.secret ?? null);
  if (!conn || !sealed) return null;
  const fromEmail = conn.config.fromEmail;
  if (typeof fromEmail !== "string") return null;
  const fromName = conn.config.fromName;
  return { apiKey: sealed.apiKey, fromEmail, fromName: typeof fromName === "string" ? fromName : null, webhookSecret: sealed.webhookSecret };
}

function parseSealed(secret: string | null): { apiKey: string; webhookSecret: string | null } | null {
  if (secret === null) return null;
  try {
    const v = JSON.parse(secret) as { apiKey?: unknown; webhookSecret?: unknown } | null;
    if (typeof v?.apiKey !== "string" || !v.apiKey) return null;
    return { apiKey: v.apiKey, webhookSecret: typeof v.webhookSecret === "string" && v.webhookSecret ? v.webhookSecret : null };
  } catch {
    return null;
  }
}

const last4 = (v: string | null) => (v ? v.slice(-4) : null);

export const saveResend = defineAction({
  name: "connections.saveResend",
  description: "Conecta o Resend da loja (remetente, chave de API e segredo do webhook): campo omitido mantém o valor guardado.",
  input: z.object({
    fromEmail: EMAIL,
    fromName: z.string().trim().max(100).optional(),
    /** Omitida: mantém a chave guardada. */
    apiKey: z.string().regex(/^re_[A-Za-z0-9_]{8,200}$/, "Chave de API do Resend inválida").optional(),
    /** Omitido: mantém o segredo guardado. */
    webhookSecret: z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,200}$/, "Segredo do webhook do Resend inválido").optional(),
  }),
  permission: "connections.write",
  // Quem controla a chave controla o remetente das entregas: MCP/IA precisam de aprovação.
  sensitive: true,
  auditInput: (i) => ({
    fromEmail: i.fromEmail,
    fromName: i.fromName ?? null,
    apiKey: i.apiKey ? "[novo]" : "[mantido]",
    webhookSecret: i.webhookSecret ? "[novo]" : "[mantido]",
  }),
  async run(ctx, input) {
    const current = await loadResend(ctx.tx, ctx.storeId);
    const apiKey = input.apiKey ?? current?.apiKey;
    if (!apiKey) throw new ActionError("invalid_input", "Informe a chave de API do Resend.", [{ path: ["apiKey"], message: "Informe a chave de API do Resend." }]);
    const webhookSecret = input.webhookSecret ?? current?.webhookSecret ?? null;
    const config = {
      fromEmail: input.fromEmail,
      fromName: input.fromName ? input.fromName : null,
      apiKeyLast4: apiKey.slice(-4),
      webhookSecretLast4: last4(webhookSecret),
    };
    await saveIntegration(ctx.tx, ctx.storeId, "resend", config, JSON.stringify({ apiKey, webhookSecret }));
    return config;
  },
});

export const setEmailProvider = defineAction({
  name: "connections.setEmailProvider",
  description: "Escolhe por qual provedor (SMTP ou Resend) a loja envia e-mail. Só se ativa um provedor já conectado.",
  input: z.object({ provider: z.enum(["smtp", "resend"]) }),
  permission: "connections.write",
  sensitive: true,
  async run(ctx, { provider }) {
    const [conn] = await ctx.tx.select({ kind: integration.kind }).from(integration).where(and(eq(integration.storeId, ctx.storeId), eq(integration.kind, provider)));
    if (!conn) throw new ActionError("invalid_input", `Configure o ${provider === "smtp" ? "SMTP" : "Resend"} antes de ativá-lo.`, [{ path: ["provider"] }]);
    await ctx.tx.update(store).set({ emailProvider: provider }).where(eq(store.id, ctx.storeId));
    return { provider };
  },
});

export const testResend = defineAction({
  name: "connections.testResend",
  description: "Envia um e-mail de teste pelo Resend da loja para o endereço informado.",
  input: z.object({ to: EMAIL }),
  permission: "connections.write",
  // O envio (rede) acontece aqui, fora da transação; o id da mensagem segue para `run`, que só registra o resultado.
  async prepare(call, { to }) {
    const { resend, storeName } = await withStore(call.storeId, async (tx) => {
      const [s] = await tx.select({ name: store.name }).from(store).where(eq(store.id, call.storeId));
      return { resend: await loadResend(tx, call.storeId), storeName: s?.name ?? "" };
    });
    if (!resend) throw new ActionError("provider_error", NOT_CONFIGURED);
    const text = "Este é um e-mail de teste. Se chegou, as entregas da sua loja vão sair pelo Resend.";
    return sendViaResend(resend, storeName, { to, subject: `E-mail de teste da ${storeName || "sua loja"}`, text, html: `<p>${text}</p>` });
  },
  async run(ctx, { to }, sent) {
    await logEmail(ctx.tx, { storeId: ctx.storeId, to, kind: "test", status: "sent", provider: "resend", messageId: sent.id });
    return { sent: true };
  },
});
