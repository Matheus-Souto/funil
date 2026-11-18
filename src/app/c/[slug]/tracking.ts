// Ganchos do Meta Pixel no checkout (Task 13): `InitiateCheckout` com o mesmo `eventId` enviado em `checkout.start`
// e `AddPaymentInfo` ao enviar o pagamento. Por enquanto não fazem nada (sem script de terceiros na página).
export const checkoutTracking = {
  onInitiateCheckout(eventId: string): void {
    void eventId;
  },
  onAddPaymentInfo(method: "pix" | "card"): void {
    void method;
  },
};
