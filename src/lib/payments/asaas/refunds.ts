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
  /** "installment": gravada pelo job ao pedir o estorno do parcelamento inteiro (nunca por estorno visto no Asaas). */
  scope?: "installment";
}

/** Prazo do nosso estorno do parcelamento: depois disso, parcelas que não voltaram contam como estorno parcial. */
export const INSTALLMENT_REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  const m = (raw as { refundPost?: { at?: unknown; before?: unknown; acceptedAt?: unknown; scope?: unknown } } | null)?.refundPost;
  if (!m || typeof m.at !== "string" || typeof m.before !== "number" || !requestedAt) return null;
  const at = new Date(m.at);
  if (Number.isNaN(at.getTime()) || at.getTime() < requestedAt.getTime()) return null;
  return {
    at: m.at,
    before: m.before,
    ...(typeof m.acceptedAt === "string" ? { acceptedAt: m.acceptedAt } : {}),
    ...(m.scope === "installment" ? { scope: "installment" as const } : {}),
  };
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

/** Parcela de um parcelamento reconsultada no Asaas: id, status, `refunds[]` e valor da parcela (centavos). */
export interface InstallmentParcel {
  id: string;
  status: string;
  refunds: RefundItem[];
  cents: number;
}

/** Parcelas de um parcelamento a partir da listagem do Asaas (só as do parcelamento pedido, sem as apagadas). */
export function installmentParcels(list: { id?: unknown; status?: unknown; value?: unknown; installment?: unknown; deleted?: unknown }[], installment: string): InstallmentParcel[] {
  return list
    .filter((p) => p.installment === installment && p.deleted !== true && typeof p.id === "string" && p.id)
    .slice(0, 24)
    .map((p) => ({
      id: String(p.id).slice(0, 100),
      status: String(p.status ?? "").slice(0, 64),
      refunds: refundItems(p as object),
      cents: Math.max(0, reaisToCents(Number(p.value) || 0)),
    }));
}

/**
 * Estado de estorno de um parcelamento inteiro (cartão parcelado: cada parcela é uma cobrança). A venda só está
 * estornada quando TODAS as parcelas voltaram; uma parcela estornada sozinha (painel do Asaas) é estorno parcial.
 * `markerFor(id)`: a marca do pedido de estorno gravada na linha daquela parcela (para detectar `cancelled`).
 * - `done`: todas as parcelas `done`;
 * - `requested`: alguma em andamento (o estorno do parcelamento ainda está correndo: sem aviso de parcial), ou há
 *   marca do job (`scope: "installment"`, nosso pedido de estorno do parcelamento inteiro) com menos de
 *   `INSTALLMENT_REFUND_WINDOW_MS` e só parte das parcelas voltou até agora (o Asaas conclui as parcelas em momentos
 *   diferentes; esse meio-tempo não é estorno parcial). Marca de estorno visto no painel do Asaas não conta;
 * - `partial`: alguma `done` ou com estorno parcial, nada em andamento e sem pedido nosso;
 * - `cancelled`: o estorno pedido agora terminou sem nada devolvido;
 * - `none`: nada em andamento nem devolvido. Sem parcelas (resposta vazia): `none` (nunca conclui às cegas).
 */
export function classifyInstallmentRefund(
  parcels: InstallmentParcel[],
  markerFor: (id: string) => RefundMarker | null,
  now: Date = new Date(),
): RefundState {
  if (parcels.length === 0) return "none";
  const states = parcels.map((p) => classifyRefund(p.status, p.refunds, markerFor(p.id), p.cents));
  if (states.every((x) => x === "done")) return "done";
  if (states.includes("requested")) return "requested";
  const ours = parcels.some((p) => {
    const m = markerFor(p.id);
    return m?.scope === "installment" && now.getTime() - new Date(m.at).getTime() < INSTALLMENT_REFUND_WINDOW_MS;
  });
  if (states.some((x) => x === "done" || x === "partial")) return ours ? "requested" : "partial";
  if (states.includes("cancelled")) return "cancelled";
  return "none";
}

/** Quanto do parcelamento já voltou (centavos): parcela estornada inteira conta o valor dela; as demais, os DONE. */
export function installmentRefundedCents(parcels: InstallmentParcel[]): number {
  return parcels.reduce((n, p) => n + (p.status === "REFUNDED" ? p.cents : Math.min(p.cents, refundedCents(p.refunds))), 0);
}
