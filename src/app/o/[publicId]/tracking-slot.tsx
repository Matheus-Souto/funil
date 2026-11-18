import type { OrderPublic } from "@/lib/checkout";

/**
 * Lugar do Meta Pixel na página de obrigado (Task 13): disparar `Purchase` com `eventID: "purchase:<id do pedido>"`
 * (o mesmo id do evento da API de Conversões), uma vez por pedido (sessionStorage). Por enquanto não desenha nada.
 */
export function PurchaseTracking({ order }: { order: OrderPublic }) {
  void order;
  return null;
}
