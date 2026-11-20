// Textos e regras de exibição do cartão que o app mostra (sem importar a cobrança, que só existe no serviço isolado).
// Módulo puro: vai também no editor de oferta (componente do navegador).
export const CARD_UNAVAILABLE_MESSAGE = "Pagamento por cartão indisponível no momento. Tente pagar com Pix.";

/** Painel e editor de oferta quando a instalação não tem o serviço de cartão (sem CARD_ORIGIN). */
export const CARD_SETUP_NOTICE =
  "Pagamento com cartão indisponível: falta configurar o serviço de cartão nesta instalação (docs/instalacao.md, seção 12). Enquanto isso, o checkout mostra só Pix.";

/** O painel avisa quando o serviço de cartão falta e alguma oferta ativa tem cartão (o comprador não o vê). */
export function cardSetupNoticeNeeded(cardOn: boolean, offers: readonly { methods: readonly string[]; active: boolean }[]): boolean {
  return !cardOn && offers.some((o) => o.active && o.methods.includes("card"));
}

/** Caixa "Cartão de crédito" do editor: sem o serviço, não liga (desligar continua possível) e diz por quê. */
export function cardToggle(cardOn: boolean, checked: boolean): { disabled: boolean; notice: string | null } {
  if (cardOn) return { disabled: false, notice: null };
  return { disabled: !checked, notice: CARD_SETUP_NOTICE };
}
