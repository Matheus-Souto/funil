// Textos do cupom num módulo puro (sem banco, sem React): o servidor (`checkout.ts`, `apply.ts`, `actions.ts`) e as
// telas do navegador (`coupon-logic.ts` no checkout, `coupons.tsx` no painel) importam daqui, então o texto que a ação
// devolve e o que a tela compara são o mesmo.

/** Mensagem neutra: nunca diz qual regra falhou (vencido, esgotado, outra oferta, já usado por esta pessoa...). */
export const COUPON_INVALID_MESSAGE = "Cupom inválido ou vencido";
/** `conflict` PRICE_CHANGED: o total recalculado difere do que o comprador viu. */
export const PRICE_CHANGED_MESSAGE = "O valor mudou: confira o resumo";
/** Limite de cupom (por IP ou o balde de recusas da loja). */
export const COUPON_LIMIT_MESSAGE = "Muitas tentativas de cupom. Aguarde alguns minutos e tente de novo.";
/** "Aplicar" com o campo vazio. */
export const COUPON_EMPTY_MESSAGE = "Digite o código do cupom.";
/** Falha de rede ou erro inesperado na prévia. */
export const COUPON_UNAVAILABLE_MESSAGE = "Não foi possível conferir o cupom agora. Tente de novo em instantes.";

// Painel (`coupons.*`)
/** `conflict`: o código já existe na loja (inclusive arquivado). */
export const COUPON_DUPLICATE_MESSAGE = "Já existe um cupom com este código";
/** `conflict`: renomear cupom com pedido mudaria o código no histórico (pedido, CSV, métricas, aviso). */
export const COUPON_USED_CODE_MESSAGE = "Este cupom já foi usado: crie outro código";
