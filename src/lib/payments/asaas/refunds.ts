// Estado de estorno de uma cobrança do Asaas. A cobrança pode continuar CONFIRMED/RECEIVED com o estorno em
// `refunds[]` (PENDING, AWAITING_CRITICAL_ACTION_AUTHORIZATION, AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION, CANCELLED,
// DONE); o dinheiro só voltou com DONE (ou status REFUNDED). Funções puras: usadas pelo job refund_order e pelo webhook.

/**
 * Marca gravada em `payment.raw.refundPost` antes de o job pedir o estorno: `before` = quantos itens `refunds[]` a
 * cobrança já tinha. Itens depois desse índice são do pedido de estorno atual. Só vale se `at` >= `refund_requested_at`
 * do pedido (marca de um pedido de estorno anterior não conta).
 */
export interface RefundMarker {
  at: string;
  before: number;
}

export type RefundState = "none" | "requested" | "done" | "cancelled";

const IN_FLIGHT_STATUSES = new Set(["REFUND_REQUESTED", "REFUND_IN_PROGRESS"]);

/** Status dos itens de `refunds[]` (até 50, só texto curto). */
export function refundStatuses(p: object): string[] {
  const refunds = (p as { refunds?: unknown }).refunds;
  if (!Array.isArray(refunds)) return [];
  return refunds.slice(0, 50).map((r) => String((r as { status?: unknown } | null)?.status ?? "").slice(0, 64));
}

export function refundMarkerOf(raw: unknown, requestedAt: Date | null): RefundMarker | null {
  const m = (raw as { refundPost?: { at?: unknown; before?: unknown } } | null)?.refundPost;
  if (!m || typeof m.at !== "string" || typeof m.before !== "number" || !requestedAt) return null;
  const at = new Date(m.at);
  if (Number.isNaN(at.getTime()) || at.getTime() < requestedAt.getTime()) return null;
  return { at: m.at, before: m.before };
}

/**
 * - `done`: status REFUNDED ou algum estorno DONE;
 * - `requested`: há estorno em andamento (status REFUND_REQUESTED/IN_PROGRESS ou item que não é CANCELLED nem DONE);
 * - `cancelled`: o estorno pedido agora (itens depois de `marker.before`) terminou CANCELLED;
 * - `none`: nada em andamento (pode pedir).
 */
export function classifyRefund(status: string, statuses: string[], marker: RefundMarker | null): RefundState {
  if (status === "REFUNDED" || statuses.includes("DONE")) return "done";
  if (IN_FLIGHT_STATUSES.has(status) || statuses.some((s) => s !== "CANCELLED" && s !== "DONE")) return "requested";
  if (marker && statuses.length > marker.before) return "cancelled";
  return "none";
}
