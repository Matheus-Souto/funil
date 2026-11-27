// Conexão do app no painel (cartão "App (integração)" em Conexões, §7.6): URL do webhook de saída, hosts de retorno,
// origem pública do app, segredo da assinatura e o botão "Enviar teste" (`ping`).
//
// O segredo é gerado aqui (nunca digitado), selado na conexão `app_webhook` e devolvido UMA vez: na primeira gravação
// (`saveAppWebhook`) e a cada rotação. Depois o painel só mostra "configurado". Nunca vai para log, auditoria, URL nem
// MCP. As três ações ficam fora do MCP (`MCP_EXCLUDED`): as duas que devolvem o segredo não podem passar pela fila de
// aprovação (o pedido e a resposta ficariam ao alcance do agente), e o teste só faz sentido junto da configuração.
// Desvio consciente do §7.9, que previa a fila; `sensitive: true` continua valendo no painel (e barra qualquer token).
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { randomToken } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { readIntegration, saveIntegration, type IntegrationConfig } from "@/lib/integrations";
import { limitConnectionTest } from "@/lib/mcp/limits";
import { checkRateLimit } from "@/lib/payments/ratelimit";
import { appPublicOriginSchema, appReturnHostsSchema, parseAppWebhookConfig } from "./config";
import { appWebhookDestinationProblem, sendAppWebhook } from "./webhook";

const URL_MAX = 2000;
/** "Enviar teste" pelo painel também tem teto (o MCP nem chega aqui): por loja, por minuto. */
const TEST_LIMIT = 10;
const TEST_WINDOW_SEC = 60;

/**
 * Serializa, por loja, quem lê e grava a conexão do app (gravar, girar o segredo): duas primeiras gravações ao mesmo
 * tempo não geram dois segredos (a segunda espera e já encontra o da primeira). Trava da transação, solta no fim dela.
 */
const lockAppConnection = (tx: Tx, storeId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"app_webhook:" + storeId}, 0))`);

const invalid = (field: string, message: string) => new ActionError("invalid_input", message, [{ path: [field], message, code: "custom" }]);

/**
 * Confere a URL do webhook antes de gravar, com a MESMA regra do envio (`appWebhookDestinationAllowed`: `https`, sem
 * credencial e todos os endereços do nome públicos). As mensagens só citam o motivo, nunca a URL.
 */
async function checkWebhookUrl(raw: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw invalid("url", "URL do webhook inválida: use https://seu-app/caminho.");
  }
  if (u.username !== "" || u.password !== "") throw invalid("url", "Tire usuário e senha da URL do webhook: o funil assina cada aviso com o segredo.");
  if (u.hash !== "") throw invalid("url", "A URL do webhook não pode ter # (fragmento).");
  const problem = await appWebhookDestinationProblem(u.toString());
  if (problem !== null) {
    if (u.protocol !== "https:") throw invalid("url", "Use uma URL https:// para o webhook do app.");
    if (problem === "unresolved") throw invalid("url", "O endereço do webhook não foi encontrado (DNS): confira o domínio.");
    throw invalid("url", "O endereço do webhook precisa ser público na internet (não vale IP local, privado ou interno).");
  }
  return u.toString();
}

/** Só a origem da URL para a auditoria: o caminho pode carregar uma credencial do app. */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "[inválida]";
  }
};

export const saveAppWebhook = defineAction({
  name: "connections.saveAppWebhook",
  description:
    "Configura o webhook do app (URL https pública), os hosts de retorno do checkout e a origem pública do app. Na primeira gravação gera o segredo da assinatura e o devolve uma única vez.",
  input: z.object({
    url: z.string().trim().min(1, "Informe a URL do webhook do app.").max(URL_MAX, "URL do webhook longa demais."),
    /** Omitido: mantém a lista guardada; `[]` apaga. */
    returnHosts: appReturnHostsSchema.optional(),
    /** Omitida: mantém a guardada; `null` apaga. */
    publicOrigin: appPublicOriginSchema.nullable().optional(),
  }),
  permission: "connections.write",
  // Quem controla a URL controla para onde vão os avisos de pagamento; o segredo sai na resposta.
  sensitive: true,
  auditInput: (i) => ({
    url: originOf(i.url),
    returnHosts: i.returnHosts ?? "[mantido]",
    publicOrigin: i.publicOrigin === undefined ? "[mantido]" : i.publicOrigin,
  }),
  // A resolução de nomes (rede) fica fora da transação.
  prepare: async (_call, input) => ({ url: await checkWebhookUrl(input.url) }),
  async run(ctx, input, { url }) {
    await lockAppConnection(ctx.tx, ctx.storeId);
    const current = await readIntegration(ctx.tx, ctx.storeId, "app_webhook");
    const prev = parseAppWebhookConfig(current?.config);
    const returnHosts = input.returnHosts ?? prev.returnHosts ?? [];
    const publicOrigin = input.publicOrigin === undefined ? (prev.publicOrigin ?? null) : input.publicOrigin;
    const config: IntegrationConfig = { url, returnHosts, ...(publicOrigin ? { publicOrigin } : {}) };
    // Sem segredo (primeira vez) ou com um que não abre mais (SECRET trocado): gera outro e o mostra agora.
    const secret = current?.secret ? undefined : randomToken(32);
    await saveIntegration(ctx.tx, ctx.storeId, "app_webhook", config, secret);
    return { url, returnHosts, publicOrigin, ...(secret ? { secret } : {}) };
  },
  auditResult: (o) => ({ secret: o.secret ? "[novo]" : "[mantido]" }),
});

export const rotateAppWebhookSecret = defineAction({
  name: "connections.rotateAppWebhookSecret",
  description: "Gera um segredo novo para a assinatura do webhook do app (o anterior para de valer na hora) e o devolve uma única vez.",
  input: z.object({}),
  permission: "connections.write",
  sensitive: true,
  async run(ctx) {
    await lockAppConnection(ctx.tx, ctx.storeId);
    const current = await readIntegration(ctx.tx, ctx.storeId, "app_webhook");
    if (!current || typeof current.config.url !== "string") throw new ActionError("conflict", "Configure o webhook do app antes de gerar um segredo.");
    const secret = randomToken(32);
    await saveIntegration(ctx.tx, ctx.storeId, "app_webhook", current.config, secret);
    return { secret };
  },
  auditResult: () => ({ secret: "[novo]" }),
});

const REASON_TEXT: Record<string, string> = {
  blocked: "o endereço do webhook não é público",
  network: "falha de rede ao chamar o app",
  timeout: "o app não respondeu em 10 segundos",
};

export const testAppWebhook = defineAction({
  name: "connections.testAppWebhook",
  description: "Envia um evento de teste (ping) assinado ao webhook do app e devolve o código HTTP da resposta.",
  input: z.object({}),
  permission: "connections.write",
  // O envio (rede) acontece aqui, fora da transação; `run` só devolve o código.
  async prepare(call) {
    await limitConnectionTest(call.actor, "testAppWebhook", call.storeId);
    if (!(await checkRateLimit(`apptest:${call.storeId}`, TEST_LIMIT, TEST_WINDOW_SEC))) {
      throw new ActionError("rate_limited", "Muitos testes seguidos. Espere um minuto e tente de novo.");
    }
    const conn = await withStore(call.storeId, (tx) => readIntegration(tx, call.storeId, "app_webhook"));
    const url = typeof conn?.config.url === "string" ? conn.config.url : null;
    if (!url) throw new ActionError("conflict", "Configure o webhook do app antes de testar.");
    if (!conn?.secret) throw new ActionError("conflict", "O segredo do webhook não pode ser lido: gere um segredo novo antes de testar.");
    const id = `evt_${randomBytes(16).toString("hex")}`;
    const body = JSON.stringify({ id, tipo: "ping", criado_em: new Date().toISOString(), dados: {} });
    const r = await sendAppWebhook({ url, secret: conn.secret }, { id, body });
    if (r.ok) return { httpStatus: r.httpStatus! };
    if (r.httpStatus !== null) throw new ActionError("provider_error", `O app não respondeu com 2xx (HTTP ${r.httpStatus})`);
    throw new ActionError("provider_error", `O app não respondeu: ${REASON_TEXT[r.reason] ?? "falha ao chamar o app"}.`);
  },
  run: async (_ctx, _input, sent) => ({ httpStatus: sent.httpStatus }),
});
