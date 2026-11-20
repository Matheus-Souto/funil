// Conexão do Telegram da loja (o bot é da loja; a plataforma não fornece nenhum): dados e ações. Config público
// `{ chatId, botUsername, tokenLast4, events, abandonAfterMinutes }`; segredo selado = só o token do bot. Rede (getMe e
// envio de teste) só no `prepare`, fora da transação. Erro do Telegram vira `provider_error` com o texto fixo.
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { withStore, type Tx } from "@/lib/db/client";
import { integration, store, storeAlert } from "@/lib/db/schema";
import { oneLine } from "@/lib/delivery/templates";
import { IntegrationSecretUnreadable, getIntegration, readIntegration, saveIntegration, type IntegrationConfig } from "@/lib/integrations";
import { log } from "@/lib/log";
import { limitConnectionTest } from "@/lib/mcp/limits";
import { TELEGRAM_CHAT_RE, TELEGRAM_TOKEN_RE, TelegramError, cutChars, telegramGetMe, telegramSend } from "./telegram";

export interface TelegramEvents {
  sale: boolean;
  pixGenerated: boolean;
  cardDeclined: boolean;
  abandoned: boolean;
}

export const DEFAULT_TELEGRAM_EVENTS: TelegramEvents = { sale: true, pixGenerated: false, cardDeclined: false, abandoned: false };
export const DEFAULT_ABANDON_MINUTES = 30;
export const MIN_ABANDON = 10;
export const MAX_ABANDON = 1440;

/** Config guardada com os padrões nos campos ausentes ou inválidos. */
export function parseTelegramConfig(c: IntegrationConfig | undefined): { chatId: string | null; botUsername: string | null; events: TelegramEvents; abandonAfterMinutes: number } {
  const raw = (c ?? {}) as Record<string, unknown>;
  const ev = (raw.events ?? {}) as Record<string, unknown>;
  const flag = (k: keyof TelegramEvents) => (typeof ev[k] === "boolean" ? (ev[k] as boolean) : DEFAULT_TELEGRAM_EVENTS[k]);
  const m = raw.abandonAfterMinutes;
  return {
    chatId: typeof raw.chatId === "string" ? raw.chatId : null,
    botUsername: typeof raw.botUsername === "string" ? raw.botUsername : null,
    events: { sale: flag("sale"), pixGenerated: flag("pixGenerated"), cardDeclined: flag("cardDeclined"), abandoned: flag("abandoned") },
    abandonAfterMinutes: typeof m === "number" && Number.isInteger(m) && m >= MIN_ABANDON && m <= MAX_ABANDON ? m : DEFAULT_ABANDON_MINUTES,
  };
}

/**
 * Conexão Telegram da loja. `null` sem conexão ou com o segredo ilegível (SECRET trocado): o aviso vira "não
 * configurado" e o painel mostra "ilegível". Outros erros propagam.
 */
export async function loadTelegram(
  tx: Tx,
  storeId: string,
): Promise<{ token: string; chatId: string; events: TelegramEvents; abandonAfterMinutes: number } | null> {
  let conn: Awaited<ReturnType<typeof getIntegration>>;
  try {
    conn = await getIntegration(tx, storeId, "telegram");
  } catch (e) {
    if (!(e instanceof IntegrationSecretUnreadable)) throw e;
    log.warn("segredo da conexão não pode ser aberto", { storeId, kind: "telegram" });
    return null;
  }
  if (!conn?.secret) return null;
  const { chatId, events, abandonAfterMinutes } = parseTelegramConfig(conn.config);
  if (!chatId) return null;
  return { token: conn.secret, chatId, events, abandonAfterMinutes };
}

/** Só a config pública (sem abrir o segredo): usada ao criar o pedido, para decidir o que enfileirar. */
export async function telegramSettings(tx: Tx, storeId: string): Promise<{ events: TelegramEvents; abandonAfterMinutes: number } | null> {
  const [r] = await tx
    .select({ config: integration.config })
    .from(integration)
    .where(and(eq(integration.storeId, storeId), eq(integration.kind, "telegram")));
  if (!r) return null;
  const { events, abandonAfterMinutes } = parseTelegramConfig(r.config as IntegrationConfig);
  return { events, abandonAfterMinutes };
}

/** Confirma o aviso `telegram_falhou` aberto da loja: o vendedor corrigiu a conexão (teste ok, token ou chat id novos). */
async function ackTelegramAlert(tx: Tx, storeId: string): Promise<void> {
  await tx
    .update(storeAlert)
    .set({ acknowledgedAt: sql`now()` })
    .where(and(eq(storeAlert.storeId, storeId), eq(storeAlert.kind, "telegram_falhou"), isNull(storeAlert.acknowledgedAt)));
}

function providerError(e: unknown): never {
  if (e instanceof TelegramError) throw new ActionError("provider_error", e.message, { status: e.httpStatus });
  throw e;
}

export const saveTelegram = defineAction({
  name: "connections.saveTelegram",
  description: "Conecta o bot do Telegram da loja (chat id e token do @BotFather): campo omitido mantém o valor guardado.",
  input: z.object({
    chatId: z.string().trim().regex(TELEGRAM_CHAT_RE, "Chat id inválido"),
    /** Omitido: mantém o token guardado. */
    token: z.string().trim().regex(TELEGRAM_TOKEN_RE, "Token do bot inválido").optional(),
    events: z.object({ sale: z.boolean(), pixGenerated: z.boolean(), cardDeclined: z.boolean(), abandoned: z.boolean() }).partial().optional(),
    abandonAfterMinutes: z.number().int().min(MIN_ABANDON).max(MAX_ABANDON).optional(),
  }),
  permission: "connections.write",
  // Quem controla o chat recebe os números da loja: MCP/IA precisam de aprovação.
  sensitive: true,
  auditInput: (i) => ({
    chatId: i.chatId,
    events: i.events ?? null,
    abandonAfterMinutes: i.abandonAfterMinutes ?? null,
    token: i.token ? "[novo]" : "[mantido]",
  }),
  // Rede fora da transação, e só com token novo: sem ele, o token guardado já foi validado ao ser salvo.
  async prepare(_call, input) {
    if (!input.token) return null;
    try {
      return await telegramGetMe(input.token);
    } catch (e) {
      return providerError(e);
    }
  },
  async run(ctx, input, me) {
    const stored = await readIntegration(ctx.tx, ctx.storeId, "telegram");
    const token = input.token ?? stored?.secret ?? null;
    if (!token) {
      // Segredo guardado que não abre (SECRET trocado): pede o token de novo em vez de mantê-lo em silêncio.
      const message = stored?.unreadable ? "O token guardado não pode ser lido: cole o token do bot de novo." : "Informe o token do bot do Telegram.";
      throw new ActionError("invalid_input", message, [{ path: ["token"], message }]);
    }
    const prev = parseTelegramConfig(stored?.config);
    const config = {
      chatId: input.chatId,
      botUsername: me?.username ?? prev.botUsername,
      tokenLast4: token.slice(-4),
      events: { ...prev.events, ...stripUndefined(input.events ?? {}) },
      abandonAfterMinutes: input.abandonAfterMinutes ?? prev.abandonAfterMinutes,
    };
    await saveIntegration(ctx.tx, ctx.storeId, "telegram", config, token);
    // Token ou chat id novos (já conferido no getMe, se token): o aviso de falha antiga deixa de valer.
    if (input.token || input.chatId !== prev.chatId) await ackTelegramAlert(ctx.tx, ctx.storeId);
    return config;
  },
});

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const testTelegram = defineAction({
  name: "connections.testTelegram",
  description: "Envia uma mensagem de teste ao chat do Telegram da loja.",
  input: z.object({}),
  permission: "connections.write",
  async prepare(call) {
    await limitConnectionTest(call.actor, "testTelegram", call.storeId);
    const { conn, storeName } = await withStore(call.storeId, async (tx) => {
      const [s] = await tx.select({ name: store.name }).from(store).where(eq(store.id, call.storeId));
      return { conn: await loadTelegram(tx, call.storeId), storeName: s?.name ?? "" };
    });
    if (!conn) throw new ActionError("provider_error", "Telegram não configurado");
    try {
      await telegramSend(conn.token, conn.chatId, `Teste do funil: os avisos da ${cutChars(oneLine(storeName), 100) || "sua loja"} vão chegar aqui.`);
    } catch (e) {
      providerError(e);
    }
    return true;
  },
  async run(ctx) {
    // O teste chegou ao chat: o aviso de falha aberto já não vale.
    await ackTelegramAlert(ctx.tx, ctx.storeId);
    return { sent: true };
  },
});

export const removeTelegram = defineAction({
  name: "connections.removeTelegram",
  description: "Remove a conexão do Telegram da loja.",
  input: z.object({}),
  permission: "connections.write",
  // Desliga os avisos da loja: MCP/IA precisam de aprovação.
  sensitive: true,
  async run(ctx) {
    const removed = await ctx.tx
      .delete(integration)
      .where(and(eq(integration.storeId, ctx.storeId), eq(integration.kind, "telegram")))
      .returning({ kind: integration.kind });
    return { removed: removed.length > 0 };
  },
});
