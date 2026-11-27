// Que tela a página do pedido pendente mostra. Puro (sem banco), para testar a decisão.
import type { OrderPublic } from "@/lib/checkout";

export type PendingView = "session_closed" | "pix_manual" | "pix_asaas" | "card_pending";

/**
 * Pedido de app com a sessão encerrada vem antes de qualquer meio de pagamento ("Pagamento já concluído" ou "Link
 * vencido", com "Voltar ao app"). Exceção: cartão pendente com a sessão só VENCIDA continua em "Pagamento em análise"
 * ("não pague de novo"): o pedido de cartão só fica pendente quando o desfecho da cobrança é desconhecido (o Asaas pode
 * ter cobrado), e mandar tentar de novo pelo app viraria um segundo pagamento noutra sessão.
 */
export function pendingView(order: Pick<OrderPublic, "method" | "app">): PendingView {
  const closed = order.app?.sessionClosed ?? null;
  if (closed && !(closed === "expired" && order.method === "card_asaas")) return "session_closed";
  if (order.method === "pix_manual") return "pix_manual";
  if (order.method === "pix_asaas") return "pix_asaas";
  return "card_pending";
}

/** O que o polling compara: o status do pedido e, no pedido de app, se a sessão fechou (a aba aberta troca sozinha). */
export const liveKey = (status: string, sessionClosed: string | null | undefined): string => `${status}:${sessionClosed ?? ""}`;
