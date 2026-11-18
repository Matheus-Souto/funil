// E-mail pela conexão SMTP da própria loja (nodemailer). Config pública `{ host, port, secure, user, from }`; a senha
// é o segredo selado. Nenhuma chamada de rede acontece dentro de transação do banco: a conexão é lida numa transação
// curta e o envio/teste vem depois (em `prepare` nas ações).
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { sha256 } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { emailLog, store } from "@/lib/db/schema";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { log, redact } from "@/lib/log";

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

export interface SentMail {
  from: { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailTransport {
  verify(): Promise<unknown>;
  sendMail(m: SentMail): Promise<unknown>;
  close(): void;
}
export type TransportFactory = (s: SmtpSettings) => MailTransport;

const defaultFactory: TransportFactory = (s) => {
  const auth = s.user ? { user: s.user, pass: s.password ?? "" } : undefined;
  const t = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    // Com usuário/senha em porta sem TLS direto, exige STARTTLS: a senha nunca trafega em texto puro.
    requireTLS: !s.secure && auth !== undefined,
    auth,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return { verify: () => t.verify(), sendMail: (m) => t.sendMail(m), close: () => t.close() };
};
let factory: TransportFactory = defaultFactory;

/** Só para testes: troca o transporte (sem argumento, volta ao nodemailer). */
export function setMailTransportForTests(f?: TransportFactory): void {
  factory = f ?? defaultFactory;
}

const NOT_CONFIGURED = "E-mail não configurado";

/** Conexão SMTP da loja com a senha aberta, ou `null`. Nunca logar nem devolver ao navegador. */
export async function loadSmtp(tx: Tx, storeId: string): Promise<SmtpSettings | null> {
  const conn = await getIntegration(tx, storeId, "smtp");
  const c = conn?.config as Partial<SmtpSettings> | undefined;
  if (!conn || !c?.host || !c.port || !c.from) return null;
  return { host: c.host, port: c.port, secure: c.secure === true, user: c.user ?? null, password: conn.secret, from: c.from };
}

const oneLine = (s: string, max: number) => s.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("envio de e-mail cancelado");
}

/** Envia com a conexão e o remetente informados. Respeita `signal` (fecha a conexão ao abortar). */
async function deliver(s: SmtpSettings, storeName: string, msg: MailMessage, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  const transport = factory(s);
  const mail: SentMail = {
    from: { name: oneLine(storeName, 100), address: s.from },
    to: msg.to,
    subject: oneLine(msg.subject, 250),
    html: msg.html,
    text: msg.text,
  };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      transport.close();
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([transport.sendMail(mail), aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    transport.close();
  }
}

/**
 * Envia um e-mail pela conexão SMTP da loja. Sem conexão: `provider_error("E-mail não configurado")`.
 * Não chamar dentro de transação (lê a conexão numa transação própria e só depois fala com o servidor).
 */
export async function sendMail(storeId: string, msg: MailMessage, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const { smtp, storeName } = await withStore(storeId, async (tx) => {
    const [s] = await tx.select({ name: store.name }).from(store).where(eq(store.id, storeId));
    return { smtp: await loadSmtp(tx, storeId), storeName: s?.name ?? "" };
  });
  if (!smtp) throw new ActionError("provider_error", NOT_CONFIGURED);
  await deliver(smtp, storeName, msg, opts.signal);
}

export type EmailKind = "delivery" | "seller_notice" | "test";

/** Registra um envio (destinatário só como sha256). Erro com no máximo 500 caracteres e sem dados de cartão. */
export async function logEmail(
  tx: Tx,
  row: { storeId: string; orderId?: string | null; jobId?: string | null; to: string; kind: EmailKind; status: "sent" | "failed"; error?: unknown },
): Promise<void> {
  const error = row.error === undefined ? null : String(redact(row.error instanceof Error ? row.error.message : String(row.error))).slice(0, 500);
  await tx.insert(emailLog).values({
    storeId: row.storeId,
    orderId: row.orderId ?? null,
    jobId: row.jobId ?? null,
    toHash: sha256(row.to.trim().toLowerCase()),
    kind: row.kind,
    status: row.status,
    error,
  });
}

/** Mensagem para o dono a partir do erro do nodemailer (sem ecoar a resposta do servidor inteira). */
function smtpProblem(e: unknown, s: SmtpSettings): string {
  const code = (e as { code?: string } | null)?.code ?? "";
  if (code === "EAUTH") return "O servidor SMTP recusou o usuário ou senha. Confira os dados e tente de novo.";
  if (code === "ETLS") return "Não foi possível estabelecer conexão segura (TLS) com o servidor SMTP. Confira a porta e a opção de conexão segura.";
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ENOTFOUND"].includes(code)) {
    return `Não foi possível conectar ao servidor SMTP ${s.host}:${s.port}. Confira o endereço e a porta.`;
  }
  return "O servidor SMTP não aceitou a conexão. Confira os dados e tente de novo.";
}

const EMAIL = z.string().trim().toLowerCase().max(254).pipe(z.email());

const smtpInput = z.object({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/, "Servidor inválido"),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(254).optional(),
  /** Omitida: mantém a senha já guardada. */
  password: z.string().max(500).optional(),
  from: EMAIL,
});

export const saveSmtp = defineAction({
  name: "connections.saveSmtp",
  description: "Conecta o SMTP da loja (servidor, porta, usuário, senha e remetente): testa a conexão e só então salva.",
  input: smtpInput,
  permission: "connections.write",
  // Quem controla o SMTP controla o remetente das entregas: MCP/IA precisam de aprovação.
  sensitive: true,
  auditInput: (i) => ({ host: i.host, port: i.port, secure: i.secure, user: i.user ?? null, from: i.from, password: i.password ? "[novo]" : "[mantido]" }),
  async prepare(call, input) {
    const kept = input.password === undefined ? (await withStore(call.storeId, (tx) => loadSmtp(tx, call.storeId)))?.password ?? null : null;
    const user = input.user ? input.user : null;
    const settings: SmtpSettings = { host: input.host, port: input.port, secure: input.secure, user, password: input.password ?? kept, from: input.from };
    const t = factory(settings);
    try {
      await t.verify();
    } catch (e) {
      log.warn("SMTP recusado no teste da conexão", { storeId: call.storeId, host: input.host, port: input.port, code: (e as { code?: string }).code });
      throw new ActionError("provider_error", smtpProblem(e, settings));
    } finally {
      t.close();
    }
  },
  async run(ctx, input) {
    const config = { host: input.host, port: input.port, secure: input.secure, user: input.user ? input.user : null, from: input.from };
    await saveIntegration(ctx.tx, ctx.storeId, "smtp", config, input.password);
    const saved = await loadSmtp(ctx.tx, ctx.storeId);
    return { ...config, hasPassword: Boolean(saved?.password) };
  },
});

export const testSmtp = defineAction({
  name: "connections.testSmtp",
  description: "Envia um e-mail de teste pela conexão SMTP da loja para o endereço informado.",
  input: z.object({ to: EMAIL }),
  permission: "connections.write",
  // O envio (rede) acontece aqui, fora da transação; a ação só registra o resultado.
  async prepare(call, { to }) {
    const { smtp, storeName } = await withStore(call.storeId, async (tx) => {
      const [s] = await tx.select({ name: store.name }).from(store).where(eq(store.id, call.storeId));
      return { smtp: await loadSmtp(tx, call.storeId), storeName: s?.name ?? "" };
    });
    if (!smtp) throw new ActionError("provider_error", NOT_CONFIGURED);
    try {
      await deliver(smtp, storeName, {
        to,
        subject: `E-mail de teste da ${storeName || "sua loja"}`,
        text: "Este é um e-mail de teste. Se chegou, as entregas da sua loja vão sair por este SMTP.",
        html: "<p>Este é um e-mail de teste. Se chegou, as entregas da sua loja vão sair por este SMTP.</p>",
      });
    } catch (e) {
      throw new ActionError("provider_error", smtpProblem(e, smtp));
    }
  },
  async run(ctx, { to }) {
    await logEmail(ctx.tx, { storeId: ctx.storeId, to, kind: "test", status: "sent" });
    return { sent: true };
  },
});
