// Eventos do aviso ao app: o id estável e o registro do aviso na fila. Módulo leve de propósito: a máquina de estados
// (`orders/state.ts`) o importa e ela entra no bundle do serviço de cartão, que não leva o envio (`apps/webhook.ts`).
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alertSeller } from "@/lib/alerts";
import { sha256 } from "@/lib/crypto";
import type { Tx } from "@/lib/db/client";
import { appCheckoutSession, appWebhookDelivery, orders, storeAlert } from "@/lib/db/schema";
import { enqueue } from "@/lib/jobs";

export type AppPaymentEventType =
  | "pagamento.confirmado"
  | "pagamento.reembolsado"
  | "pagamento.reembolso_parcial"
  | "pagamento.contestado"
  | "pagamento.restabelecido";
export type AppEventType = AppPaymentEventType | "ping";

/** Espera (s) antes de cada nova tentativa do aviso; esgotada a lista, o aviso vira `failed`. */
export const APP_WEBHOOK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 86400] as const;
/** A primeira tentativa mais uma por espera da lista. */
export const APP_WEBHOOK_MAX_ATTEMPTS = APP_WEBHOOK_BACKOFF_SECONDS.length + 1;

/**
 * Id do evento: estável por (pedido, tipo, ocorrência), então o mesmo aviso reenviado (nova tentativa, job repetido,
 * "Reenviar") chega ao app com o mesmo id e ele deduplica. `seq` = quantas vezes aquele tipo já saiu para o pedido.
 */
export function appEventId(orderId: string, type: AppEventType, seq: number): string {
  return `evt_${sha256(`${orderId}:${type}:${seq}`).slice(0, 32)}`;
}

const CONFIRMED = "pagamento.confirmado" as const;

/**
 * Uma liberação por sessão de pagamento: dois pedidos da mesma sessão podem ser pagos (Pix pendente e cartão, duas
 * abas), mas só um libera no app. Sob `FOR UPDATE` da sessão, o primeiro pedido que gera aviso é gravado em
 * `released_order_id`; outro pedido da mesma sessão é `duplicate` e nunca avisa o app (nem confirmação, nem reembolso,
 * contestação, restabelecimento ou estorno parcial): reembolsá-lo não mexe na compra válida. Pedido sem sessão: `ok`.
 */
async function releaseOf(tx: Tx, storeId: string, orderId: string): Promise<"ok" | "duplicate"> {
  const [o] = await tx.select({ sessionId: orders.appSessionId }).from(orders).where(eq(orders.id, orderId));
  if (!o?.sessionId) return "ok";
  const [session] = await tx
    .select({ released: appCheckoutSession.releasedOrderId })
    .from(appCheckoutSession)
    .where(and(eq(appCheckoutSession.storeId, storeId), eq(appCheckoutSession.id, o.sessionId)))
    .for("update");
  if (!session) return "ok";
  if (session.released === null) {
    await tx
      .update(appCheckoutSession)
      .set({ releasedOrderId: orderId })
      .where(and(eq(appCheckoutSession.storeId, storeId), eq(appCheckoutSession.id, o.sessionId)));
    return "ok";
  }
  return session.released === orderId ? "ok" : "duplicate";
}

/** Pagamento duplicado de uma sessão: um alerta por pedido, pedindo o reembolso (o app não é avisado). */
async function alertDuplicate(tx: Tx, storeId: string, orderId: string): Promise<void> {
  const [seen] = await tx
    .select({ id: storeAlert.id })
    .from(storeAlert)
    .where(and(eq(storeAlert.storeId, storeId), eq(storeAlert.orderId, orderId), eq(storeAlert.kind, "pagamento_duplicado_app")))
    .limit(1);
  if (!seen) await alertSeller(tx, storeId, "pagamento_duplicado_app", { orderId });
}

/**
 * Registra o aviso (`app_webhook_delivery`, `pending`) e enfileira o `notify_app` na transação `tx`: os dois existem
 * ou nenhum. Quem chama já segura a linha do pedido (o UPDATE do estado ou um `FOR UPDATE`), então a contagem da
 * ocorrência e da sequência não corre. Devolve se criou.
 *
 * Ordem dentro do pedido (`sequence`, que vai no corpo como `dados.sequencia`): o `pagamento.confirmado` é sempre o 1
 * e a ocorrência 0 (repetir a chamada não cria outro); os demais continuam do maior já gravado. Todo aviso que não é
 * a confirmação GARANTE antes a confirmação: no cartão ela nasce no worker (`enqueueAppPaid`), e um reembolso que
 * chegue antes dele não pode sair sem ela. Nos demais tipos, um id repetido seria um aviso perdido: a transação falha
 * (quem chamou tenta de novo) em vez de pular.
 *
 * `pagamento.reembolso_parcial`: `refundedCents` é a soma devolvida até agora, gravada na linha (o envio e as
 * retentativas mandam esse valor, não o do momento do envio). Só há ocorrência nova quando a soma AUMENTA: o mesmo
 * valor de novo, ou um valor menor vindo de uma reconsulta fora de ordem, não gera aviso.
 *
 * Pedido duplicado de uma sessão (ver `releaseOf`): nenhum aviso; na confirmação, o alerta `pagamento_duplicado_app`.
 */
export async function enqueueAppNotice(
  tx: Tx,
  storeId: string,
  orderId: string,
  type: AppPaymentEventType,
  opts: { refundedCents?: number } = {},
): Promise<boolean> {
  if ((await releaseOf(tx, storeId, orderId)) === "duplicate") {
    if (type === CONFIRMED) await alertDuplicate(tx, storeId, orderId);
    return false;
  }
  const insert = async (eventType: AppPaymentEventType, occurrence: number, sequence: number, refundedCents: number | null, idempotent: boolean) => {
    const q = tx.insert(appWebhookDelivery).values({
      storeId,
      eventId: appEventId(orderId, eventType, occurrence),
      eventType,
      orderId,
      status: "pending",
      sequence,
      refundedCents,
    });
    const [created] = await (idempotent ? q.onConflictDoNothing() : q).returning({ id: appWebhookDelivery.id });
    if (!created) return false;
    await enqueue(tx, { storeId, type: "notify_app", payload: { deliveryId: created.id } });
    return true;
  };
  const confirmed = await insert(CONFIRMED, 0, 1, null, true);
  if (type === CONFIRMED) return confirmed;

  const rows = await tx
    .select({ eventType: appWebhookDelivery.eventType, sequence: appWebhookDelivery.sequence, refundedCents: appWebhookDelivery.refundedCents })
    .from(appWebhookDelivery)
    .where(eq(appWebhookDelivery.orderId, orderId));
  const same = rows.filter((r) => r.eventType === type);
  let refundedCents: number | null = null;
  if (type === "pagamento.reembolso_parcial") {
    const cents = opts.refundedCents;
    if (cents === undefined || !Number.isInteger(cents) || cents <= 0) throw new Error("reembolso parcial sem o valor devolvido");
    if (cents <= Math.max(0, ...same.map((r) => r.refundedCents ?? 0))) return false;
    refundedCents = cents;
  }
  const sequence = Math.max(1, ...rows.map((r) => r.sequence ?? 0)) + 1;
  return insert(type, same.length, sequence, refundedCents, false);
}

/**
 * O aviso do pedido que "Reenviar aviso ao app" manda (e o que o painel mostra): o NÃO entregue mais antigo (`failed`
 * ou `pending` de menor sequência), porque é ele que o app ainda não tem; com tudo entregue, o último. Sem aviso, nada.
 */
export async function noticeToResend(tx: Tx, orderId: string): Promise<typeof appWebhookDelivery.$inferSelect | undefined> {
  const [open] = await tx
    .select()
    .from(appWebhookDelivery)
    .where(and(eq(appWebhookDelivery.orderId, orderId), inArray(appWebhookDelivery.status, ["failed", "pending"])))
    .orderBy(asc(appWebhookDelivery.sequence))
    .limit(1);
  if (open) return open;
  const [last] = await tx.select().from(appWebhookDelivery).where(eq(appWebhookDelivery.orderId, orderId)).orderBy(desc(appWebhookDelivery.sequence)).limit(1);
  return last;
}

/**
 * Pedido de app que acabou de ser pago. O serviço de cartão roda com o papel `card` do banco, que não grava em
 * `app_webhook_delivery` nem enfileira `notify_app` (o papel não ganha permissão nova): ali sai o `deliver_order`, que
 * ele já pode enfileirar, e o worker do app (papel `app`) o troca pelo aviso (`deliverOrderJob`). Nos demais caminhos
 * (webhook do Asaas, conferência) o aviso nasce aqui, na transação do pagamento.
 */
export async function enqueueAppPaid(tx: Tx, storeId: string, orderId: string): Promise<void> {
  const rows = (await tx.execute(sql`select has_table_privilege(current_user, 'app_webhook_delivery', 'INSERT') as ok`)) as unknown as { ok: boolean }[];
  if (rows[0]?.ok === true) await enqueueAppNotice(tx, storeId, orderId, CONFIRMED);
  else await enqueue(tx, { storeId, type: "deliver_order", payload: { orderId } });
}
