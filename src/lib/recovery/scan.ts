// Varredura `recovery_scan` (job global, a cada 5 min, agendada junto do `expire_orders`): loja a loja, com a recuperação
// ligada, escolhe os candidatos dos três casos (contato do checkout, Pix não pago, cartão recusado) que venceram o prazo
// e nasceram há no máximo 6 h, aplica supressão, dedupe por endereço, "já comprou", tetos e a proteção do cartão, grava
// `recovery_email` e enfileira `recovery_send` na mesma transação.
//
// - Uma transação por loja, com lock consultivo por loja: duas varreduras ao mesmo tempo não escolhem o mesmo candidato
//   (e os únicos de `recovery_email` seguram o resto). Todo id gravado (contato, pedido, oferta) vem de consulta feita
//   dentro de `withStore(storeId)`: as FKs de `recovery_email` são simples (sem a loja).
// - Pulado com linha (`skipped` + `skip_reason`): o candidato não volta (o único impede). Pulado sem linha (teto da hora
//   da loja ou do caso cartão): nada é gravado e o candidato volta na próxima varredura, se ainda estiver na janela.
// - O token de descadastro em claro vai SÓ no payload do `recovery_send`; a linha guarda o sha256 dele. Log só com
//   `recoveryId`, `storeId`, `kind` e motivo: nunca e-mail, hash do e-mail nem token.
import { and, asc, count, eq, gt, gte, inArray, isNotNull, lte, ne, notExists, sql } from "drizzle-orm";
import { UNKNOWN_IP } from "@/lib/client-ip";
import { randomToken, sha256 } from "@/lib/crypto";
import { db, withStore, type Tx } from "@/lib/db/client";
import { cardAttempt, checkoutLead, customer, emailOptout, orders, recoveryEmail, store } from "@/lib/db/schema";
import { enqueue, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { cardBreakerKey, cardDeclineIpKey } from "@/lib/payments/card-keys";
import { countRecentEvents, hadRecentEvent, ipRateKey } from "@/lib/payments/ratelimit";
import { RECOVERY, recoveryEmailHash } from "./rules";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Pedido que já foi pago em algum momento (pago, contestado ou reembolsado). */
const WAS_PAID = ["paid", "disputed", "refunded"];
/** Lembrete que conta para dedupe e tetos (o pulado e o que falhou não contam). */
const LIVE = ["queued", "sending", "sent"];

export type RecoveryKind = "lead" | "pix" | "card";
export type RecoverySkipReason = "optout" | "endereco_24h" | "endereco_30d" | "ja_comprou" | "pedido_mais_novo" | "cartao_suspeito";

interface Candidate {
  kind: RecoveryKind;
  leadId: string | null;
  orderId: string | null;
  offerId: string;
  email: string;
  /** Momento previsto do caso: contato criado + 60 min; Pix criado + 30 min; 1ª recusa do cartão + 30 min. */
  dueAt: Date;
  /** Só pix e cartão. */
  order?: { customerId: string; createdAt: Date; clientIp: string; declines: number };
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
      .where(
        and(
          eq(orders.status, "pending"),
          eq(orders.method, "card_asaas"),
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
        order: { customerId: o.customerId, createdAt: o.createdAt, clientIp: o.clientIp, declines: o.declines },
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

/** Pedido de cartão com sinal de teste de cartão: muitas recusas no pedido, disjuntor da loja, IP com muitas recusas ou desconhecido. */
async function cardSuspicious(storeId: string, o: NonNullable<Candidate["order"]>, t: Date): Promise<boolean> {
  if (o.declines > RECOVERY.cardMaxDeclines) return true;
  if (o.clientIp === UNKNOWN_IP) return true;
  const windowSec = RECOVERY.cardSuspicionWindowHours * 3600;
  if (await hadRecentEvent(cardBreakerKey(storeId), windowSec, t)) return true;
  return (await countRecentEvents(cardDeclineIpKey(ipRateKey(o.clientIp)), windowSec, t)) > RECOVERY.cardIpDeclinesMax;
}

/** Motivo para pular com linha (o candidato não volta), ou `null` se o lembrete pode sair. */
async function skipReason(tx: Tx, storeId: string, c: Candidate, hash: string, t: Date): Promise<RecoverySkipReason | null> {
  const [opted] = await tx
    .select({ h: emailOptout.emailHash })
    .from(emailOptout)
    .where(and(eq(emailOptout.storeId, storeId), eq(emailOptout.emailHash, hash)));
  if (opted) return "optout";

  // Já comprou a mesma oferta com o mesmo e-mail (o `customer.email` é gravado minúsculo; único por loja e e-mail).
  const [bought] = await tx
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(customer, eq(customer.id, orders.customerId))
    .where(
      and(
        eq(orders.offerId, c.offerId),
        eq(customer.email, c.email.trim().toLowerCase()),
        inArray(orders.status, WAS_PAID),
        sql`coalesce(${orders.paidAt}, ${orders.createdAt}) > ${iso(minus(t, RECOVERY.boughtLookbackDays * DAY_MS))}::timestamptz`,
      ),
    )
    .limit(1);
  if (bought) return "ja_comprou";

  if (c.order) {
    // O lembrete vai para o pedido mais novo do mesmo cliente na mesma oferta.
    const [newer] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.customerId, c.order.customerId),
          eq(orders.offerId, c.offerId),
          ne(orders.id, c.orderId!),
          gt(orders.createdAt, c.order.createdAt),
        ),
      )
      .limit(1);
    if (newer) return "pedido_mais_novo";
  }

  if (c.kind === "card" && (await cardSuspicious(storeId, c.order!, t))) return "cartao_suspeito";

  const sameAddress = (since: Date) =>
    and(
      eq(recoveryEmail.storeId, storeId),
      eq(recoveryEmail.emailHash, hash),
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
async function scanStore(tx: Tx, f: StoreFlags, t: Date): Promise<void> {
  const storeId = f.id;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`recovery:${storeId}`}))`);
  const list = await candidates(tx, f, t);
  if (list.length === 0) return;

  const hourAgo = minus(t, HOUR_MS);
  let storeCount = await liveSince(tx, storeId, hourAgo);
  let cardCount = await liveSince(tx, storeId, hourAgo, true);
  let deferred = 0;

  for (const c of list) {
    // Pula sem linha: teto da hora da loja ou do caso cartão (volta na próxima varredura).
    if (storeCount >= RECOVERY.storePerHour || (c.kind === "card" && cardCount >= RECOVERY.cardPerHour)) {
      deferred++;
      continue;
    }
    const hash = recoveryEmailHash(c.email);
    const reason = await skipReason(tx, storeId, c, hash, t);
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

/**
 * Handler do `recovery_scan`. Relógio injetável (testes). Falha numa loja não impede as demais; ao final, se alguma
 * falhou, o job falha para tentar de novo (padrão do `expire_orders`). `beforeStore` existe só para testes.
 */
export function createRecoveryScanHandler(now: () => Date = () => new Date(), beforeStore?: (storeId: string) => Promise<void>): JobHandler {
  return async (_j, signal) => {
    const t = now();
    // A tabela `store` não tem RLS.
    const stores = await db
      .select({ id: store.id, lead: store.recoveryLead, pix: store.recoveryPix, card: store.recoveryCard, capture: store.leadCapture })
      .from(store)
      .where(eq(store.recoveryOn, true))
      .orderBy(asc(store.id));
    let failed = 0;
    for (const f of stores) {
      if (signal.aborted) break;
      try {
        await beforeStore?.(f.id);
        await withStore(f.id, (tx) => scanStore(tx, f, t));
      } catch (e) {
        failed++;
        log.error("falha na varredura da recuperação da loja", { storeId: f.id, error: e });
      }
    }
    if (failed > 0) throw new Error(`recovery_scan falhou em ${failed} loja(s)`);
  };
}

export const recoveryScanJob: JobHandler = createRecoveryScanHandler();
