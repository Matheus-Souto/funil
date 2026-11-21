// Varredura `recovery_scan` (job global, a cada 5 min, agendada junto do `expire_orders`): loja a loja, com a recuperação
// ligada, escolhe os candidatos dos três casos (contato do checkout, Pix não pago, cartão recusado) que venceram o prazo
// e nasceram há no máximo 6 h (contato e cartão só com a oferta ativa: o link leva ao checkout), aplica endereço simples,
// supressão, dedupe por caixa, "já comprou", tetos e a proteção do cartão, grava `recovery_email` e enfileira
// `recovery_send` na mesma transação.
//
// - Endereço não simples (`simpleAddress`): `skipped endereco_invalido`. O limite por endereço (24 h e 30 dias) conta
//   pela caixa (`mailbox_hash`: sem `+sufixo` e, no Gmail, sem pontos) e o descadastro casa o hash exato ou o da caixa;
//   "já comprou" segue pelo e-mail exato.
// - Uma transação por loja, com lock consultivo por loja: duas varreduras ao mesmo tempo não escolhem o mesmo candidato
//   (e os únicos de `recovery_email` seguram o resto). Todo id gravado (contato, pedido, oferta) vem de consulta feita
//   dentro de `withStore(storeId)`: as FKs de `recovery_email` são simples (sem a loja).
// - Pulado com linha (`skipped` + `skip_reason`): o candidato não volta (o único impede). Pulado sem linha (teto da hora
//   da loja ou do caso cartão): nada é gravado e o candidato volta na próxima varredura, se ainda estiver na janela.
// - O token de descadastro em claro vai SÓ no payload do `recovery_send`; a linha guarda o sha256 dele. Log só com
//   `recoveryId`, `storeId`, `kind` e motivo: nunca e-mail, hash do e-mail nem token.
// - Falha numa loja: log (loja e erro saneado) e segue para as outras; o job não falha (a próxima passada vem em 5 min).
import { and, asc, count, eq, gt, gte, inArray, isNotNull, lte, notExists, sql } from "drizzle-orm";
import { UNKNOWN_IP } from "@/lib/client-ip";
import { randomToken, sha256 } from "@/lib/crypto";
import { db, withStore, type Tx } from "@/lib/db/client";
import { cardAttempt, checkoutLead, customer, offer, orders, recoveryEmail, store } from "@/lib/db/schema";
import { enqueue, type JobHandler } from "@/lib/jobs";
import { errorFields, log } from "@/lib/log";
import { cardBreakerKey, cardDeclineIpKey } from "@/lib/payments/card-keys";
import { countRecentEvents, hadRecentEvent, ipRateKey } from "@/lib/payments/ratelimit";
import { alreadyBought, hasNewerOrder, optedOut } from "./checks";
import { RECOVERY, mailboxHash, recoveryEmailHash, simpleAddress } from "./rules";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Lembrete que conta para dedupe e tetos (o pulado e o que falhou não contam). */
const LIVE = ["queued", "sending", "sent"];

export type RecoveryKind = "lead" | "pix" | "card";
export type RecoverySkipReason = "endereco_invalido" | "optout" | "endereco_24h" | "endereco_30d" | "ja_comprou" | "pedido_mais_novo" | "cartao_suspeito";

interface Candidate {
  kind: RecoveryKind;
  leadId: string | null;
  orderId: string | null;
  offerId: string;
  email: string;
  /** Momento previsto do caso: contato criado + 60 min; Pix criado + 30 min; 1ª recusa do cartão + 30 min. */
  dueAt: Date;
  /** Só pix e cartão. */
  order?: { customerId: string; createdAt: Date; clientIp: string; declines: number; firstDecline?: Date };
}

interface StoreFlags {
  id: string;
  lead: boolean;
  pix: boolean;
  card: boolean;
  capture: boolean;
}

const minus = (t: Date, ms: number) => new Date(t.getTime() - ms);
const iso = (d: Date) => d.toISOString();

/** Candidatos dos casos ligados, mais antigos (pelo momento previsto) primeiro. */
async function candidates(tx: Tx, f: StoreFlags, t: Date): Promise<Candidate[]> {
  const since = minus(t, RECOVERY.lookbackHours * HOUR_MS);
  const out: Candidate[] = [];

  // Caso 1 só roda com a captura de contato ligada.
  if (f.lead && f.capture) {
    const leads = await tx
      .select({ id: checkoutLead.id, offerId: checkoutLead.offerId, email: checkoutLead.email, createdAt: checkoutLead.createdAt })
      .from(checkoutLead)
      // O link do lembrete leva ao checkout da oferta: oferta desativada não vende.
      .innerJoin(offer, and(eq(offer.id, checkoutLead.offerId), eq(offer.active, true)))
      .where(
        and(
          eq(checkoutLead.status, "open"),
          isNotNull(checkoutLead.email),
          gt(checkoutLead.expiresAt, t),
          gte(checkoutLead.createdAt, since),
          lte(checkoutLead.createdAt, minus(t, RECOVERY.leadAfterMin * MIN_MS)),
          notExists(tx.select({ id: recoveryEmail.id }).from(recoveryEmail).where(eq(recoveryEmail.leadId, checkoutLead.id))),
        ),
      );
    for (const l of leads) {
      out.push({
        kind: "lead",
        leadId: l.id,
        orderId: null,
        offerId: l.offerId,
        email: l.email!,
        dueAt: new Date(l.createdAt.getTime() + RECOVERY.leadAfterMin * MIN_MS),
      });
    }
  }

  if (f.pix) {
    const pix = await tx
      .select({
        id: orders.id,
        offerId: orders.offerId,
        customerId: orders.customerId,
        createdAt: orders.createdAt,
        clientIp: orders.clientIp,
        email: customer.email,
      })
      .from(orders)
      .innerJoin(customer, eq(customer.id, orders.customerId))
      .where(
        and(
          eq(orders.status, "pending"),
          inArray(orders.method, ["pix_asaas", "pix_manual"]),
          gte(orders.createdAt, since),
          lte(orders.createdAt, minus(t, RECOVERY.pixAfterMin * MIN_MS)),
          gt(orders.expiresAt, new Date(t.getTime() + RECOVERY.pixMinLeftMin * MIN_MS)),
          notExists(
            tx
              .select({ id: recoveryEmail.id })
              .from(recoveryEmail)
              .where(and(eq(recoveryEmail.orderId, orders.id), eq(recoveryEmail.kind, "pix"))),
          ),
        ),
      );
    for (const o of pix) {
      out.push({
        kind: "pix",
        leadId: null,
        orderId: o.id,
        offerId: o.offerId,
        email: o.email,
        dueAt: new Date(o.createdAt.getTime() + RECOVERY.pixAfterMin * MIN_MS),
        order: { customerId: o.customerId, createdAt: o.createdAt, clientIp: o.clientIp, declines: 0 },
      });
    }
  }

  if (f.card) {
    // A 1ª recusa do pedido (o pedido segue `pending` depois da recusa; ver o plano).
    const firstDecline = sql<Date>`min(${cardAttempt.resolvedAt})`.mapWith(cardAttempt.resolvedAt);
    const card = await tx
      .select({
        id: orders.id,
        offerId: orders.offerId,
        customerId: orders.customerId,
        createdAt: orders.createdAt,
        clientIp: orders.clientIp,
        email: customer.email,
        firstDecline,
        declines: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(orders)
      .innerJoin(customer, eq(customer.id, orders.customerId))
      .innerJoin(cardAttempt, and(eq(cardAttempt.orderId, orders.id), eq(cardAttempt.status, "declined")))
      .innerJoin(offer, and(eq(offer.id, orders.offerId), eq(offer.active, true)))
      .where(
        and(
          eq(orders.status, "pending"),
          eq(orders.method, "card_asaas"),
          // Pedido recusado fica `pending` para sempre: sem este limite a consulta cresce sem fim (o de 6 h está só no
          // HAVING da 1ª recusa). O ticket do cartão vale 30 min e a 1ª recusa vem logo depois da criação: 24 h de folga.
          gte(orders.createdAt, minus(since, DAY_MS)),
          notExists(
            tx
              .select({ id: recoveryEmail.id })
              .from(recoveryEmail)
              .where(and(eq(recoveryEmail.orderId, orders.id), eq(recoveryEmail.kind, "card"))),
          ),
        ),
      )
      .groupBy(orders.id, customer.id)
      .having(
        sql`${firstDecline} >= ${iso(since)}::timestamptz and ${firstDecline} <= ${iso(minus(t, RECOVERY.cardAfterMin * MIN_MS))}::timestamptz`,
      );
    for (const o of card) {
      out.push({
        kind: "card",
        leadId: null,
        orderId: o.id,
        offerId: o.offerId,
        email: o.email,
        dueAt: new Date(o.firstDecline.getTime() + RECOVERY.cardAfterMin * MIN_MS),
        order: { customerId: o.customerId, createdAt: o.createdAt, clientIp: o.clientIp, declines: o.declines, firstDecline: o.firstDecline },
      });
    }
  }

  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/** Lembretes da loja (`queued|sending|sent`) criados desde `since`; só do caso cartão com `cardOnly`. */
async function liveSince(tx: Tx, storeId: string, since: Date, cardOnly = false): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(recoveryEmail)
    .where(
      and(
        eq(recoveryEmail.storeId, storeId),
        inArray(recoveryEmail.status, LIVE),
        gt(recoveryEmail.createdAt, since),
        cardOnly ? eq(recoveryEmail.kind, "card") : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Pedido de cartão com sinal de teste de cartão: muitas recusas no pedido, disjuntor da loja, IP com muitas recusas ou
 * desconhecido. A janela do disjuntor e das recusas do IP é ancorada na 1ª recusa do pedido (de 2 h antes dela até a
 * varredura), não só nas 2 h antes da varredura: um candidato avaliado horas depois (worker parado) não perde a
 * evidência de perto da recusa. A 1ª recusa tem no máximo 6 h; a limpeza do `rate_limit` guarda 24 h.
 */
async function cardSuspicious(storeId: string, o: NonNullable<Candidate["order"]>, t: Date): Promise<boolean> {
  if (o.declines > RECOVERY.cardMaxDeclines) return true;
  if (o.clientIp === UNKNOWN_IP) return true;
  const anchor = o.firstDecline ?? t;
  const windowSec = Math.max(0, (t.getTime() - anchor.getTime()) / 1000) + RECOVERY.cardSuspicionWindowHours * 3600;
  if (await hadRecentEvent(cardBreakerKey(storeId), windowSec, t)) return true;
  return (await countRecentEvents(cardDeclineIpKey(ipRateKey(o.clientIp)), windowSec, t)) > RECOVERY.cardIpDeclinesMax;
}

/** Motivo para pular com linha (o candidato não volta), ou `null` se o lembrete pode sair. */
async function skipReason(tx: Tx, storeId: string, c: Candidate, hash: string, mailbox: string, t: Date): Promise<RecoverySkipReason | null> {
  if (simpleAddress(c.email) === null) return "endereco_invalido";
  if (await optedOut(tx, storeId, hash, mailbox)) return "optout";
  if (await alreadyBought(tx, c.offerId, c.email, t)) return "ja_comprou";
  if (c.order && (await hasNewerOrder(tx, { id: c.orderId!, customerId: c.order.customerId, offerId: c.offerId, createdAt: c.order.createdAt }))) {
    return "pedido_mais_novo";
  }

  if (c.kind === "card" && (await cardSuspicious(storeId, c.order!, t))) return "cartao_suspeito";

  const sameAddress = (since: Date) =>
    and(
      eq(recoveryEmail.storeId, storeId),
      eq(recoveryEmail.mailboxHash, mailbox),
      inArray(recoveryEmail.status, LIVE),
      gt(recoveryEmail.createdAt, since),
    );
  const [recent] = await tx
    .select({ id: recoveryEmail.id })
    .from(recoveryEmail)
    .where(sameAddress(minus(t, RECOVERY.addressGapHours * HOUR_MS)))
    .limit(1);
  if (recent) return "endereco_24h";
  const [month] = await tx
    .select({ n: count() })
    .from(recoveryEmail)
    .where(sameAddress(minus(t, 30 * DAY_MS)));
  if (Number(month?.n ?? 0) >= RECOVERY.addressMaxPer30d) return "endereco_30d";
  return null;
}

/** Varre uma loja numa transação (com o lock consultivo da loja). */
async function scanStoreTx(tx: Tx, f: StoreFlags, t: Date): Promise<void> {
  const storeId = f.id;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`recovery:${storeId}`}))`);
  const list = await candidates(tx, f, t);
  if (list.length === 0) return;

  const hourAgo = minus(t, HOUR_MS);
  let storeCount = await liveSince(tx, storeId, hourAgo);
  let cardCount = await liveSince(tx, storeId, hourAgo, true);
  let deferred = 0;

  for (const c of list) {
    // Primeiro os motivos de pulo (com linha, definitivo, avaliado com a evidência fresca); a linha `skipped` não gasta
    // teto. Só depois os tetos: um candidato suspeito nunca fica adiado esperando a evidência sair da janela.
    const hash = recoveryEmailHash(c.email);
    const mailbox = mailboxHash(c.email);
    const reason = await skipReason(tx, storeId, c, hash, mailbox, t);
    // Pula sem linha: teto da hora da loja ou do caso cartão (volta na próxima varredura).
    if (reason === null && (storeCount >= RECOVERY.storePerHour || (c.kind === "card" && cardCount >= RECOVERY.cardPerHour))) {
      deferred++;
      continue;
    }
    const token = reason === null ? randomToken(32) : null;
    const [created] = await tx
      .insert(recoveryEmail)
      .values({
        storeId,
        kind: c.kind,
        leadId: c.leadId,
        orderId: c.orderId,
        offerId: c.offerId,
        emailHash: hash,
        mailboxHash: mailbox,
        status: reason === null ? "queued" : "skipped",
        skipReason: reason,
        // Pulado: um hash qualquer (a coluna é obrigatória e única); nenhum link de descadastro sai para ele.
        unsubHash: sha256(token ?? randomToken(32)),
        dueAt: c.dueAt,
        createdAt: t,
        expiresAt: new Date(t.getTime() + RECOVERY.retentionDays * DAY_MS),
      })
      .onConflictDoNothing()
      .returning({ id: recoveryEmail.id });
    // Outro lembrete do mesmo contato ou pedido e caso já existe (o único segura): nada a fazer.
    if (!created) continue;
    if (token === null) {
      log.info("recuperação: lembrete pulado", { recoveryId: created.id, storeId, kind: c.kind, reason });
      continue;
    }
    await enqueue(tx, { storeId, type: "recovery_send", payload: { recoveryId: created.id, unsubToken: token } });
    storeCount++;
    if (c.kind === "card") cardCount++;
    log.info("recuperação: lembrete enfileirado", { recoveryId: created.id, storeId, kind: c.kind });
  }
  if (deferred > 0) log.info("recuperação: teto da hora atingido; o restante fica para a próxima varredura", { storeId, deferred });
}

const storeFlagColumns = { id: store.id, lead: store.recoveryLead, pix: store.recoveryPix, card: store.recoveryCard, capture: store.leadCapture };

/**
 * Varre UMA loja (a tabela `store` não tem RLS): lê as chaves da loja e roda a transação com o lock consultivo. Loja
 * inexistente ou com a recuperação desligada não faz nada. Falha propaga (o laço do handler loga e segue). Relógio
 * injetável, como no handler. Os testes que só olham uma loja usam esta função em vez de varrer todas as lojas do banco.
 */
export async function scanStore(storeId: string, now: Date | (() => Date) = () => new Date()): Promise<void> {
  const t = typeof now === "function" ? now() : now;
  const [f] = await db
    .select(storeFlagColumns)
    .from(store)
    .where(and(eq(store.id, storeId), eq(store.recoveryOn, true)));
  if (!f) return;
  await withStore(f.id, (tx) => scanStoreTx(tx, f, t));
}

/**
 * Handler do `recovery_scan`. Relógio injetável (testes). Falha numa loja não impede as demais e NÃO faz o job falhar:
 * relançar devolveria o job ao backoff da fila (60 s a 12 h) e, enquanto ele espera, o agendamento não cria outro,
 * travando a varredura de todas as lojas. A falha vai ao log (só a loja e a identificação saneada do erro) e a próxima
 * passada vem em 5 min. `beforeStore` existe só para testes.
 */
export function createRecoveryScanHandler(now: () => Date = () => new Date(), beforeStore?: (storeId: string) => Promise<void>): JobHandler {
  return async (_j, signal) => {
    const t = now();
    // A tabela `store` não tem RLS.
    const stores = await db
      .select({ id: store.id })
      .from(store)
      .where(eq(store.recoveryOn, true))
      .orderBy(asc(store.id));
    for (const f of stores) {
      if (signal.aborted) break;
      try {
        await beforeStore?.(f.id);
        await scanStore(f.id, t);
      } catch (e) {
        log.error("falha na varredura da recuperação da loja", { storeId: f.id, ...errorFields(e) });
      }
    }
  };
}

export const recoveryScanJob: JobHandler = createRecoveryScanHandler();
