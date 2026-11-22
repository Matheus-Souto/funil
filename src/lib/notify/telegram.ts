// Cliente da Bot API do Telegram (aviso da loja no Telegram da própria loja; o bot é da loja, a plataforma não fornece
// nenhum). Destino fixo (`api.telegram.org`): sem host configurável pela loja, logo sem SSRF (o env só aceita
// `TELEGRAM_BASE_URL` em loopback, para o Telegram falso do smoke). O token vai no CAMINHO da URL, então
// a URL nunca vai a log nem a erro e o erro original do `fetch` é sempre descartado (a mensagem pode conter a URL).
// Só o status HTTP e o `error_code` do Telegram são registrados; o texto do provedor nunca. Nada aqui toca o banco.
import { oneLine } from "@/lib/delivery/templates";
import { brl } from "@/lib/format";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import type { OrderMethod } from "@/lib/orders/labels";

const API = "https://api.telegram.org";
const apiBase = () => (env.TELEGRAM_BASE_URL ?? API).replace(/\/+$/, "");
/** Curto: o worker é serial, e um Telegram lento não deve prender os outros jobs. */
const TIMEOUT_MS = 5_000;
/** Limite de leitura do corpo de erro (só o `error_code` interessa). */
const MAX_BODY = 4096;
const MAX_NAME = 100;
const MAX_MESSAGE = 1000;

export const TELEGRAM_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,60}$/;
export const TELEGRAM_CHAT_RE = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

export type TelegramEvent = "sale" | "pix_generated" | "card_declined" | "abandoned" | "lead_abandoned";

const ERRORS = {
  token: "O Telegram recusou o token do bot. Confira o token no @BotFather.",
  chat: "O Telegram não encontrou o chat ou o bot não está nele. Adicione o bot ao grupo e confira o chat id.",
  temporary: "Não foi possível falar com o Telegram agora. Tente de novo em instantes.",
} as const;
const MIGRATED = "O grupo virou supergrupo e mudou de id. Salve o id novo (começa com -100).";

/**
 * Falha do Telegram. Leva só o tipo, o status HTTP (0 = rede/timeout) e se o chat migrou (grupo que virou supergrupo:
 * o Telegram responde 400 com `parameters.migrate_to_chat_id`, cujo valor nunca é guardado); a mensagem é fixa.
 */
export class TelegramError extends Error {
  readonly migrated: boolean;
  constructor(
    readonly kind: "token" | "chat" | "temporary",
    readonly httpStatus: number,
    migrated = false,
  ) {
    const isMigrated = migrated && kind === "chat";
    super(isMigrated ? MIGRATED : ERRORS[kind]);
    this.name = "TelegramError";
    this.migrated = isMigrated;
  }
}

let fetchOverride: typeof fetch | undefined;
/** Testes: troca o `fetch` usado com o Telegram (sem argumento volta ao normal). */
export function setTelegramFetchForTests(f?: typeof fetch): void {
  fetchOverride = f;
}

/** 401/404: token; 400/403: chat (inexistente, virou supergrupo, bot bloqueado ou removido); o resto é temporário. */
function kindFor(status: number): TelegramError["kind"] {
  if (status === 401 || status === 404) return "token";
  if (status === 400 || status === 403) return "chat";
  return "temporary";
}

/**
 * Lê até `MAX_BODY` bytes do corpo e devolve o `error_code` numérico, se houver, e se há `parameters.migrate_to_chat_id`
 * (só a presença: o id novo não é guardado nem registrado). O resto do corpo é descartado.
 */
async function errorInfoOf(res: Response): Promise<{ errorCode: number | null; migrated: boolean }> {
  const none = { errorCode: null, migrated: false };
  try {
    const reader = res.body?.getReader();
    if (!reader) return none;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY));
    const body = JSON.parse(text) as { error_code?: unknown; parameters?: { migrate_to_chat_id?: unknown } | null } | null;
    const code = body?.error_code;
    const to = body?.parameters?.migrate_to_chat_id;
    return { errorCode: typeof code === "number" ? code : null, migrated: typeof to === "number" || typeof to === "string" };
  } catch {
    return none;
  }
}

async function call(token: string, method: "getMe" | "sendMessage", payload: unknown, signalIn?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = signalIn ? AbortSignal.any([signalIn, timeout]) : timeout;
  let res: Response;
  try {
    res = await (fetchOverride ?? fetch)(`${apiBase()}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
      // Destino fixo: um redirecionamento levaria o token (no caminho) a outro host.
      redirect: "error",
    });
  } catch {
    // Nunca repassa o erro da rede: a mensagem do runtime pode trazer a URL, e a URL tem o token.
    log.warn("Telegram recusou a requisição", { httpStatus: 0, errorCode: null });
    throw new TelegramError("temporary", 0);
  }
  if (!res.ok) {
    const { errorCode, migrated } = await errorInfoOf(res);
    log.warn("Telegram recusou a requisição", { httpStatus: res.status, errorCode, migrated });
    throw new TelegramError(kindFor(res.status), res.status, migrated);
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; result?: unknown } | null;
  if (body?.ok !== true) {
    log.warn("Telegram recusou a requisição", { httpStatus: res.status, errorCode: null });
    throw new TelegramError("temporary", res.status);
  }
  return body.result;
}

/** Confere o token e devolve o username do bot. */
export async function telegramGetMe(token: string, opts: { signal?: AbortSignal } = {}): Promise<{ username: string }> {
  const r = (await call(token, "getMe", {}, opts.signal)) as { username?: unknown } | null;
  if (typeof r?.username !== "string" || !r.username) {
    log.warn("Telegram recusou a requisição", { httpStatus: 200, errorCode: null });
    throw new TelegramError("temporary", 200);
  }
  return { username: r.username };
}

/** Envia texto puro (sem `parse_mode`, sem pré-visualização de link). */
export async function telegramSend(token: string, chatId: string, text: string, opts: { signal?: AbortSignal } = {}): Promise<{ messageId: number }> {
  const r = (await call(token, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } }, opts.signal)) as {
    message_id?: unknown;
  } | null;
  if (typeof r?.message_id !== "number") {
    log.warn("Telegram recusou a requisição", { httpStatus: 200, errorCode: null });
    throw new TelegramError("temporary", 200);
  }
  return { messageId: r.message_id };
}

const METHOD_TEXT: Record<OrderMethod, string> = { pix_asaas: "Pix", pix_manual: "Pix manual", card_asaas: "Cartão" };
/** Os primeiros `max` caracteres (code points: nunca corta um emoji ao meio). */
export const cutChars = (v: string, max: number) => Array.from(v).slice(0, max).join("");
const name = (v: string) => cutChars(oneLine(v), MAX_NAME);

/** Código curto do contato (6 primeiros hex do UUID sem hífen, maiúsculos): identifica o contato no aviso sem expor dado dele. */
export const leadCode = (id: string): string => id.replace(/-/g, "").slice(0, 6).toUpperCase();

/**
 * Texto do aviso: só dados da venda (produto, valor, forma e código do pedido). Nunca nome, e-mail, CPF ou telefone do
 * comprador, nem link. Texto puro: nomes em uma linha, até 100 caracteres cada, mensagem até 1.000.
 * `lead_abandoned` (contato que não chegou a criar pedido): `orderCode` leva o `leadCode` e a forma de pagamento não existe
 * (`method` é ignorado e pode faltar); nos demais eventos `method` é obrigatório.
 */
export function telegramMessage(
  event: TelegramEvent,
  s: { productName: string; bumpName: string | null; totalCents: number; method?: OrderMethod; orderCode: string; abandonAfterMinutes?: number },
): string {
  const items = s.bumpName ? `${name(s.productName)} + ${name(s.bumpName)}` : name(s.productName);
  const value = brl(s.totalCents);
  const how = () => {
    if (!s.method) throw new Error("telegramMessage: forma de pagamento ausente");
    return METHOD_TEXT[s.method];
  };
  const order = `pedido #${s.orderCode}`;
  let text: string;
  switch (event) {
    case "sale":
      text = `Venda: ${items} — ${value} — ${how()} — ${order}`;
      break;
    case "pix_generated":
      text = `Pix gerado: ${items} — ${value} — ${order}`;
      break;
    case "card_declined":
      text = `Cartão recusado: ${items} — ${value} — ${order}`;
      break;
    case "abandoned":
      text = `Carrinho abandonado (${s.abandonAfterMinutes ?? 30} min sem pagamento): ${items} — ${value} — ${how()} — ${order}`;
      break;
    case "lead_abandoned":
      text = `Abandono antes do pagamento (${s.abandonAfterMinutes ?? 30} min): ${items} — ${value} — contato #${s.orderCode}`;
      break;
  }
  return cutChars(text, MAX_MESSAGE);
}
