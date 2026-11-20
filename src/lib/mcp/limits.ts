// Limites que só valem para ator token (agente pelo MCP): o painel segue sem limite. Cada chamada conta, inclusive a
// que estoura. Chamado no `prepare` das ações, antes de qualquer efeito (rede, e-mail, fila).
import { ActionError, type Actor } from "@/lib/actions/core";
import { checkRateLimit } from "@/lib/payments/ratelimit";

const HOUR_SEC = 3600;
const DAY_SEC = 86_400;

export type LimitRule = { key: string; limit: number; windowSec: number };

/** Aplica as regras só quando o ator é token; a primeira que estourar vira `rate_limited` com `message`. */
export async function limitToken(actor: Actor, rules: LimitRule[], message: string): Promise<void> {
  if (actor.kind !== "token") return;
  for (const r of rules) {
    if (!(await checkRateLimit(r.key, r.limit, r.windowSec))) throw new ActionError("rate_limited", message);
  }
}

/** Testes de conexão (`connections.test*`): 5 por hora por loja e ação. */
export const limitConnectionTest = (actor: Actor, action: string, storeId: string) =>
  limitToken(actor, [{ key: `conntest:${action}:${storeId}`, limit: 5, windowSec: HOUR_SEC }], "Muitos testes de conexão. Espere um pouco e tente de novo.");

/**
 * Reenvio de acesso (`orders.resend`): 1 por pedido por hora, 3 por pedido em 24 h e 20 por loja por hora.
 * O UUID entra em minúsculas (o Zod e o Postgres aceitam qualquer caixa: sem isso, cada variante ganharia contador novo),
 * com a loja na chave e uma chave por janela (janelas que começam juntas não incrementam a mesma linha duas vezes).
 */
export const limitResend = (actor: Actor, storeId: string, orderId: string) => {
  const order = `${storeId}:${orderId.toLowerCase()}`;
  return limitToken(
    actor,
    [
      { key: `resend:order:h:${order}`, limit: 1, windowSec: HOUR_SEC },
      { key: `resend:order:d:${order}`, limit: 3, windowSec: DAY_SEC },
      { key: `resend:store:${storeId}`, limit: 20, windowSec: HOUR_SEC },
    ],
    "Muitos reenvios. Espere um pouco e tente de novo.",
  );
};
