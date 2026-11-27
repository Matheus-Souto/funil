// Eventos do aviso ao app: o id estável e o registro do aviso na fila. Módulo leve de propósito: a máquina de estados
// (`orders/state.ts`) o importa e ela entra no bundle do serviço de cartão, que não leva o envio (`apps/webhook.ts`).
import { and, count, eq, sql } from "drizzle-orm";
import { sha256 } from "@/lib/crypto";
import type { Tx } from "@/lib/db/client";
import { appWebhookDelivery } from "@/lib/db/schema";
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

/**
 * Registra o aviso (`app_webhook_delivery`, `pending`) e enfileira o `notify_app` na transação `tx`: os dois existem
 * ou nenhum. Quem chama já segura a linha do pedido (o UPDATE do estado ou um `FOR UPDATE`), então a contagem da
 * ocorrência não corre. `pagamento.confirmado` é sempre a ocorrência 0: repetir a chamada não cria outro aviso. Nos
 * demais tipos, um id repetido seria um aviso perdido: a transação falha (quem chamou tenta de novo) em vez de pular.
 * `created_at` é o relógio do banco no instante do insert (não o início da transação): dois avisos da mesma transação
 * (estorno parcial e contestação no mesmo evento do Asaas) ficam em ordem, e "o último aviso" é um só. Devolve se criou.
 */
export async function enqueueAppNotice(tx: Tx, storeId: string, orderId: string, type: AppPaymentEventType): Promise<boolean> {
  let seq = 0;
  if (type !== "pagamento.confirmado") {
    const [row] = await tx
      .select({ n: count().mapWith(Number) })
      .from(appWebhookDelivery)
      .where(and(eq(appWebhookDelivery.orderId, orderId), eq(appWebhookDelivery.eventType, type)));
    seq = row?.n ?? 0;
  }
  const insert = tx
    .insert(appWebhookDelivery)
    .values({ storeId, eventId: appEventId(orderId, type, seq), eventType: type, orderId, status: "pending", createdAt: sql`clock_timestamp()` });
  const [created] = await (type === "pagamento.confirmado" ? insert.onConflictDoNothing({ target: appWebhookDelivery.eventId }) : insert).returning({
    id: appWebhookDelivery.id,
  });
  if (!created) return false;
  await enqueue(tx, { storeId, type: "notify_app", payload: { deliveryId: created.id } });
  return true;
}

/**
 * Pedido de app que acabou de ser pago. O serviço de cartão roda com o papel `card` do banco, que não grava em
 * `app_webhook_delivery` nem enfileira `notify_app` (o papel não ganha permissão nova): ali sai o `deliver_order`, que
 * ele já pode enfileirar, e o worker do app (papel `app`) o troca pelo aviso (`deliverOrderJob`). Nos demais caminhos
 * (webhook do Asaas, conferência) o aviso nasce aqui, na transação do pagamento.
 */
export async function enqueueAppPaid(tx: Tx, storeId: string, orderId: string): Promise<void> {
  const rows = (await tx.execute(sql`select has_table_privilege(current_user, 'app_webhook_delivery', 'INSERT') as ok`)) as unknown as { ok: boolean }[];
  if (rows[0]?.ok === true) await enqueueAppNotice(tx, storeId, orderId, "pagamento.confirmado");
  else await enqueue(tx, { storeId, type: "deliver_order", payload: { orderId } });
}
