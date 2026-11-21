// Chaves do `rate_limit` que o cartão (asaas/card.ts) grava e a varredura da recuperação de vendas lê. Ficam num módulo
// à parte, sem dependências: o app (worker) não pode importar o módulo da cobrança, que só existe no serviço de cartão
// isolado (tests/next-bundle.test.ts).

/** Recusas de cartão por IP; `ipKey` = `ipRateKey(ip)` (IPv6 agrupado por /64). */
export const cardDeclineIpKey = (ipKey: string): string => `card:decline:ip:${ipKey}`;

/** Disparo do disjuntor de cartão da loja. */
export const cardBreakerKey = (storeId: string): string => `card:breaker:store:${storeId}`;
