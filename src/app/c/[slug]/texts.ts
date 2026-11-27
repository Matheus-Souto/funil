// Textos do checkout que dependem da loja (CPF ou CNPJ) e da entrega da oferta (PDF ou app). Puro: vai no bundle do
// navegador e é usado também pela server action.

/** Nome do documento pedido: CPF; na loja com `accept_cnpj`, CPF ou CNPJ. */
export const docLabel = (acceptCnpj: boolean): string => (acceptCnpj ? "CPF ou CNPJ" : "CPF");

/** Pix manual indisponível: pede o documento para gerar o Pix do Asaas (o mesmo rótulo do campo). */
export const needsDocMessage = (acceptCnpj: boolean): string =>
  `O Pix direto da loja está indisponível agora. Informe o ${docLabel(acceptCnpj)} para gerar o Pix automático.`;

/** Oferta de app: o funil não manda arquivo nem acesso por e-mail; quem libera é o app. */
export const APP_ACCESS_TEXT = "O acesso é liberado no app depois do pagamento.";

type Delivery = "download" | "app";

/** Linha abaixo do nome no resumo: "Inclui: …", "<produto> · PDF para baixar" ou, no app, o texto neutro. */
export const productSubtitle = (o: { delivery: Delivery; includes: string | null; productName: string }): string =>
  o.delivery === "app" ? APP_ACCESS_TEXT : (o.includes ?? `${o.productName} · PDF para baixar`);

/** Dica do e-mail: na oferta de download, é para ele que vai o acesso; no app, nada é prometido por e-mail. */
export const emailHint = (delivery: Delivery): string | undefined =>
  delivery === "app" ? undefined : "É para este e-mail que enviamos o seu acesso.";

/** Fim do aviso do Pix do Asaas: quando o banco confirma, o que acontece. */
export const pixConfirmedText = (delivery: Delivery): string =>
  delivery === "app" ? APP_ACCESS_TEXT : "Assim que o banco confirmar, o acesso chega no seu e-mail.";
