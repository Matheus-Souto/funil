// Cliente da API do Resend (e-mail pela conta da própria loja). Destino fixo (`api.resend.com`): sem host configurável
// pela loja, logo sem SSRF (o env só aceita `RESEND_BASE_URL` em loopback, para o Resend falso do smoke). A chave vai SÓ no header `Authorization`; a mensagem de erro vem só do status HTTP (nunca do corpo da
// resposta) e o log leva só o status. Nada aqui toca o banco nem roda dentro de transação.
// Também guarda a conexão, a escolha do provedor ativo e o teste (ações). Só importa o TIPO de `./mailer` (o mailer importa este módulo: sem ciclo em runtime).
import { and, eq, notExists } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Actor } from "@/lib/actions/core";
import { sha256 } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { integration, store } from "@/lib/db/schema";
import { IntegrationSecretUnreadable, getIntegration, readIntegration, saveIntegration, type IntegrationConfig } from "@/lib/integrations";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { limitConnectionTest } from "@/lib/mcp/limits";
import { NOT_CONFIGURED, logEmail } from "./email-log";
import type { MailMessage } from "./mailer";
import { cleanHeaders, oneLine } from "./templates";

const RESEND_BASE = "https://api.resend.com";
const resendUrl = () => `${(env.RESEND_BASE_URL ?? RESEND_BASE).replace(/\/+$/, "")}/emails`;
const TIMEOUT_MS = 15_000;
const MAX_NAME = 100;
/** Maior id de mensagem aceito na resposta (cabe em `email_log.provider_message_id` e no `email_id` do webhook). */
const MAX_ID = 100;

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
    res = await (fetchOverride ?? fetch)(resendUrl(), {
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
        ...(msg.headers ? { headers: cleanHeaders(msg.headers) } : {}),
      }),
      signal,
      // Destino fixo: um redirecionamento levaria a chave (Authorization) a outro host.
      redirect: "error",
    });
  } catch {
    // Nunca repassa o erro da rede (texto do runtime; pode trazer detalhes da requisição).
    if (opts.signal?.aborted) throw abortError(opts.signal);
    log.warn("Resend recusou o envio", { status: 0 });
    throw providerError(0);
  }
  if (!res.ok) {
    // O corpo do erro nunca é lido (pode ecoar dados); só é descartado para liberar a conexão.
    await res.body?.cancel().catch(() => {});
    log.warn("Resend recusou o envio", { status: res.status });
    throw providerError(res.status);
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || !body.id || body.id.length > MAX_ID) {
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

/** SMTP utilizável: os mesmos campos que `loadSmtp` exige (host, porta e remetente). */
export function smtpConfigUsable(c: IntegrationConfig | undefined): boolean {
  return typeof c?.host === "string" && c.host !== "" && typeof c.port === "number" && c.port > 0 && typeof c.from === "string" && c.from !== "";
}

export const saveResend = defineAction({
  name: "connections.saveResend",
  description:
    "Conecta o Resend da loja (remetente, chave de API e segredo do webhook): campo omitido mantém o valor guardado. Se a loja não tem SMTP e ainda está no padrão, também ativa o Resend como provedor dos e-mails da loja (resultado em `activated`).",
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
    if (!current && !input.webhookSecret) {
      // Segredo guardado que não abre (SECRET trocado): manter o webhook em silêncio o apagaria. Pede o segredo de novo.
      const stored = await readIntegration(ctx.tx, ctx.storeId, "resend");
      if (stored?.unreadable && stored.config.webhookSecretLast4 != null) {
        const message = "O segredo guardado não pode ser lido: cole de novo o segredo do webhook (whsec_…).";
        throw new ActionError("invalid_input", message, [{ path: ["webhookSecret"], message }]);
      }
    }
    const webhookSecret = input.webhookSecret ?? current?.webhookSecret ?? null;
    const config = {
      fromEmail: input.fromEmail,
      fromName: input.fromName ? input.fromName : null,
      apiKeyLast4: apiKey.slice(-4),
      webhookSecretLast4: last4(webhookSecret),
    };
    await saveIntegration(ctx.tx, ctx.storeId, "resend", config, JSON.stringify({ apiKey, webhookSecret }));
    // Loja sem SMTP que ainda está no padrão (smtp): o Resend é o único provedor possível, então já fica ativo.
    const activated = await ctx.tx
      .update(store)
      .set({ emailProvider: "resend" })
      .where(
        and(
          eq(store.id, ctx.storeId),
          eq(store.emailProvider, "smtp"),
          notExists(ctx.tx.select({ kind: integration.kind }).from(integration).where(and(eq(integration.storeId, ctx.storeId), eq(integration.kind, "smtp")))),
        ),
      )
      .returning({ id: store.id });
    return { ...config, activated: activated.length > 0 };
  },
  // A ativação automática fica visível na auditoria (`result.activated`).
  auditResult: (o) => ({ activated: o.activated }),
});

export const setEmailProvider = defineAction({
  name: "connections.setEmailProvider",
  description: "Escolhe por qual provedor (SMTP ou Resend) a loja envia e-mail. Só se ativa um provedor já conectado.",
  input: z.object({ provider: z.enum(["smtp", "resend"]) }),
  permission: "connections.write",
  sensitive: true,
  async run(ctx, { provider }) {
    const label = provider === "smtp" ? "SMTP" : "Resend";
    // Só ativa conexão que o envio consegue usar (o botão escondido no painel não protege o MCP).
    const conn = await readIntegration(ctx.tx, ctx.storeId, provider);
    if (conn?.unreadable) {
      throw new ActionError("invalid_input", `A conexão ${label} não pode ser lida: salve as credenciais de novo antes de ativá-la.`, [{ path: ["provider"] }]);
    }
    const usable = provider === "resend" ? conn !== null && (await loadResend(ctx.tx, ctx.storeId)) !== null : smtpConfigUsable(conn?.config);
    if (!usable) throw new ActionError("invalid_input", `Configure o ${label} antes de ativá-lo.`, [{ path: ["provider"] }]);
    await ctx.tx.update(store).set({ emailProvider: provider }).where(eq(store.id, ctx.storeId));
    return { provider };
  },
});

/**
 * Destino de um e-mail de teste. Ator token: sempre o e-mail de avisos da loja (o `to` recebido é ignorado; sem e-mail de
 * avisos, `conflict`). Ator usuário: o `to` informado (obrigatório). Usado por `testSmtp` e `testResend`.
 */
export async function testRecipient(call: { storeId: string; actor: Actor }, to: string | undefined): Promise<string> {
  if (call.actor.kind !== "token") {
    if (!to) throw new ActionError("invalid_input", "Informe o e-mail de destino.", [{ path: ["to"], message: "Informe o e-mail de destino." }]);
    return to;
  }
  const notify = await withStore(call.storeId, async (tx) => {
    const [s] = await tx.select({ notifyEmail: store.notifyEmail }).from(store).where(eq(store.id, call.storeId));
    return s?.notifyEmail ?? null;
  });
  if (!notify) throw new ActionError("conflict", "Defina o e-mail de avisos da loja para testar pelo agente");
  return notify;
}

export const testResend = defineAction({
  name: "connections.testResend",
  description:
    "Envia um e-mail de teste pelo Resend da loja. Pelo painel vai para o endereço informado (to); pelo agente (MCP) vai sempre para o e-mail de avisos da loja, e o to é ignorado.",
  input: z.object({ to: EMAIL.optional() }),
  permission: "connections.write",
  // O envio (rede) acontece aqui, fora da transação; o id da mensagem e o destino seguem para `run`, que só registra o resultado.
  async prepare(call, input) {
    await limitConnectionTest(call.actor, "testResend", call.storeId);
    const to = await testRecipient(call, input.to);
    const { resend, storeName } = await withStore(call.storeId, async (tx) => {
      const [s] = await tx.select({ name: store.name }).from(store).where(eq(store.id, call.storeId));
      return { resend: await loadResend(tx, call.storeId), storeName: s?.name ?? "" };
    });
    if (!resend) throw new ActionError("provider_error", NOT_CONFIGURED);
    const text = "Este é um e-mail de teste. Se chegou, as entregas da sua loja vão sair pelo Resend.";
    const sent = await sendViaResend(resend, storeName, { to, subject: `E-mail de teste da ${storeName || "sua loja"}`, text, html: `<p>${text}</p>` });
    return { ...sent, to };
  },
  async run(ctx, _input, sent) {
    await logEmail(ctx.tx, { storeId: ctx.storeId, to: sent.to, kind: "test", status: "sent", provider: "resend", messageId: sent.id });
    return { sent: true };
  },
});
