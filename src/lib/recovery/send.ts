// Envio `recovery_send` {recoveryId, unsubToken}: um lembrete de recuperação de venda pelo provedor de e-mail da loja.
//
// 1. Transação curta: reivindica a linha (`queued` -> `sending` com o id do job; o mesmo job pode reivindicar de novo
//    depois de cair no meio) e confere de novo o caso, porque a fila pode ter rodado bem depois da varredura: token de
//    descadastro, atraso (enfileirado há mais de 120 min: `atrasado`, em qualquer reivindicação, inclusive na nova
//    tentativa), chave geral e caso ligados, descadastro (hash exato ou da caixa), oferta ativa (contato e cartão),
//    contato ainda aberto ou pedido ainda pendente, endereço simples, o mesmo endereço da varredura, "já comprou" e
//    pedido mais novo (as mesmas consultas da varredura, em `checks.ts`). Não vale mais: `skipped` com o motivo. Lê
//    destinatário (o endereço simples normalizado, nunca o texto cru), loja, produto e valor.
// 2. Fora de transação: `sendMail` (chave de idempotência = id do lembrete).
// 3. Resultado: `sent`; `provider_error` definitivo (provedor não configurado, chave ou mensagem recusada) = `failed`
//    sem relançar; erro temporário (rede, tempo-limite, ou `provider_error` com status 0, 429 ou 5xx) volta a `queued`
//    e relança enquanto `now < max(due_at, created_at) + 120 min` (a fila tenta de novo), depois vira `failed`.
//
// Log só com `recoveryId`, `storeId`, `kind` e motivo: nunca e-mail, token nem URL. O erro relançado também não leva
// texto livre do provedor (pode ecoar o destinatário). `email_log` só pelo `logEmail` (sha256 do destinatário).
import { and, eq, or } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import { loadOfferProducts } from "@/lib/catalog/offer-products";
import { sha256 } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { cardAttempt, checkoutLead, customer, offer, orderItem, orders, product, recoveryEmail, store } from "@/lib/db/schema";
import { storeBaseUrl } from "@/lib/delivery/links";
import { logEmail, sendMail, type EmailProvider } from "@/lib/delivery/mailer";
import { recoveryEmail as recoveryTemplate, type RecoveryEmailData } from "@/lib/delivery/templates";
import type { JobHandler } from "@/lib/jobs";
import { errorFields, log } from "@/lib/log";
import { itemOrder } from "@/lib/orders/items";
import { WAS_PAID, alreadyBought, hasNewerOrder, optedOut } from "./checks";
import { RECOVERY, recoveryEmailHash, simpleAddress } from "./rules";
import type { RecoveryKind } from "./scan";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Token de descadastro: `randomToken(32)` em base64url (43 caracteres); a folga só aceita o mesmo alfabeto. */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const UTM = "utm_source=recuperacao&utm_medium=email&utm_campaign=";
const GRACE_MS = RECOVERY.sendGraceMin * 60_000;

export type RecoverySendSkipReason =
  | "atrasado"
  | "desligado"
  | "endereco_invalido"
  | "optout"
  | "email_mudou"
  | "contato_apagado"
  | "contato_encerrado"
  | "contato_vencido"
  | "pedido_apagado"
  | "pedido_encerrado"
  | "pago"
  | "pix_vencido"
  | "oferta_inativa"
  | "ja_comprou"
  | "pedido_mais_novo";

type Row = typeof recoveryEmail.$inferSelect;
type Mail = { to: string; kind: RecoveryKind; orderId: string | null; data: RecoveryEmailData };
type Prepared = { skip: RecoverySendSkipReason } | { invalidToken: true } | Mail | null;
/** O que o caso põe no e-mail: destinatário, produto, valor e, nos casos com pedido, o pedido. */
type Content = {
  to: string;
  productName: string;
  totalCents: number;
  order: { id: string; customerId: string; createdAt: Date; publicId: string; expiresAt: Date | null } | null;
};
type Checked = { skip: RecoverySendSkipReason } | Content;
type Offer = { name: string; slug: string; priceCents: number; active: boolean };

/** Destinatário e conteúdo do caso contato (valor = preço atual da oferta), ou o motivo para pular. */
async function leadMail(tx: Tx, r: Row, of: Offer, t: Date): Promise<Checked> {
  if (!r.leadId) return { skip: "contato_apagado" };
  const [l] = await tx
    .select({ status: checkoutLead.status, email: checkoutLead.email, expiresAt: checkoutLead.expiresAt })
    .from(checkoutLead)
    .where(eq(checkoutLead.id, r.leadId));
  if (!l) return { skip: "contato_apagado" };
  if (l.status !== "open" || !l.email) return { skip: "contato_encerrado" };
  if (l.expiresAt <= t) return { skip: "contato_vencido" };
  // Mesmo critério do aviso de pedido: 1 principal -> o produto; mais de 1 -> a oferta.
  const mains = (await loadOfferProducts(tx, [r.offerId])).get(r.offerId)?.main.filter((p) => p.deletedAt === null) ?? [];
  const productName = mains.length > 1 ? of.name : (mains[0]?.name ?? of.name);
  return { to: l.email, productName, totalCents: of.priceCents, order: null };
}

/** Destinatário e conteúdo dos casos Pix e cartão (valor = total do pedido), ou o motivo para pular. */
async function orderMail(tx: Tx, r: Row, of: Offer, t: Date): Promise<Checked> {
  const [o] = await tx
    .select({
      status: orders.status,
      customerId: orders.customerId,
      createdAt: orders.createdAt,
      publicId: orders.publicId,
      totalCents: orders.totalCents,
      expiresAt: orders.expiresAt,
      email: customer.email,
    })
    .from(orders)
    .innerJoin(customer, eq(customer.id, orders.customerId))
    .where(eq(orders.id, r.orderId!));
  if (!o) return { skip: "pedido_apagado" };
  if (o.status !== "pending") return { skip: WAS_PAID.includes(o.status) ? "pago" : "pedido_encerrado" };
  if (r.kind === "pix" && (!o.expiresAt || o.expiresAt <= t)) return { skip: "pix_vencido" };
  if (r.kind === "card") {
    const [approved] = await tx
      .select({ id: cardAttempt.id })
      .from(cardAttempt)
      .where(and(eq(cardAttempt.orderId, r.orderId!), eq(cardAttempt.status, "approved")))
      .limit(1);
    if (approved) return { skip: "pago" };
  }
  const items = await tx
    .select({ name: product.name, kind: orderItem.kind })
    .from(orderItem)
    .innerJoin(product, eq(product.id, orderItem.productId))
    .where(eq(orderItem.orderId, r.orderId!))
    .orderBy(...itemOrder);
  const mains = items.filter((i) => i.kind === "main");
  const productName = mains.length > 1 ? of.name : (mains[0]?.name ?? items[0]?.name ?? of.name);
  const order = { id: r.orderId!, customerId: o.customerId, createdAt: o.createdAt, publicId: o.publicId, expiresAt: o.expiresAt };
  return { to: o.email, productName, totalCents: o.totalCents, order };
}

/** Reivindica a linha e decide, com o estado atual, se o lembrete sai (transação curta, sem rede). */
async function prepare(tx: Tx, storeId: string, jobId: string, recoveryId: string, token: string, t: Date): Promise<Prepared> {
  const [r] = await tx
    .update(recoveryEmail)
    .set({ status: "sending", jobId })
    .where(
      and(
        eq(recoveryEmail.id, recoveryId),
        or(eq(recoveryEmail.status, "queued"), and(eq(recoveryEmail.status, "sending"), eq(recoveryEmail.jobId, jobId))),
      ),
    )
    .returning();
  if (!r) return null;
  if (!TOKEN.test(token) || sha256(token) !== r.unsubHash) return { invalidToken: true };
  // Parado na fila (worker fora do ar) mais que a folga: não sai atrasado, nem numa nova tentativa.
  if (t.getTime() > r.createdAt.getTime() + GRACE_MS) return { skip: "atrasado" };

  const kind = r.kind as RecoveryKind;
  const [s] = await tx
    .select({
      name: store.name,
      brandColor: store.brandColor,
      domain: store.domain,
      slug: store.slug,
      on: store.recoveryOn,
      lead: store.recoveryLead,
      pix: store.recoveryPix,
      card: store.recoveryCard,
      capture: store.leadCapture,
    })
    .from(store)
    .where(eq(store.id, storeId));
  if (!s?.on || !s[kind] || (kind === "lead" && !s.capture)) return { skip: "desligado" };

  if (await optedOut(tx, storeId, r.emailHash, r.mailboxHash)) return { skip: "optout" };

  const [of] = await tx
    .select({ name: offer.name, slug: offer.slug, priceCents: offer.priceCents, active: offer.active })
    .from(offer)
    .where(eq(offer.id, r.offerId));
  // Contato e cartão levam ao checkout da oferta, que não vende desativada. O Pix (`/o/`) funciona sem ela ativa.
  // Oferta apagada: a FK de `recovery_email` já apagou a linha (a reivindicação não a acha).
  if (!of || (kind !== "pix" && !of.active)) return { skip: "oferta_inativa" };
  const c = kind === "lead" ? await leadMail(tx, r, of, t) : await orderMail(tx, r, of, t);
  if ("skip" in c) return c;
  // Só endereço simples recebe; o `to` é o normalizado (comentário, vírgula ou `;` levariam a outra caixa).
  const to = simpleAddress(c.to);
  if (to === null) return { skip: "endereco_invalido" };
  // O endereço mudou desde a varredura (ex.: o contato trocou de e-mail na mesma chave): não manda para o novo.
  if (recoveryEmailHash(c.to) !== r.emailHash) return { skip: "email_mudou" };
  // Comprou por outro pedido ou outra sessão de checkout, ou abriu um pedido mais novo, depois da varredura.
  if (await alreadyBought(tx, r.offerId, c.to, t)) return { skip: "ja_comprou" };
  if (c.order && (await hasNewerOrder(tx, { ...c.order, offerId: r.offerId }))) return { skip: "pedido_mais_novo" };

  const base = storeBaseUrl({ domain: s.domain, slug: s.slug });
  // D10: nunca e-mail nem nome na URL.
  const actionUrl =
    kind === "pix"
      ? `${base}/o/${encodeURIComponent(c.order!.publicId)}`
      : `${base}/c/${encodeURIComponent(of.slug)}?${UTM}${kind === "lead" ? "contato" : "cartao"}`;
  return {
    to,
    kind,
    orderId: r.orderId,
    data: {
      storeName: s.name,
      brandColor: s.brandColor,
      productName: c.productName,
      totalCents: c.totalCents,
      actionUrl,
      unsubscribeUrl: `${base}/sair/${token}`,
      ...(kind === "pix" && c.order?.expiresAt ? { pixExpiresAt: c.order.expiresAt } : {}),
    },
  };
}

/** Muda o estado da linha que este job reivindicou (só se ainda estiver `sending` com ele). */
function settle(tx: Tx, recoveryId: string, jobId: string, set: Partial<typeof recoveryEmail.$inferInsert>) {
  return tx
    .update(recoveryEmail)
    .set(set)
    .where(and(eq(recoveryEmail.id, recoveryId), eq(recoveryEmail.status, "sending"), eq(recoveryEmail.jobId, jobId)));
}

/**
 * `provider_error` que não adianta tentar de novo: sem status (provedor não configurado, SMTP recusado na rede) ou com
 * status 4xx que não é 429 (chave ou mensagem recusada). Status 0 (rede), 429 e 5xx do Resend são temporários.
 */
function definitiveProviderError(e: unknown): boolean {
  if (!(e instanceof ActionError) || e.code !== "provider_error") return false;
  const status = (e.details as { status?: unknown } | undefined)?.status;
  return typeof status !== "number" || (status !== 0 && status !== 429 && status < 500);
}

/** Identificação do erro sem texto livre do provedor (nome e códigos). */
function safeError(e: unknown): string {
  const f = errorFields(e);
  return [f.errorName, f.errorCode, f.causeCode, f.status].filter((v) => v !== undefined).join(" ");
}

/** Handler do `recovery_send`. Relógio injetável (testes). */
export function createRecoverySendHandler(now: () => Date = () => new Date()): JobHandler {
  return async (j, signal) => {
    const p = (j.payload ?? {}) as { recoveryId?: unknown; unsubToken?: unknown };
    if (!j.storeId || typeof p.recoveryId !== "string" || !UUID.test(p.recoveryId)) {
      log.error("recovery_send com payload inválido; descartado", { id: j.id });
      return;
    }
    const storeId = j.storeId;
    const recoveryId = p.recoveryId;
    const token = typeof p.unsubToken === "string" ? p.unsubToken : "";

    const prep = await withStore(storeId, async (tx) => {
      const out = await prepare(tx, storeId, j.id, recoveryId, token, now());
      if (out && "invalidToken" in out) await settle(tx, recoveryId, j.id, { status: "failed" });
      else if (out && "skip" in out) await settle(tx, recoveryId, j.id, { status: "skipped", skipReason: out.skip });
      return out;
    });
    if (prep === null) {
      log.info("recuperação: lembrete já tratado; nada a enviar", { recoveryId, storeId });
      return;
    }
    if ("invalidToken" in prep) {
      log.error("recuperação: token de descadastro não confere; lembrete não enviado", { recoveryId, storeId });
      return;
    }
    if ("skip" in prep) {
      log.info("recuperação: lembrete pulado no envio", { recoveryId, storeId, reason: prep.skip });
      return;
    }

    const { to, kind, orderId } = prep;
    const logRow = { storeId, orderId, jobId: j.id, to, kind: "recovery" as const };
    let provider: EmailProvider | null = null;
    let sent: Awaited<ReturnType<typeof sendMail>>;
    try {
      sent = await sendMail(storeId, { to, ...recoveryTemplate(kind, prep.data) }, { signal, idempotencyKey: recoveryId, onProvider: (v) => (provider = v) });
    } catch (e) {
      const definitive = definitiveProviderError(e);
      // `provider_error` traz só mensagem nossa; o resto pode ecoar o destinatário (ex.: recusa do SMTP).
      const error = e instanceof ActionError && e.code === "provider_error" ? e : safeError(e);
      const t = now();
      const retry = await withStore(storeId, async (tx) => {
        await logEmail(tx, { ...logRow, status: "failed", error, provider });
        const [r] = await tx
          .select({ dueAt: recoveryEmail.dueAt, createdAt: recoveryEmail.createdAt })
          .from(recoveryEmail)
          .where(eq(recoveryEmail.id, recoveryId));
        // Desde o mais tardio entre o previsto e o enfileirado: candidato enfileirado tarde também tem a sua janela.
        const again = !definitive && r !== undefined && t.getTime() < Math.max(r.dueAt.getTime(), r.createdAt.getTime()) + GRACE_MS;
        await settle(tx, recoveryId, j.id, { status: again ? "queued" : "failed" });
        return again;
      });
      log.warn("recuperação: falha no envio do lembrete", { recoveryId, storeId, kind, retry, ...errorFields(e) });
      if (retry) throw new Error(`falha temporária no envio do lembrete (${safeError(e)})`);
      return;
    }
    await withStore(storeId, async (tx) => {
      await settle(tx, recoveryId, j.id, { status: "sent", sentAt: now() });
      await logEmail(tx, { ...logRow, status: "sent", provider: sent.provider, messageId: sent.messageId });
    });
    log.info("recuperação: lembrete enviado", { recoveryId, storeId, kind });
  };
}

export const recoverySendJob: JobHandler = createRecoverySendHandler();
