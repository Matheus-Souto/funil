// Job `notify_telegram` {event, orderId}: um aviso da loja no Telegram da própria loja. Segue o `metaEventJob`: transação
// curta lê pedido, itens, oferta e conexão e decide se envia (regras de cada evento, evento ligado, marca existente);
// a rede fica fora da transação; uma segunda grava a marca (`telegram_notice`, única por pedido e evento) e, numa falha
// definitiva, o aviso `telegram_falhou` do painel (um só enquanto não for confirmado). Falha temporária: relança e a fila
// tenta de novo (a mensagem do `TelegramError` é fixa e não tem o token).
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { alertSeller } from "@/lib/alerts";
import { withStore } from "@/lib/db/client";
import { offer, orderItem, orders, product, storeAlert, telegramNotice } from "@/lib/db/schema";
import { orderCode } from "@/lib/format";
import type { JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { itemOrder } from "@/lib/orders/items";
import type { OrderMethod } from "@/lib/orders/labels";
import { TelegramError, telegramMessage, telegramSend, type TelegramEvent } from "./telegram";
import { loadTelegram, type TelegramEvents } from "./telegram-connection";

const payloadSchema = z.object({ event: z.enum(["sale", "pix_generated", "card_declined", "abandoned"]), orderId: z.uuid() });

const EVENT_FLAG: Record<TelegramEvent, keyof TelegramEvents> = {
  sale: "sale",
  pix_generated: "pixGenerated",
  card_declined: "cardDeclined",
  abandoned: "abandoned",
};

/** Pedido que já foi pago em algum momento (pago, contestado ou reembolsado). */
const WAS_PAID = ["paid", "disputed", "refunded"] as const;

type Prepared =
  | { skip: string }
  | { token: string; chatId: string; text: string };

export const notifyTelegramJob: JobHandler = async (j, signal) => {
  const parsed = payloadSchema.safeParse(j.payload);
  if (!j.storeId || !parsed.success) {
    log.error("notify_telegram com payload inválido; descartado", { id: j.id });
    return;
  }
  const storeId = j.storeId;
  const { event, orderId } = parsed.data;

  const prep: Prepared = await withStore(storeId, async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
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
        break;
      case "pix_generated":
        if (o.method !== "pix_asaas" && o.method !== "pix_manual") return { skip: "nao_e_pix" };
        if (o.status !== "pending") return { skip: `pedido_${o.status}` };
        break;
      case "card_declined":
        if (o.status !== "pending" && o.status !== "declined" && o.status !== "expired") return { skip: `pedido_${o.status}` };
        break;
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
    const text = telegramMessage(event, {
      productName,
      bumpName,
      totalCents: o.totalCents,
      method: o.method as OrderMethod,
      orderCode: orderCode(o.publicId),
      abandonAfterMinutes: conn.abandonAfterMinutes,
    });
    return { token: conn.token, chatId: conn.chatId, text };
  });

  if ("skip" in prep) {
    log.info("notify_telegram: nada a enviar", { orderId, event, reason: prep.skip });
    return;
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("job abortado");

  let messageId: number;
  try {
    ({ messageId } = await telegramSend(prep.token, prep.chatId, prep.text, { signal }));
  } catch (e) {
    if (!(e instanceof TelegramError) || e.kind === "temporary") throw e;
    // Falha definitiva (token ou chat): re-tentar não resolve. Um aviso no painel por vez, até o vendedor confirmar.
    log.error("Telegram recusou o aviso da loja (definitivo); não será re-tentado", { orderId, event, httpStatus: e.httpStatus });
    await withStore(storeId, async (tx) => {
      const [open] = await tx
        .select({ id: storeAlert.id })
        .from(storeAlert)
        .where(and(eq(storeAlert.kind, "telegram_falhou"), isNull(storeAlert.acknowledgedAt)))
        .limit(1);
      if (!open) await alertSeller(tx, storeId, "telegram_falhou", { httpStatus: e.httpStatus });
    });
    return;
  }
  await withStore(storeId, (tx) => tx.insert(telegramNotice).values({ storeId, orderId, event, messageId }).onConflictDoNothing());
  log.info("notify_telegram enviado", { orderId, event });
};
