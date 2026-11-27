// Configuração da conexão do app (`integration` kind `app_webhook`, campo `config`): URL do webhook, hosts de retorno
// (`returnHosts`, lidos pela sessão de pagamento para validar o `retorno`) e a origem pública do app (`publicOrigin`,
// `event_source_url` do StartTrial). Módulo leve de propósito (só o schema do banco): o envio do Meta e a sessão de
// pagamento o importam sem puxar o envio do webhook nem as ações. O segredo nunca passa por aqui.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/lib/db/client";
import { integration } from "@/lib/db/schema";

/** No máximo tantos hosts de retorno por loja. */
export const APP_RETURN_HOSTS_MAX = 10;

/**
 * Nome de host DNS com pelo menos um ponto e o último rótulo em letras (o que já recusa IPv4 e `localhost`): sem
 * esquema, porta, caminho nem espaço. Rótulos de 1 a 63 caracteres, sem hífen na ponta; até 253 no total.
 */
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const HOST_MESSAGE = "Host de retorno inválido: use só o nome (ex.: app.exemplo.com.br), sem https://, porta nem caminho.";

export const appReturnHostSchema = z.string().trim().toLowerCase().regex(HOST_RE, HOST_MESSAGE);

/** Lista de hosts de retorno: válidos, sem repetição (a ordem da primeira ocorrência), no máximo `APP_RETURN_HOSTS_MAX`. */
export const appReturnHostsSchema = z
  .array(appReturnHostSchema)
  .max(APP_RETURN_HOSTS_MAX, `No máximo ${APP_RETURN_HOSTS_MAX} hosts de retorno.`)
  .transform((hosts) => [...new Set(hosts)]);

const ORIGIN_MESSAGE = "Origem do app inválida: use só https://dominio (sem caminho, usuário nem parâmetros).";

/** Só a origem https (`https://host[:porta]`), sem credencial, caminho, busca nem fragmento; gravada sem a barra final. */
export const appPublicOriginSchema = z
  .string()
  .trim()
  .max(300)
  .transform((raw, ctx) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: ORIGIN_MESSAGE });
      return z.NEVER;
    }
    const onlyOrigin = u.pathname === "/" && u.search === "" && u.hash === "" && !/[?#]/.test(raw) && !/^https:\/\/[^/]+\/./i.test(raw);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || !onlyOrigin) {
      ctx.addIssue({ code: "custom", message: ORIGIN_MESSAGE });
      return z.NEVER;
    }
    return u.origin;
  });

export interface AppWebhookConfig {
  url?: string;
  returnHosts?: string[];
  publicOrigin?: string;
}

/** Lê o `config` da conexão (sem abrir o segredo) e devolve só os campos válidos. */
export function parseAppWebhookConfig(config: unknown): AppWebhookConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  const out: AppWebhookConfig = {};
  if (typeof c.url === "string") out.url = c.url;
  const hosts = appReturnHostsSchema.safeParse(c.returnHosts);
  if (hosts.success) out.returnHosts = hosts.data;
  const origin = typeof c.publicOrigin === "string" ? appPublicOriginSchema.safeParse(c.publicOrigin) : null;
  if (origin?.success) out.publicOrigin = origin.data;
  return out;
}

/** `config` da conexão `app_webhook` da loja (só a coluna `config`: o segredo selado nem é lido), ou `null`. */
export async function readAppWebhookConfig(tx: Tx, storeId: string): Promise<AppWebhookConfig | null> {
  const [row] = await tx
    .select({ config: integration.config })
    .from(integration)
    .where(and(eq(integration.storeId, storeId), eq(integration.kind, "app_webhook")));
  return row ? parseAppWebhookConfig(row.config) : null;
}
