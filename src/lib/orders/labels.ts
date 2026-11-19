// Rótulos do painel (sem dependência de servidor: usados também em componentes do navegador).
import { hasPermission, type Role } from "@/lib/actions/permissions";

export type OrderStatus = "pending" | "paid" | "refunded" | "disputed" | "expired" | "declined";
export type OrderMethod = "pix_manual" | "pix_asaas" | "card_asaas";
export const ORDER_STATUSES: readonly OrderStatus[] = ["pending", "paid", "expired", "declined", "refunded", "disputed"];
export const ORDER_METHODS: readonly OrderMethod[] = ["pix_manual", "pix_asaas", "card_asaas"];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Pendente",
  paid: "Pago",
  refunded: "Reembolsado",
  disputed: "Contestado",
  expired: "Expirado",
  declined: "Recusado",
};
/** Plural dos filtros da lista ("Pagos 71"). */
export const STATUS_FILTER_LABEL: Record<OrderStatus, string> = {
  pending: "Pendentes",
  paid: "Pagos",
  refunded: "Reembolsados",
  disputed: "Contestados",
  expired: "Expirados",
  declined: "Recusados",
};
export const METHOD_LABEL: Record<OrderMethod, string> = { pix_manual: "Pix manual", pix_asaas: "Pix Asaas", card_asaas: "Cartão" };

/** Rótulo do status na lista: Pix manual pendente é "Aguardando liberação" (o vendedor precisa agir). */
export function statusLabel(status: string, method: string): string {
  if (status === "pending" && method === "pix_manual") return "Aguardando liberação";
  return STATUS_LABEL[status as OrderStatus] ?? status;
}
/** Tom do selo de status (cores do componente Status do design). */
export function statusTone(status: string, method: string): "warning" | "success" | "danger" | "neutral" | "info" {
  if (status === "pending") return method === "pix_manual" ? "warning" : "neutral";
  if (status === "paid") return "success";
  if (status === "declined" || status === "disputed") return "danger";
  if (status === "refunded") return "info";
  return "neutral";
}

/**
 * Quarentena do valor único de um Pix manual vencido (48 h depois da validade): fonte única, usada também pela alocação
 * em src/lib/payments/manual.ts.
 */
export const PIX_MANUAL_RESERVE_MS = 48 * 60 * 60 * 1000;

/**
 * Pix manual vencido: `expired`, ou ainda `pending` com a validade já passada (a varredura ainda não rodou). Nos dois
 * casos o valor único só fica reservado até 48 h depois da validade; liberar pede conferência extra de data e hora.
 */
export function pixManualExpiry(
  o: { method: string; status: string; expiresAt: Date | null },
  now: Date = new Date(),
): { expired: boolean; reservedUntil: Date | null } {
  const late = o.status === "expired" || (o.status === "pending" && o.expiresAt !== null && o.expiresAt.getTime() <= now.getTime());
  if (o.method !== "pix_manual" || !late || !o.expiresAt) return { expired: false, reservedUntil: null };
  return { expired: true, reservedUntil: new Date(o.expiresAt.getTime() + PIX_MANUAL_RESERVE_MS) };
}

export type RefundState = "none" | "processing" | "awaiting_provider" | "stale";

/**
 * Pix Asaas com cobrança da conta Asaas anterior da loja (descartada na troca de conta) que recebeu evento depois: o
 * comprador pode ter pago lá, e esse dinheiro nunca confirma o pedido sozinho. O vendedor confere e libera à mão.
 */
export function paidOnOldAsaasAccount(o: { method: string; payments?: { flags: readonly string[] }[] }): boolean {
  return o.method === "pix_asaas" && (o.payments ?? []).some((p) => p.flags.includes("superseded") && p.flags.includes("old_account_event"));
}

/**
 * Botões do pedido conforme o papel e o estado (o servidor confere de novo em cada ação).
 * Liberar: pendente ou expirado de Pix manual, ou de Pix Asaas pago na conta Asaas anterior. Reenviar: pago.
 * Reembolsar: pago e sem estorno em andamento (ou parado).
 */
export function allowedOrderActions(
  role: Role,
  o: { status: string; method: string; refund: { state: RefundState }; payments?: { flags: readonly string[] }[] },
): { release: boolean; resend: boolean; refund: boolean } {
  const releasable = o.method === "pix_manual" || paidOnOldAsaasAccount(o);
  return {
    release: hasPermission(role, "orders.release") && releasable && (o.status === "pending" || o.status === "expired"),
    resend: hasPermission(role, "orders.resend") && o.status === "paid",
    refund: hasPermission(role, "orders.refund") && o.status === "paid" && (o.refund.state === "none" || o.refund.state === "stale"),
  };
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Você é dono", admin: "Administrador", support: "Atendimento", traffic: "Tráfego" };
