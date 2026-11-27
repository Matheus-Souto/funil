import { runAction } from "@/lib/actions/core";
import { handleIntegrationRequest } from "@/lib/apps/http";
import { createPayment } from "@/lib/apps/sessions";

export const dynamic = "force-dynamic";

/**
 * Sessão de pagamento de uma conta do app (chave `integration`): 201 `{ url, expira_em }` na sessão nova; 200 com a mesma
 * sessão quando o app repete a chamada (nova tentativa) em até 2 minutos.
 */
export const POST = (req: Request): Promise<Response> =>
  handleIntegrationRequest(req, async (call, body) => {
    const r = await runAction(createPayment, call, body);
    return { status: r.criado ? 201 : 200, body: { url: r.url, expira_em: r.expira_em } };
  });
