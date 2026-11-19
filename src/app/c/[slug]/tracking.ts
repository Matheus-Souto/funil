// Ganchos do Meta Pixel chamados pelo formulário do checkout. O Pixel em si é carregado por `CheckoutPixel`
// (pixel.tsx) só quando há Pixel configurado; sem ele, `trackPixel` não faz nada.
import { trackPixel } from "@/lib/tracking/fbq";

export const checkoutTracking = {
  /** Ao enviar o pagamento (Pix ou cartão). */
  onAddPaymentInfo(method: "pix" | "card", valueCents: number): void {
    trackPixel("AddPaymentInfo", { currency: "BRL", value: valueCents / 100, payment_type: method === "card" ? "cartao" : "pix" });
  },
};
