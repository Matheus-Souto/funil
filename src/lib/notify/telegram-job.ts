// Job `notify_telegram` {event, orderId} ou {event: "lead_abandoned", leadId}: um aviso da loja no Telegram da própria loja. Segue o `metaEventJob`: transação
// curta lê pedido, itens, oferta e conexão e decide se envia (regras de cada evento, evento ligado, marca existente);
// a rede fica fora da transação; uma segunda grava a marca (`telegram_notice`, única por pedido e evento) e, numa falha
// definitiva, o aviso `telegram_falhou` do painel (um só enquanto não for confirmado). Falha temporária: relança e a fila
// tenta de novo (a mensagem do `TelegramError` é fixa e não tem o token). O abandono antes do pagamento (`lead_abandoned`)
// segue o mesmo caminho, mas não tem pedido: a marca do envio fica no próprio contato (`checkout_lead.notified_at`) e o
// log leva só `leadId`, `event` e o motivo (nunca e-mail nem celular).
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { alertSeller } from "@/lib/alerts";
import { withStore } from "@/lib/db/client";
import { loadOfferProducts } from "@/lib/catalog/offer-products";
import { cardAttempt, checkoutLead, coupon, offer, orderItem, orders, product, storeAlert, telegramNotice } from "@/lib/db/schema";
import { orderCode } from "@/lib/format";
import type { JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { checkRateLimit } from "@/lib/payments/ratelimit";
import { itemOrder } from "@/lib/orders/items";
import type { OrderMethod } from "@/lib/orders/labels";
import { TelegramError, leadCode, telegramMessage, telegramSend, type TelegramEvent } from "./telegram";
import { MAX_ABANDON, MIN_ABANDON, loadTelegram, type TelegramEvents } from "./telegram-connection";

const orderPayload = z.object({
  event: z.enum(["sale", "pix_generated", "card_declined", "abandoned"]),
  orderId: z.uuid(),
  /** Abandono: o prazo usado no agendamento (o vendedor pode mudá-lo depois). Ausente (job antigo): o da config. */
  afterMinutes: z.number().int().min(MIN_ABANDON).max(MAX_ABANDON).optional(),
});
/** Abandono antes do pagamento: o prazo vai sempre no payload (o job nasce junto com o contato). */
const leadPayload = z.object({
  event: z.literal("lead_abandoned"),
  leadId: z.uuid(),
  afterMinutes: z.number().int().min(MIN_ABANDON).max(MAX_ABANDON),
});
const payloadSchema = z.union([orderPayload, leadPayload]);

const EVENT_FLAG: Record<TelegramEvent, keyof TelegramEvents> = {
  sale: "sale",
  pix_generated: "pixGenerated",
  card_declined: "cardDeclined",
  abandoned: "abandoned",
  lead_abandoned: "leadAbandoned",
};

/** Venda paga há mais que isto não vira aviso. */
const SALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Folga do prazo do abandono: o job agendado para criado + prazo pode ser reivindicado um pouco antes do relógio. */
const ABANDON_TOLERANCE_MS = 5_000;

/** Aviso `lead_abandoned`: um por contato, nunca dois contatos do mesmo e-mail em 24 h e teto de 30 por loja por hora. */
const LEAD_EMAIL_DEDUPE_MS = 24 * 60 * 60 * 1000;
const LEAD_NOTICES_PER_HOUR = 30;

/** Pedido que já foi pago em algum momento (pago, contestado ou reembolsado). */
const WAS_PAID = ["paid", "disputed", "refunded"] as const;

type OrderEvent = Exclude<TelegramEvent, "lead_abandoned">;

/** O que vai ao log do envio: o id do pedido ou do contato e o evento (nunca dado do contato). */
type LogRef = { orderId: string; event: string } | { leadId: string; event: string };

type Prepared =
  | { skip: string }
  | { token: string; chatId: string; text: string };

/** Decide, para um pedido, se o aviso sai e com que texto (transação curta, sem rede). */
async function prepareOrder(storeId: string, event: OrderEvent, orderId: string, afterMinutes: number | undefined): Promise<Prepared> {
  return withStore(storeId, async (tx) => {
    // Só as colunas usadas (nada do comprador: nome, telefone...).
    const [o] = await tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        status: orders.status,
        method: orders.method,
        totalCents: orders.totalCents,
        discountCents: orders.discountCents,
        couponId: orders.couponId,
        customerId: orders.customerId,
        offerId: orders.offerId,
        createdAt: orders.createdAt,
        paidAt: orders.paidAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!o) return { skip: "pedido_inexistente" };
    const [sent] = await tx
      .select({ id: telegramNotice.id })
      .from(telegramNotice)
      .where(and(eq(telegramNotice.orderId, o.id), eq(telegramNotice.event, event)));
    if (sent) return { skip: "ja_enviado" };

    // Regras de "quando cada evento sai", conferidas no momento do envio.
    switch (event) {
      case "sale":
        if (o.status !== "paid") return { skip: `pedido_${o.status}` };
        // Pedido pago há muito tempo nunca vira aviso de venda (job antigo ou forjado).
        if (!o.paidAt || Date.now() - o.paidAt.getTime() > SALE_MAX_AGE_MS) return { skip: "venda_antiga" };
        break;
      case "pix_generated":
        if (o.method !== "pix_asaas" && o.method !== "pix_manual") return { skip: "nao_e_pix" };
        if (o.status !== "pending") return { skip: `pedido_${o.status}` };
        break;
      case "card_declined": {
        if (o.method !== "card_asaas") return { skip: "nao_e_cartao" };
        if (o.status !== "pending" && o.status !== "declined" && o.status !== "expired") return { skip: `pedido_${o.status}` };
        const [declined] = await tx
          .select({ id: cardAttempt.id })
          .from(cardAttempt)
          .where(and(eq(cardAttempt.orderId, o.id), eq(cardAttempt.status, "declined")))
          .limit(1);
        if (!declined) return { skip: "sem_recusa" };
        break;
      }
      case "abandoned": {
        if (o.status !== "pending" && o.status !== "declined" && o.status !== "expired") return { skip: `pedido_${o.status}` };
        // O mesmo cliente pagou a mesma oferta depois deste pedido (ex.: gerou dois Pix e pagou o segundo): não abandonou.
        const [later] = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(
              eq(orders.customerId, o.customerId),
              eq(orders.offerId, o.offerId),
              gt(orders.createdAt, o.createdAt),
              inArray(orders.status, [...WAS_PAID]),
            ),
          )
          .limit(1);
        if (later) return { skip: "pago_depois" };
        break;
      }
    }

    const conn = await loadTelegram(tx, storeId);
    if (!conn) return { skip: "sem_conexao" };
    if (!conn.events[EVENT_FLAG[event]]) return { skip: "evento_desligado" };
    // Prazo do agendamento (não o atual da config): mudar o prazo depois não perde os abandonos já agendados.
    const abandonAfterMinutes = afterMinutes ?? conn.abandonAfterMinutes;
    // Abandono antes do prazo (job forjado ou relógio): pula sem marca; o agendamento legítimo envia depois.
    if (event === "abandoned" && Date.now() < o.createdAt.getTime() + abandonAfterMinutes * 60_000 - ABANDON_TOLERANCE_MS) {
      return { skip: "antes_do_prazo" };
    }

    const items = await tx
      .select({ name: product.name, kind: orderItem.kind })
      .from(orderItem)
      .innerJoin(product, eq(product.id, orderItem.productId))
      .where(eq(orderItem.orderId, o.id))
      .orderBy(...itemOrder);
    const [of] = await tx.select({ name: offer.name, bumpLabel: offer.bumpLabel }).from(offer).where(eq(offer.id, o.offerId));
    // Mesmo critério do aviso de venda por e-mail: 1 principal -> o produto; mais de 1 -> a oferta.
    const mains = items.filter((i) => i.kind === "main");
    const bumps = items.filter((i) => i.kind === "bump");
    const productName = mains.length > 1 ? (of?.name ?? "pedido") : (mains[0]?.name ?? items[0]?.name ?? of?.name ?? "pedido");
    const bumpName = bumps.length === 0 ? null : (of?.bumpLabel?.trim() || bumps.map((b) => b.name).join(" + "));
    // Só o aviso de venda leva o cupom: o código e o desconto (nada do comprador).
    const [cp] = event === "sale" && o.couponId ? await tx.select({ code: coupon.code }).from(coupon).where(eq(coupon.id, o.couponId)) : [];
    const text = telegramMessage(event, {
      productName,
      bumpName,
      ...(cp ? { coupon: { code: cp.code, discountCents: o.discountCents } } : {}),
      totalCents: o.totalCents,
      method: o.method as OrderMethod,
      orderCode: orderCode(o.publicId),
      abandonAfterMinutes,
    });
    return { token: conn.token, chatId: conn.chatId, text };
  });
}

/**
 * Decide, para um contato do checkout, se o aviso sai. Ordem: existência, validade (30 dias), estado, marca, conexão, flag, prazo e e-mail
 * repetido; o teto por hora vem POR ÚLTIMO, para só contar o que de fato vai sair (um contato pulado por qualquer outra
 * regra não gasta o teto). Valor = preço atual da oferta; nome = mesmo critério do aviso de pedido (mais de um produto
 * principal -> o nome da oferta). Nada do contato (e-mail, celular) entra no texto nem no log.
 */
async function prepareLead(storeId: string, leadId: string, afterMinutes: number): Promise<Prepared> {
  return withStore(storeId, async (tx) => {
    const [l] = await tx
      .select({
        id: checkoutLead.id,
        status: checkoutLead.status,
        notifiedAt: checkoutLead.notifiedAt,
        createdAt: checkoutLead.createdAt,
        emailHash: checkoutLead.emailHash,
        offerId: checkoutLead.offerId,
        expired: sql<boolean>`${checkoutLead.expiresAt} <= now()`,
      })
      .from(checkoutLead)
      .where(eq(checkoutLead.id, leadId));
    if (!l) return { skip: "contato_inexistente" };
    // Passou dos 30 dias e a varredura ainda não apagou: não avisa.
    if (l.expired) return { skip: "vencido" };
    if (l.status !== "open") return { skip: `contato_${l.status}` };
    if (l.notifiedAt) return { skip: "ja_enviado" };
    const conn = await loadTelegram(tx, storeId);
    if (!conn) return { skip: "sem_conexao" };
    if (!conn.events.leadAbandoned) return { skip: "evento_desligado" };
    // Antes do prazo (job forjado ou relógio): pula sem marca; o agendamento legítimo envia depois.
    if (Date.now() < l.createdAt.getTime() + afterMinutes * 60_000 - ABANDON_TOLERANCE_MS) return { skip: "antes_do_prazo" };
    // A pessoa recarregou a página e gerou outro contato: o mesmo e-mail já avisado nas últimas 24 h não avisa de novo.
    const [recent] = await tx
      .select({ id: checkoutLead.id })
      .from(checkoutLead)
      .where(
        and(
          eq(checkoutLead.storeId, storeId),
          eq(checkoutLead.emailHash, l.emailHash),
          ne(checkoutLead.id, l.id),
          gt(checkoutLead.notifiedAt, new Date(Date.now() - LEAD_EMAIL_DEDUPE_MS)),
        ),
      )
      .limit(1);
    if (recent) return { skip: "mesmo_email_recente" };

    const [of] = await tx.select({ name: offer.name, priceCents: offer.priceCents }).from(offer).where(eq(offer.id, l.offerId));
    if (!of) return { skip: "oferta_inexistente" };
    const mains = (await loadOfferProducts(tx, [l.offerId])).get(l.offerId)?.main.filter((p) => p.deletedAt === null) ?? [];
    const productName = mains.length > 1 ? of.name : (mains[0]?.name ?? of.name);

    // Teto de avisos por loja na hora: por último, depois de todas as outras checagens, porque `checkRateLimit` soma 1 a
    // cada chamada e só deve contar o aviso que de fato vai sair. Vai na transação (sem segunda conexão do pool).
    if (!(await checkRateLimit(`telegram:lead:${storeId}`, LEAD_NOTICES_PER_HOUR, 3600, new Date(), tx))) return { skip: "teto_por_hora" };

    const text = telegramMessage("lead_abandoned", {
      productName,
      bumpName: null,
      totalCents: of.priceCents,
      orderCode: leadCode(l.id),
      abandonAfterMinutes: afterMinutes,
    });
    return { token: conn.token, chatId: conn.chatId, text };
  });
}

/**
 * Envia o texto. Devolve o `message_id`, ou `null` se a falha foi definitiva (token ou chat): re-tentar não resolve, então
 * registra um aviso `telegram_falhou` no painel (um por vez, até o vendedor confirmar). Falha temporária relança e a fila
 * tenta de novo. `ref` é o que vai ao log (id do pedido ou do contato, nunca dado do contato).
 */
async function sendOrAlert(storeId: string, prep: { token: string; chatId: string; text: string }, ref: LogRef, signal: AbortSignal): Promise<number | null> {
  try {
    return (await telegramSend(prep.token, prep.chatId, prep.text, { signal })).messageId;
  } catch (e) {
    if (!(e instanceof TelegramError) || e.kind === "temporary") throw e;
    log.error("Telegram recusou o aviso da loja (definitivo); não será re-tentado", { ...ref, httpStatus: e.httpStatus, migrated: e.migrated });
    await withStore(storeId, async (tx) => {
      // Falhas simultâneas da mesma loja: uma de cada vez confere e grava (senão cada uma veria "nenhum aberto").
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('telegram_falhou:' || ${storeId}))`);
      const [open] = await tx
        .select({ id: storeAlert.id })
        .from(storeAlert)
        .where(and(eq(storeAlert.storeId, storeId), eq(storeAlert.kind, "telegram_falhou"), isNull(storeAlert.acknowledgedAt)))
        .limit(1);
      // Grupo que virou supergrupo: o aviso diz para salvar o id novo (não para conferir o token).
      if (!open) await alertSeller(tx, storeId, "telegram_falhou", { httpStatus: e.httpStatus, ...(e.migrated ? { code: "grupo_migrado" } : {}) });
    });
    return null;
  }
}

export const notifyTelegramJob: JobHandler = async (j, signal) => {
  const parsed = payloadSchema.safeParse(j.payload);
  if (!j.storeId || !parsed.success) {
    log.error("notify_telegram com payload inválido; descartado", { id: j.id });
    return;
  }
  const storeId = j.storeId;
  const data = parsed.data;
  const ref: LogRef = data.event === "lead_abandoned" ? { leadId: data.leadId, event: data.event } : { orderId: data.orderId, event: data.event };

  const prep = data.event === "lead_abandoned" ? await prepareLead(storeId, data.leadId, data.afterMinutes) : await prepareOrder(storeId, data.event, data.orderId, data.afterMinutes);

  if ("skip" in prep) {
    log.info("notify_telegram: nada a enviar", { ...ref, reason: prep.skip });
    return;
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("job abortado");

  const messageId = await sendOrAlert(storeId, prep, ref, signal);
  if (messageId === null) return;
  if (data.event === "lead_abandoned") {
    // Marca no próprio contato; `notified_at is null` impede sobrescrever um envio concorrente.
    await withStore(storeId, (tx) =>
      tx
        .update(checkoutLead)
        .set({ notifiedAt: sql`now()`, telegramMessageId: messageId })
        .where(and(eq(checkoutLead.id, data.leadId), isNull(checkoutLead.notifiedAt))),
    );
  } else {
    const { orderId, event } = data;
    await withStore(storeId, (tx) => tx.insert(telegramNotice).values({ storeId, orderId, event, messageId }).onConflictDoNothing());
  }
  log.info("notify_telegram enviado", ref);
};
