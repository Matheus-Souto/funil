import { ActionError } from "@/lib/actions/core";
import { env } from "@/lib/env";
import { isPanelHost, resolveStore } from "@/lib/stores";
import { login, loginOnPanelHost } from "./session";

export type LoginHostOptions = { mode: "single" | "multi"; platformDomain?: string; baseUrl: string };

/**
 * Login pelo host da requisição. Host de loja: entra nela (vale mesmo que o host também seja o do BASE_URL, caso de
 * quem passou de `single` mantendo o domínio do checkout). Host do painel da plataforma (MODE=multi, BASE_URL que não é
 * loja): entra numa loja da pessoa (`loginOnPanelHost`). Qualquer outro host: `null`, sem consulta de credenciais.
 * Credencial errada também dá `null`: quem chama mostra o mesmo erro genérico.
 */
export async function loginForHost(
  host: string,
  credentials: { email: string; password: string },
  opts: LoginHostOptions = { mode: env.MODE, platformDomain: env.PLATFORM_DOMAIN, baseUrl: env.BASE_URL },
): Promise<string | null> {
  const found = await resolveStore(host, { mode: opts.mode, platformDomain: opts.platformDomain });
  if (!found && !isPanelHost(host, { mode: opts.mode, baseUrl: opts.baseUrl })) return null;
  try {
    return found ? await login({ ...credentials, storeId: found.id }) : await loginOnPanelHost(credentials);
  } catch (e) {
    if (e instanceof ActionError) return null;
    throw e;
  }
}
