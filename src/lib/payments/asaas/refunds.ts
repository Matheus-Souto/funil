// Estado de estorno de uma cobrança do Asaas. A cobrança pode continuar CONFIRMED/RECEIVED com o estorno em
// `refunds[]` (PENDING, AWAITING_CRITICAL_ACTION_AUTHORIZATION, AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION, CANCELLED,
// DONE); o dinheiro só voltou com DONE (ou status REFUNDED). O Asaas aceita estornos parciais (painel ou API com
// `value`): o estorno só está concluído quando a soma dos itens DONE cobre o valor. Funções puras: usadas pelo job
// refund_order, pelo webhook e pelo painel.
import { reaisToCents } from "./client";

/**
 * Marca gravada em `payment.raw.refundPost` antes de o job pedir o estorno: `before` = quantos itens `refunds[]` a
 * cobrança já tinha. Itens depois desse índice são do pedido de estorno atual. Só vale se `at` >= `refund_requested_at`
 * do pedido (marca de um pedido de estorno anterior não conta). `acceptedAt`: o Asaas aceitou o pedido (resposta 2xx ou
 * estorno visto em andamento depois); só com ela o painel mostra "aguardando o Asaas".
 */
export interface RefundMarker {
  at: string;
  before: number;
  acceptedAt?: string;
}

export type RefundState = "none" | "requested" | "done" | "partial" | "cancelled";

/** Item de `refunds[]`: status e valor em centavos. */
export interface RefundItem {
  status: string;
  cents: number;
}

const IN_FLIGHT_STATUSES = new Set(["REFUND_REQUESTED", "REFUND_IN_PROGRESS"]);

/** Itens de `refunds[]` (até 50): status curto e valor em centavos (inteiro, >= 0). */
export function refundItems(p: object): RefundItem[] {
  const refunds = (p as { refunds?: unknown }).refunds;
  if (!Array.isArray(refunds)) return [];
  return refunds.slice(0, 50).map((r) => {
    const item = (r ?? {}) as { status?: unknown; value?: unknown };
    const value = Number(item.value);
    return {
      status: String(item.status ?? "").slice(0, 64),
      cents: Number.isFinite(value) && value > 0 ? reaisToCents(value) : 0,
    };
  });
}

/** Soma (centavos) dos estornos concluídos (DONE). */
export function refundedCents(items: RefundItem[]): number {
  return items.reduce((n, r) => n + (r.status === "DONE" ? r.cents : 0), 0);
}

export function refundMarkerOf(raw: unknown, requestedAt: Date | null): RefundMarker | null {
  const m = (raw as { refundPost?: { at?: unknown; before?: unknown; acceptedAt?: unknown } } | null)?.refundPost;
  if (!m || typeof m.at !== "string" || typeof m.before !== "number" || !requestedAt) return null;
  const at = new Date(m.at);
  if (Number.isNaN(at.getTime()) || at.getTime() < requestedAt.getTime()) return null;
  return { at: m.at, before: m.before, ...(typeof m.acceptedAt === "string" ? { acceptedAt: m.acceptedAt } : {}) };
}

/**
 * `fullCents`: quanto precisa ter voltado para o estorno ser total (o total do pedido; numa parcela de cartão
 * parcelado, o valor da parcela, pois cada parcela é estornada por inteiro).
 * - `done`: status REFUNDED ou soma dos DONE >= `fullCents`;
 * - `requested`: há estorno em andamento (status REFUND_REQUESTED/IN_PROGRESS ou item que não é CANCELLED nem DONE);
 * - `cancelled`: o estorno pedido agora (itens depois de `marker.before`) terminou sem nada DONE;
 * - `partial`: algum DONE, mas a soma não cobre o total (estorno parcial, em geral feito no painel do Asaas);
 * - `none`: nada em andamento (pode pedir).
 */
export function classifyRefund(status: string, items: RefundItem[], marker: RefundMarker | null, fullCents: number): RefundState {
  const done = refundedCents(items);
  if (status === "REFUNDED" || (done > 0 && done >= fullCents)) return "done";
  if (IN_FLIGHT_STATUSES.has(status) || items.some((r) => r.status !== "CANCELLED" && r.status !== "DONE")) return "requested";
  if (marker && items.length > marker.before && !items.slice(marker.before).some((r) => r.status === "DONE")) return "cancelled";
  if (done > 0) return "partial";
  return "none";
}
