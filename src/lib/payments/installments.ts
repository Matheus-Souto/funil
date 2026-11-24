// Parcelas do cartão pelo total do pedido. Puro e sem imports de servidor: o checkout (navegador) e o servidor usam a mesma conta.

/** Parcela mínima do Asaas no cartão: R$ 5,00 (o editor da oferta avisa o mesmo valor). */
export const MIN_INSTALLMENT_CENTS = 500;

/**
 * Parcelas que o pedido aceita. Sem desconto: o máximo da oferta, exatamente como configurado (o editor da oferta já
 * avisa da parcela mínima). Com desconto de cupom (`discounted`): o máximo da oferta, limitado para nenhuma parcela
 * ficar abaixo de R$ 5,00 sobre o total do PEDIDO (com desconto). Ex.: R$ 22,00 com cupom numa oferta de até 5x -> 4x;
 * R$ 9,90 sem cupom numa oferta de até 3x -> 3x (Ruling R-V1).
 */
export function installmentsFor(offerMax: number, totalCents: number, opts: { discounted: boolean }): number {
  if (!opts.discounted) return offerMax;
  return Math.min(offerMax, Math.max(1, Math.floor(totalCents / MIN_INSTALLMENT_CENTS)));
}
