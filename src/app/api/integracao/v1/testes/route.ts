import { runAction } from "@/lib/actions/core";
import { handleIntegrationRequest } from "@/lib/apps/http";
import { registerTrial } from "@/lib/apps/trials";

export const dynamic = "force-dynamic";

/** Início do teste de uma conta do app (chave `integration`): 201 `{ id }` se novo, 200 `{ id }` se já existia. */
export const POST = (req: Request): Promise<Response> =>
  handleIntegrationRequest(req, async (call, body) => {
    const r = await runAction(registerTrial, call, body);
    return { status: r.criado ? 201 : 200, body: { id: r.id } };
  });
