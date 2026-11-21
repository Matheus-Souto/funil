// Descadastro dos lembretes de recuperação de venda: `/sair/<token>` (link do e-mail e cabeçalho `List-Unsubscribe`).
// A rota só faz o parse HTTP e chama `runAction` (padrão de `/d/[token]`, src/lib/delivery/download.ts).
// - GET (`recovery.unsubscribeView`): confere o link e mostra "Não quer mais receber lembretes da {loja}?" com o botão,
//   um formulário POST para a mesma URL. Não grava nada (nem o contador de limite): robôs que abrem links de e-mail só
//   fazem GET.
// - POST (`recovery.unsubscribe`): o botão da página ou o um clique do RFC 8058 (`List-Unsubscribe=One-Click`, postado
//   pelo servidor do provedor de e-mail, sem sessão nem Origin). Os dois descadastram; não há CSRF token: o próprio token
//   do link é a autorização. Grava `email_optout` (`unsubscribe`, on conflict do nothing) e apaga os contatos `open` ou
//   `contacted` da loja com o mesmo `email_hash` (o convertido em pedido fica). Idempotente.
// - O token em claro só existe no link; `recovery_email.unsub_hash` guarda o sha256. A linha é procurada SEMPRE na
//   transação da ação (RLS da loja do host): token de outra loja não é encontrado. Formato conferido antes da consulta.
//   Vencido (`expires_at <= now()`, ainda não varrido), de outra loja, inventado ou malformado: a mesma página neutra.
// - Limite: 30 POSTs por IP por hora na loja (todo POST conta, válido ou não, na transação da ação). Estourou: a mesma
//   página neutra e nada gravado. Sem proxy confiável o IP é desconhecido e o limite é pulado (como no resto do app).
// - Nunca mostra o e-mail nem o token; log só com `storeId` e o resultado (nunca token, hash nem e-mail). `audit: false`.
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction, type Ctx } from "@/lib/actions/core";
import { UNKNOWN_IP, clientIpFrom } from "@/lib/client-ip";
import { sha256 } from "@/lib/crypto";
import { checkoutLead, emailOptout, recoveryEmail, store } from "@/lib/db/schema";
import { STORE_PAGE_HEADERS, pageIcon, storeLookOf, storePageFrame, type StoreLook } from "@/lib/delivery/download";
import { esc } from "@/lib/delivery/templates";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { checkRateLimit, ipRateKey } from "@/lib/payments/ratelimit";
import { resolveStore as defaultResolveStore, type ResolvedStore } from "@/lib/stores";

export const UNSUB_LIMIT = { perIpPerHour: 30 } as const;
const HOUR = 3600;
/** `randomToken(32)` em base64url (43 caracteres); a folga só aceita o mesmo alfabeto (como no envio). */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const ipKey = (storeId: string, ip: string) => `recovery:unsub:ip:${storeId}:${ipRateKey(ip)}`;
const input = z.object({ token: z.string().max(200), clientIp: z.string().min(1).max(64) });

async function storeName(ctx: Ctx): Promise<string> {
  const [s] = await ctx.tx.select({ name: store.name }).from(store).where(eq(store.id, ctx.storeId));
  return s?.name ?? "";
}

/** `email_hash` do lembrete do token, na loja da transação (RLS), se o link ainda vale; malformado nem consulta. */
async function emailHashOf(ctx: Ctx, token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await ctx.tx
    .select({ emailHash: recoveryEmail.emailHash })
    .from(recoveryEmail)
    .where(and(eq(recoveryEmail.storeId, ctx.storeId), eq(recoveryEmail.unsubHash, sha256(token)), gt(recoveryEmail.expiresAt, sql`now()`)));
  return row?.emailHash ?? null;
}

/** GET: só confere o link (não grava nada). */
export const unsubscribeView = defineAction({
  name: "recovery.unsubscribeView",
  description: "Confere um link de descadastro dos lembretes de recuperação de venda, sem descadastrar (página com o botão).",
  input,
  permission: "public",
  audit: false,
  async run(ctx, { token }) {
    return { storeName: await storeName(ctx), valid: (await emailHashOf(ctx, token)) !== null };
  },
});

/** POST: descadastra o e-mail do link na loja. `server.now`: relógio (injetado nos testes). */
export const unsubscribe = defineAction<z.infer<typeof input>, { done: boolean; storeName: string }, undefined, { now?: Date }>({
  name: "recovery.unsubscribe",
  description: "Descadastra dos lembretes de recuperação de venda o e-mail de um link de descadastro (um clique).",
  input,
  permission: "public",
  audit: false,
  async run(ctx, { token, clientIp }, _prepared, server) {
    // Todo POST conta, válido ou não. Estourou: a transação desfaz tudo e a rota mostra a página neutra.
    if (clientIp !== UNKNOWN_IP && !(await checkRateLimit(ipKey(ctx.storeId, clientIp), UNSUB_LIMIT.perIpPerHour, HOUR, server?.now ?? new Date(), ctx.tx))) {
      throw new ActionError("rate_limited", "Muitas tentativas");
    }
    const name = await storeName(ctx);
    const emailHash = await emailHashOf(ctx, token);
    if (emailHash === null) return { done: false, storeName: name };
    await ctx.tx.insert(emailOptout).values({ storeId: ctx.storeId, emailHash, reason: "unsubscribe" }).onConflictDoNothing();
    await ctx.tx
      .delete(checkoutLead)
      .where(and(eq(checkoutLead.storeId, ctx.storeId), eq(checkoutLead.emailHash, emailHash), inArray(checkoutLead.status, ["open", "contacted"])));
    return { done: true, storeName: name };
  },
});

// ---- HTTP ------------------------------------------------------------------------------------------------------

const INVALID_TITLE = "Este link não vale mais.";

function askPage(storeName: string, look: StoreLook): string {
  const q = `Não quer mais receber lembretes da ${storeName}?`;
  return storePageFrame(
    q,
    look,
    `<div class="hero"><div class="icon" data-tone="warning">${pageIcon("mail-x", 30)}</div><h1>${esc(q)}</h1></div>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Não quero mais receber</button></form>`,
  );
}

function donePage(storeName: string, look: StoreLook): string {
  const text = `Pronto: a ${storeName} não vai mais mandar lembretes de compra para este e-mail.`;
  return storePageFrame(text, look, `<div class="hero"><div class="icon" data-tone="success">${pageIcon("circle-check", 30)}</div><h1>${esc(text)}</h1></div>`);
}

function invalidPage(look: StoreLook): string {
  return storePageFrame(
    INVALID_TITLE,
    look,
    `<div class="hero"><div class="icon" data-tone="warning">${pageIcon("link-off", 30)}</div><h1>${esc(INVALID_TITLE)}</h1><p>Se quiser, responda a um e-mail da loja.</p></div>`,
  );
}

function errorPage(look: StoreLook): string {
  const title = "Não foi possível concluir agora";
  return storePageFrame(
    title,
    look,
    `<div class="hero"><div class="icon" data-tone="danger">${pageIcon("info", 30)}</div><h1>${esc(title)}</h1><p>Tente de novo em alguns minutos.</p></div>`,
  );
}

export interface UnsubscribeHttpOptions {
  resolveStore?: (host: string) => Promise<ResolvedStore | null>;
  trustProxy?: number;
  /** Relógio do limite por IP (testes). */
  now?: () => Date;
}

const call = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });
const html = async (status: number, body: (look: StoreLook) => string, s: ResolvedStore | null) =>
  new Response(body(await storeLookOf(s)), { status, headers: STORE_PAGE_HEADERS });
const gone = (s: ResolvedStore | null) => html(410, invalidPage, s);

function failure(e: unknown, s: ResolvedStore, logResult: boolean): Promise<Response> {
  // Limite estourado (ou outra recusa da ação): a mesma página neutra do link inválido.
  if (e instanceof ActionError) {
    if (logResult) log.info("descadastro da recuperação", { storeId: s.id, result: e.code === "rate_limited" ? "limitado" : e.code });
    return gone(s);
  }
  log.error("falha inesperada no descadastro da recuperação", { storeId: s.id, error: e });
  return html(500, errorPage, s);
}

/** GET /sair/[token]: confere o link e mostra o botão (nada é gravado). */
export async function handleUnsubscribePage(req: Request, token: string, opts: UnsubscribeHttpOptions = {}): Promise<Response> {
  const s = await (opts.resolveStore ?? defaultResolveStore)(req.headers.get("host") ?? "");
  if (!s) return gone(null);
  const clientIp = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
  try {
    const v = await runAction(unsubscribeView, call(s.id), { token: token.slice(0, 200), clientIp });
    if (!v.valid) return gone(s);
    return html(200, (l) => askPage(v.storeName, l), s);
  } catch (e) {
    return failure(e, s, false);
  }
}

/** POST /sair/[token]: o botão da página ou o um clique (RFC 8058); os dois descadastram. O corpo não é lido. */
export async function handleUnsubscribePost(req: Request, token: string, opts: UnsubscribeHttpOptions = {}): Promise<Response> {
  const s = await (opts.resolveStore ?? defaultResolveStore)(req.headers.get("host") ?? "");
  if (!s) return gone(null);
  const clientIp = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
  try {
    const out = await runAction(unsubscribe, { ...call(s.id), server: { now: opts.now?.() } }, { token: token.slice(0, 200), clientIp });
    log.info("descadastro da recuperação", { storeId: s.id, result: out.done ? "descadastrado" : "link_invalido" });
    if (!out.done) return gone(s);
    return html(200, (l) => donePage(out.storeName, l), s);
  } catch (e) {
    return failure(e, s, true);
  }
}
