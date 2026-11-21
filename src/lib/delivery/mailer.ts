// E-mail pela conexão SMTP da própria loja (nodemailer). Config pública `{ host, port, secure, user, from }`; a senha
// é o segredo selado. Nenhuma chamada de rede acontece dentro de transação do banco: a conexão é lida numa transação
// curta e o envio/teste vem depois (em `prepare` nas ações).
//
// SSRF (MODE=multi em produção: o servidor é escolhido pelo dono de QUALQUER loja): só as portas 25/465/587/2525; o
// host é resolvido e recusado se algum endereço for loopback, privado, link-local, CGNAT, ULA, multicast ou reservado;
// a conexão vai para o IP já resolvido (com `tls.servername` = host, para o certificado) e não resolve de novo (sem
// DNS rebinding). Toda falha de conexão vira a mesma mensagem genérica (não serve para mapear a rede interna).
// Vale para salvar, testar e enviar. MODE=single e fora de produção ficam como antes (o smoke usa 127.0.0.1:1025).
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { withStore, type Tx } from "@/lib/db/client";
import { store } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { limitConnectionTest } from "@/lib/mcp/limits";
import { NOT_CONFIGURED, logEmail } from "./email-log";
import { EMAIL, loadResend, sendViaResend, testRecipient } from "./resend";
import { cleanHeaders, oneLine, type MailHeaders } from "./templates";

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
  /** Nome do servidor para o TLS (SNI e certificado) quando `host` já é o IP resolvido. */
  servername?: string;
}

export interface SentMail {
  from: { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: MailHeaders;
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
    ...(s.servername ? { tls: { servername: s.servername } } : {}),
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

// ---- Rede permitida (SSRF) -------------------------------------------------------------------------------------

export const STRICT_SMTP_PORTS = [25, 465, 587, 2525] as const;
export const SMTP_GENERIC_ERROR = "Não foi possível conectar ao servidor SMTP. Confira o servidor, a porta, o usuário e a senha.";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (inclui metadados de nuvem)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado + broadcast
] as const) {
  blocked.addSubnet(net, bits, "ipv4");
}
// IPv4 mapeado (::ffff:a.b.c.d) é conferido como IPv4 em isPublicAddress. Não pôr ::ffff:0:0/96 aqui: o BlockList
// confere IPv4 também contra regras IPv6 mapeadas, e essa regra bloquearia TODO IPv4.
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64
  ["100::", 64],
  ["2001::", 23], // IETF/Teredo etc.
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
  ["fec0::", 10],
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

/** Endereço público e roteável (nem loopback, privado, link-local, CGNAT, ULA, multicast ou reservado). */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !blocked.check(ip, "ipv4");
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

type Lookup = (host: string) => Promise<string[]>;
const defaultLookup: Lookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
let lookupImpl: Lookup = defaultLookup;
let strictOverride: boolean | undefined;

/** Só para testes: liga/desliga o modo restrito e troca a resolução de nomes (sem argumento, volta ao padrão). */
export function setSmtpNetworkForTests(o: { strict?: boolean; lookup?: Lookup } = {}): void {
  strictOverride = o.strict;
  lookupImpl = o.lookup ?? defaultLookup;
}

const strictNetwork = () => strictOverride ?? (env.MODE === "multi" && process.env.NODE_ENV === "production");

/**
 * No modo restrito: confere a porta, resolve o host, recusa endereços internos e devolve a conexão FIXADA no IP
 * (com `servername` para o TLS). Fora dele, devolve a conexão como está.
 */
export async function pinSmtpTarget(s: SmtpSettings, storeId: string): Promise<SmtpSettings> {
  if (!strictNetwork()) return s;
  if (!(STRICT_SMTP_PORTS as readonly number[]).includes(s.port)) {
    throw new ActionError("invalid_input", "Use a porta 587 (recomendada), 465, 2525 ou 25.");
  }
  const host = s.host.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await lookupImpl(host);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a))) {
    log.warn("SMTP recusado: endereço não público ou não resolvido", { storeId, host: s.host });
    throw new ActionError("provider_error", SMTP_GENERIC_ERROR);
  }
  return { ...s, host: addresses[0]!, ...(isIP(host) ? {} : { servername: host }) };
}

/** Conexão SMTP da loja com a senha aberta, ou `null`. Nunca logar nem devolver ao navegador. */
export async function loadSmtp(tx: Tx, storeId: string): Promise<SmtpSettings | null> {
  const conn = await getIntegration(tx, storeId, "smtp");
  const c = conn?.config as Partial<SmtpSettings> | undefined;
  if (!conn || !c?.host || !c.port || !c.from) return null;
  return { host: c.host, port: c.port, secure: c.secure === true, user: c.user ?? null, password: conn.secret, from: c.from };
}

const header = (s: string, max: number) => oneLine(s).trim().slice(0, max);

export { logEmail, type EmailKind } from "./email-log";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Vazio ou ausente: o envio sai como sempre. */
  headers?: MailHeaders;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("envio de e-mail cancelado");
}

/** Envia com a conexão e o remetente informados. Respeita `signal` (fecha a conexão ao abortar). */
async function deliver(s: SmtpSettings, storeName: string, msg: MailMessage, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  const transport = factory(s);
  const mail: SentMail = {
    from: { name: header(storeName, 100), address: s.from },
    to: msg.to,
    subject: header(msg.subject, 250),
    html: msg.html,
    text: msg.text,
    ...(msg.headers ? { headers: cleanHeaders(msg.headers) } : {}),
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

export type EmailProvider = "smtp" | "resend";

/**
 * Envia um e-mail pelo provedor ativo da loja (`store.email_provider`: SMTP ou Resend; nunca cai para o outro). Sem conexão
 * do provedor ativo (ou com o segredo ilegível): `provider_error("E-mail não configurado")`. O SMTP devolve
 * `messageId: null`; `idempotencyKey` só vale para o Resend. `onProvider` avisa qual provedor é o ativo assim que se sabe
 * (para o log de falha). Não chamar dentro de transação: lê tudo numa transação curta e só depois fala com a rede.
 */
export async function sendMail(
  storeId: string,
  msg: MailMessage,
  opts: { signal?: AbortSignal; idempotencyKey?: string; onProvider?: (p: EmailProvider) => void } = {},
): Promise<{ provider: EmailProvider; messageId: string | null }> {
  const cfg = await withStore(storeId, async (tx) => {
    const [s] = await tx.select({ name: store.name, provider: store.emailProvider }).from(store).where(eq(store.id, storeId));
    const provider: EmailProvider = s?.provider === "resend" ? "resend" : "smtp";
    return {
      provider,
      storeName: s?.name ?? "",
      smtp: provider === "smtp" ? await loadSmtp(tx, storeId) : null,
      resend: provider === "resend" ? await loadResend(tx, storeId) : null,
    };
  });
  opts.onProvider?.(cfg.provider);
  if (cfg.provider === "resend") {
    if (!cfg.resend) throw new ActionError("provider_error", NOT_CONFIGURED);
    const { id } = await sendViaResend(cfg.resend, cfg.storeName, msg, { signal: opts.signal, idempotencyKey: opts.idempotencyKey });
    return { provider: "resend", messageId: id };
  }
  if (!cfg.smtp) throw new ActionError("provider_error", NOT_CONFIGURED);
  await deliver(await pinSmtpTarget(cfg.smtp, storeId), cfg.storeName, msg, opts.signal);
  return { provider: "smtp", messageId: null };
}

/** Mensagem para o dono a partir do erro do nodemailer (sem ecoar a resposta do servidor inteira). */
function smtpProblem(e: unknown, s: SmtpSettings): string {
  if (strictNetwork()) return SMTP_GENERIC_ERROR;
  const code = (e as { code?: string } | null)?.code ?? "";
  if (code === "EAUTH") return "O servidor SMTP recusou o usuário ou senha. Confira os dados e tente de novo.";
  if (code === "ETLS") return "Não foi possível estabelecer conexão segura (TLS) com o servidor SMTP. Confira a porta e a opção de conexão segura.";
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ENOTFOUND"].includes(code)) {
    return `Não foi possível conectar ao servidor SMTP ${s.host}:${s.port}. Confira o endereço e a porta.`;
  }
  return "O servidor SMTP não aceitou a conexão. Confira os dados e tente de novo.";
}

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
    const user = input.user ? input.user : null;
    let kept: string | null = null;
    if (input.password === undefined) {
      const current = await withStore(call.storeId, (tx) => loadSmtp(tx, call.storeId));
      // A senha guardada só vale para o mesmo servidor, porta e usuário: nunca é enviada a um servidor novo.
      const same = current !== null && current.host === input.host && current.port === input.port && current.user === user;
      if (!same && (current !== null || user !== null)) {
        throw new ActionError("invalid_input", "Para trocar o servidor, a porta ou o usuário, informe a senha de novo.", [{ path: ["password"] }]);
      }
      kept = same ? current.password : null;
    }
    const settings = await pinSmtpTarget(
      { host: input.host, port: input.port, secure: input.secure, user, password: input.password ?? kept, from: input.from },
      call.storeId,
    );
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
  description:
    "Envia um e-mail de teste pela conexão SMTP da loja. Pelo painel vai para o endereço informado (to); pelo agente (MCP) vai sempre para o e-mail de avisos da loja, e o to é ignorado.",
  input: z.object({ to: EMAIL.optional() }),
  permission: "connections.write",
  // O envio (rede) acontece aqui, fora da transação; o destino segue para `run`, que só registra o resultado.
  async prepare(call, input) {
    await limitConnectionTest(call.actor, "testSmtp", call.storeId);
    const to = await testRecipient(call, input.to);
    const { smtp, storeName } = await withStore(call.storeId, async (tx) => {
      const [s] = await tx.select({ name: store.name }).from(store).where(eq(store.id, call.storeId));
      return { smtp: await loadSmtp(tx, call.storeId), storeName: s?.name ?? "" };
    });
    if (!smtp) throw new ActionError("provider_error", NOT_CONFIGURED);
    const pinned = await pinSmtpTarget(smtp, call.storeId);
    try {
      await deliver(pinned, storeName, {
        to,
        subject: `E-mail de teste da ${storeName || "sua loja"}`,
        text: "Este é um e-mail de teste. Se chegou, as entregas da sua loja vão sair por este SMTP.",
        html: "<p>Este é um e-mail de teste. Se chegou, as entregas da sua loja vão sair por este SMTP.</p>",
      });
    } catch (e) {
      throw new ActionError("provider_error", smtpProblem(e, smtp));
    }
    return { to };
  },
  async run(ctx, _input, { to }) {
    await logEmail(ctx.tx, { storeId: ctx.storeId, to, kind: "test", status: "sent", provider: "smtp" });
    return { sent: true };
  },
});
