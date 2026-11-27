// Sessão de pagamento de um app (`POST /api/integracao/v1/pagamentos`, §7.4 do design de cobrança de apps): o servidor
// do app cria a sessão quando a pessoa clica em pagar e redireciona para `/c/<oferta>?s=<id>`. A sessão guarda a conta,
// o nome, o e-mail (e o telefone) do comprador e a origem; a URL leva só o id aleatório (nada de dado pessoal).
//
// - Vale 60 min (`SESSION_TTL_MS`) e é de uso único por pedido PAGO: pedido pago (mesmo se depois reembolsado ou
//   contestado) torna a sessão inválida; Pix pendente e depois cartão na mesma sessão é permitido (dois pedidos, a
//   sessão aponta para o último). A trava é no código (`loadCheckoutSession` com `FOR UPDATE` no `checkout.start`); não
//   há índice único de pedido pago por sessão: ele faria o webhook do Asaas falhar ao confirmar um pagamento real.
// - Nova tentativa do app (mesma conta, oferta, comprador e retorno em até 2 min, sem pedido ainda) devolve a mesma
//   sessão: um clique repetido não vira dois links.
// - `retorno` só em https no host da loja ou num host de `config.returnHosts` da integração `app_webhook`.
// - Retenção (no job `sweep_app_trials`, src/lib/apps/trials.ts): sessão sem pedido é apagada 7 dias depois de vencer;
//   sessão com pedido fica (o pedido aponta para ela), mas perde nome, e-mail e telefone depois de vencer, porque o
//   pedido já guarda os dele (`orders.buyer_name`, `buyer_phone` e o e-mail no cliente).
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { sha256 } from "@/lib/crypto";
import { appCheckoutSession, appTrial, offer, orders, store } from "@/lib/db/schema";
import { offerSlugSchema } from "@/lib/catalog/offers";
import { storeBaseUrl } from "@/lib/delivery/links";
import { recoveryEmailHash } from "@/lib/recovery/rules";
import { fbcFromFbclid, type Touch, type TouchRecord } from "@/lib/tracking/touch";
import { normalizeBrMobile, validEmail } from "@/lib/validation/br";
import { readAppWebhookConfig } from "./config";
import { SESSION_RETENTION_DAYS, accountSchema, appOriginSchema, originTouch } from "./trials";

export { SESSION_RETENTION_DAYS };

/** Validade da sessão (§7.4). */
export const SESSION_TTL_MS = 60 * 60_000;
/** Janela em que uma chamada igual do app devolve a mesma sessão (nova tentativa de rede, clique repetido). */
export const SESSION_RETRY_WINDOW_MS = 2 * 60_000;

export const APP_OFFER_NOT_FOUND_MESSAGE = "Oferta de app não encontrada";
export const SESSION_INVALID_MESSAGE = "Este link de pagamento venceu. Volte ao app e tente de novo.";
export const RETURN_URL_MESSAGE = "Use um endereço https no domínio da loja ou do app";

/** Sessão vencida, já paga, de outra oferta ou de outra loja: o app decide pelo `code` (o checkout mostra a mensagem). */
export const sessionInvalid = () => new ActionError("conflict", SESSION_INVALID_MESSAGE, { code: "SESSION_INVALID" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CheckoutSession {
  id: string;
  offerId: string;
  account: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  touch: TouchRecord | null;
  ref: string | null;
  fbc: string | null;
  fbp: string | null;
  returnUrl: string | null;
  expiresAt: Date;
}

/** Por que a sessão não serve mais: `paid` (algum pedido dela foi pago, mesmo se depois reembolsado ou contestado) ou `expired` (venceu, ou não existe nesta loja). */
export type SessionClosed = "paid" | "expired";

/**
 * Estado da sessão de pagamento: utilizável (`session`) ou encerrada (`closed`). Da loja (RLS e filtro); pedido pago
 * tem prioridade sobre o vencimento. `lock`: `FOR UPDATE` na linha, para o `checkout.start` serializar pedidos da mesma
 * sessão e reler o pedido pago depois de pegar o lock. Id malformado ou de outra loja → `expired`.
 */
export async function checkoutSessionState(
  tx: Ctx["tx"],
  storeId: string,
  sessionId: string,
  opts: { now?: Date; lock?: boolean } = {},
): Promise<{ session: CheckoutSession; closed: null } | { session: null; closed: SessionClosed }> {
  if (!UUID_RE.test(sessionId)) return { session: null, closed: "expired" };
  const q = tx
    .select()
    .from(appCheckoutSession)
    .where(and(eq(appCheckoutSession.storeId, storeId), eq(appCheckoutSession.id, sessionId)));
  const [row] = opts.lock ? await q.for("update") : await q;
  if (!row) return { session: null, closed: "expired" };
  const [paid] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), eq(orders.appSessionId, row.id), isNotNull(orders.paidAt)))
    .limit(1);
  if (paid) return { session: null, closed: "paid" };
  if (row.expiresAt.getTime() <= (opts.now ?? new Date()).getTime()) return { session: null, closed: "expired" };
  return {
    closed: null,
    session: {
      id: row.id,
      offerId: row.offerId,
      account: row.account,
      buyerName: row.buyerName,
      buyerEmail: row.buyerEmail,
      buyerPhone: row.buyerPhone,
      touch: (row.touch as TouchRecord | null) ?? null,
      ref: row.ref,
      fbc: row.fbc,
      fbp: row.fbp,
      returnUrl: row.returnUrl,
      expiresAt: row.expiresAt,
    },
  };
}

/** Sessão de pagamento utilizável (ver `checkoutSessionState`), ou `null` se vencida, já paga, de outra loja ou malformada. */
export async function loadCheckoutSession(
  tx: Ctx["tx"],
  storeId: string,
  sessionId: string,
  opts: { now?: Date; lock?: boolean } = {},
): Promise<CheckoutSession | null> {
  return (await checkoutSessionState(tx, storeId, sessionId, opts)).session;
}

/**
 * Origem do pedido feito pela sessão: a da sessão, se o app mandou alguma; senão a do teste da conta (`app_trial`).
 * Nunca a da URL do checkout (o navegador pode trocar).
 */
export async function sessionOrigin(
  tx: Ctx["tx"],
  storeId: string,
  s: CheckoutSession,
): Promise<{ touch: Touch; ref?: string; fbc?: string; fbp?: string }> {
  const opt = (v: string | null) => v ?? undefined;
  if (s.touch || s.ref || s.fbc || s.fbp) return { touch: { first: s.touch, last: s.touch }, ref: opt(s.ref), fbc: opt(s.fbc), fbp: opt(s.fbp) };
  const [trial] = await tx
    .select({ firstTouch: appTrial.firstTouch, ref: appTrial.ref, fbc: appTrial.fbc, fbp: appTrial.fbp })
    .from(appTrial)
    .where(and(eq(appTrial.storeId, storeId), eq(appTrial.account, s.account)));
  if (!trial) return { touch: { first: null, last: null } };
  const t = (trial.firstTouch as TouchRecord | null) ?? null;
  return { touch: { first: t, last: t }, ref: opt(trial.ref), fbc: opt(trial.fbc), fbp: opt(trial.fbp) };
}

// ---------------------------------------------------------------------------------------------------------------
// apps.createPayment

const returnUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, RETURN_URL_MESSAGE)
  // Gravada normalizada (host em minúsculas), como o navegador vai abrir.
  .transform((v) => new URL(v).href);

const createInput = z.object({
  conta: accountSchema,
  /**
   * Slug da oferta de app no funil (ex.: `start-anual`), no formato do catálogo: assim a auditoria só grava um slug
   * (um valor fora do formato, como um e-mail, é recusado antes e não chega ao `auditInput`).
   */
  oferta: offerSlugSchema,
  email: z.string().trim().toLowerCase().max(254).refine(validEmail, "Confira o e-mail"),
  nome: z.string().trim().min(2, "Nome curto demais").max(120, "Nome longo demais"),
  telefone: z
    .string()
    .max(30)
    .optional()
    .transform((p, ctx) => {
      if (!p?.trim()) return undefined;
      const n = normalizeBrMobile(p);
      if (n === null) {
        ctx.addIssue({ code: "custom", message: "Celular com DDD, ex.: 11987654321" });
        return z.NEVER;
      }
      return n;
    }),
  origem: appOriginSchema.optional(),
  retorno: returnUrl.optional(),
});

/** Hosts aceitos no `retorno`: o da loja e os `returnHosts` da conexão do app (`app_webhook`, configurada no painel). */
async function allowedReturnHosts(ctx: Ctx, storeHost: string): Promise<Set<string>> {
  const hosts = new Set([storeHost.toLowerCase()]);
  for (const h of (await readAppWebhookConfig(ctx.tx, ctx.storeId))?.returnHosts ?? []) hosts.add(h);
  return hosts;
}

/** Toques iguais campo a campo (o jsonb do banco não guarda a ordem das chaves). */
function sameTouch(a: TouchRecord | null, b: TouchRecord | null): boolean {
  if (a === null || b === null) return a === b;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * `fbc` gravado bate com a origem nova: o enviado pelo app é comparado direto; sem ele, o derivado do `fbclid` leva a
 * hora da criação, então compara o resto (o `fbclid` normalizado como na gravação, que corta em 400 caracteres).
 */
function sameFbc(stored: string | null, og: z.infer<typeof appOriginSchema> | undefined): boolean {
  if (og?.fbc) return stored === og.fbc;
  if (og?.fbclid) {
    // A mesma normalização da gravação (`fbcFromFbclid`: limpa e corta o `fbclid`); só a hora difere entre as chamadas.
    const derived = fbcFromFbclid(og.fbclid, 0);
    if (!derived || stored === null) return stored === null && !derived;
    const id = derived.slice("fb.1.0.".length);
    return /^fb\.1\.\d+\./.test(stored) && stored.slice(stored.indexOf(".", "fb.1.".length) + 1) === id;
  }
  return stored === null;
}

type CreateOutput = { url: string; expira_em: string; criado: boolean };

export const createPayment = defineAction({
  name: "apps.createPayment",
  description: "Cria a sessão de pagamento de uma conta do app numa oferta de app e devolve a URL do checkout (sem dado pessoal).",
  input: createInput,
  permission: "integration.use",
  // Nunca a conta, o e-mail, o nome, o telefone, o retorno nem o id da sessão (é o segredo da URL).
  auditInput: (i) => ({ oferta: i.oferta, conta_hash: sha256(i.conta), emailHash: recoveryEmailHash(i.email) }),
  async run(ctx, input): Promise<CreateOutput> {
    const [o] = await ctx.tx
      .select({ id: offer.id, slug: offer.slug })
      .from(offer)
      .where(and(eq(offer.slug, input.oferta), eq(offer.active, true), eq(offer.delivery, "app")));
    if (!o) throw new ActionError("not_found", APP_OFFER_NOT_FOUND_MESSAGE);
    // A tabela `store` não tem RLS: filtra pela loja do ator.
    const [st] = await ctx.tx.select({ slug: store.slug, domain: store.domain }).from(store).where(eq(store.id, ctx.storeId));
    const base = storeBaseUrl({ slug: st!.slug, domain: st!.domain });
    if (input.retorno !== undefined) {
      const hosts = await allowedReturnHosts(ctx, new URL(base).host);
      if (!hosts.has(new URL(input.retorno).host.toLowerCase())) {
        throw new ActionError("invalid_input", RETURN_URL_MESSAGE, [{ path: ["retorno"], message: RETURN_URL_MESSAGE }]);
      }
    }
    const urlOf = (id: string) => `${base}/c/${encodeURIComponent(o.slug)}?s=${id}`;
    const phone = input.telefone ?? null;
    const retorno = input.retorno ?? null;

    // Chamadas simultâneas da mesma conta e oferta esperam aqui (até o commit): a segunda enxerga a sessão da primeira.
    await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`app_session:${ctx.storeId}:${input.conta}:${o.id}`}, 0))`);
    const now = new Date();
    const og = input.origem;
    const touch = originTouch(og);
    const candidates = await ctx.tx
      .select({
        id: appCheckoutSession.id,
        expiresAt: appCheckoutSession.expiresAt,
        touch: appCheckoutSession.touch,
        ref: appCheckoutSession.ref,
        fbc: appCheckoutSession.fbc,
        fbp: appCheckoutSession.fbp,
      })
      .from(appCheckoutSession)
      .where(
        and(
          eq(appCheckoutSession.storeId, ctx.storeId),
          eq(appCheckoutSession.account, input.conta),
          eq(appCheckoutSession.offerId, o.id),
          isNull(appCheckoutSession.orderId),
          gt(appCheckoutSession.createdAt, new Date(now.getTime() - SESSION_RETRY_WINDOW_MS)),
          eq(appCheckoutSession.buyerEmail, input.email),
          eq(appCheckoutSession.buyerName, input.nome),
          sql`${appCheckoutSession.buyerPhone} is not distinct from ${phone}`,
          sql`${appCheckoutSession.returnUrl} is not distinct from ${retorno}`,
        ),
      )
      .orderBy(desc(appCheckoutSession.createdAt));
    // A mesma origem também (normalizada como é gravada): outra campanha ou outro clique é outra sessão.
    const recent = candidates.find(
      (c) =>
        sameTouch(c.touch as TouchRecord | null, touch) &&
        c.ref === (og?.ref ?? null) &&
        c.fbp === (og?.fbp ?? null) &&
        sameFbc(c.fbc, og),
    );
    if (recent) return { url: urlOf(recent.id), expira_em: recent.expiresAt.toISOString(), criado: false };

    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await ctx.tx.insert(appCheckoutSession).values({
      id,
      storeId: ctx.storeId,
      offerId: o.id,
      account: input.conta,
      buyerName: input.nome,
      buyerEmail: input.email,
      buyerPhone: phone,
      touch,
      ref: og?.ref ?? null,
      fbc: og?.fbc ?? fbcFromFbclid(og?.fbclid, now.getTime()) ?? null,
      fbp: og?.fbp ?? null,
      returnUrl: retorno,
      expiresAt,
    });
    return { url: urlOf(id), expira_em: expiresAt.toISOString(), criado: true };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// checkout.appSession (página /c/<slug>?s=<id>)

export const checkoutAppSession = defineAction({
  name: "checkout.appSession",
  description: "Dados travados da sessão de pagamento do app para a página do checkout (nome, e-mail e se já há telefone).",
  input: z.object({ slug: z.string().min(1).max(100), sessionId: z.uuid() }),
  permission: "public",
  // Anônima e repetida a cada carregamento: sem auditoria (o id da sessão é o segredo da URL).
  audit: false,
  async run(ctx, input, _prepared: undefined, server?: { now?: Date }): Promise<{ buyerName: string; buyerEmail: string; hasPhone: boolean }> {
    const [o] = await ctx.tx
      .select({ id: offer.id })
      .from(offer)
      .where(and(eq(offer.slug, input.slug), eq(offer.active, true), eq(offer.delivery, "app")));
    const s = o ? await loadCheckoutSession(ctx.tx, ctx.storeId, input.sessionId, { now: server?.now }) : null;
    if (!s || s.offerId !== o!.id) throw sessionInvalid();
    return { buyerName: s.buyerName, buyerEmail: s.buyerEmail, hasPhone: s.buyerPhone !== null };
  },
});
