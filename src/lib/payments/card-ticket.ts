// Bilhete assinado do pedido: o app emite quando o comprador escolhe cartão; o serviço de cartão confere.
// Formato: base64url(JSON {s,o,p,e,t,m[,c]}) + "." + base64url(HMAC-SHA256(corpo)). `e` = vencimento em segundos (epoch);
// `t` = total do pedido em centavos e `m` = parcelas máximas da oferta: o iframe lê os dois do corpo (sem a chave) e
// recusa pagar se o checkout mostrou outro total. `c: 1` (só presente quando vale): a loja aceita CNPJ no titular do
// cartão; o serviço `card` confia nisto porque está assinado (ele não lê `store.accept_cnpj`). A chave vem por parâmetro
// (CARD_TICKET_KEY); nada aqui lê o `env`.
import { createHmac, timingSafeEqual } from "node:crypto";

export const CARD_TICKET_TTL_MS = 30 * 60 * 1000;
/** Folga aceita no vencimento (relógios diferentes): `e` acima de now + TTL + isto é forjado. */
const FUTURE_SLACK_S = 60;
const MAX_TOKEN_LEN = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** HMAC-SHA256 em base64url sem padding: 32 bytes = 43 caracteres. Só a forma canônica vale (assinatura não maleável). */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
/** Mesmo formato do `publicId` dos pedidos (`randomToken` em base64url), com teto de 64. */
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface CardTicket {
  storeId: string;
  orderId: string;
  publicId: string;
  /** Total do pedido em centavos (com bump). */
  totalCents: number;
  /** Parcelas máximas da oferta (1 a 12). */
  maxInstallments: number;
  /** A loja aceita CNPJ no titular do cartão (ausente: só CPF). */
  acceptCnpj?: boolean;
}

const MAX_TOTAL_CENTS = 100_000_000; // o mesmo teto do `config` do protocolo do iframe
const intIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const sign = (payload: string, key: string): Buffer => createHmac("sha256", key).update(payload).digest();

export function issueCardTicket(t: CardTicket, key: string, now: Date = new Date()): string {
  if (!key) throw new Error("CARD_TICKET_KEY ausente");
  const e = Math.floor((now.getTime() + CARD_TICKET_TTL_MS) / 1000);
  if (!intIn(t.totalCents, 1, MAX_TOTAL_CENTS) || !intIn(t.maxInstallments, 1, 12)) throw new Error("bilhete: total ou parcelas fora do limite");
  const body = { s: t.storeId, o: t.orderId, p: t.publicId, e, t: t.totalCents, m: t.maxInstallments, ...(t.acceptCnpj ? { c: 1 } : {}) };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload, key).toString("base64url")}`;
}

/** Devolve o conteúdo se o bilhete é íntegro, válido e não vencido; `null` para qualquer defeito. */
export function verifyCardTicket(token: string, key: string, now: Date = new Date()): CardTicket | null {
  const r = verifyCardTicketDetailed(token, key, now);
  if (!r.ok) return null;
  const { storeId, orderId, publicId, totalCents, maxInstallments, acceptCnpj } = r;
  return { storeId, orderId, publicId, totalCents, maxInstallments, ...(acceptCnpj ? { acceptCnpj } : {}) };
}

export type CardTicketCheck = ({ ok: true } & CardTicket) | { ok: false; expired: boolean };

/**
 * Como `verifyCardTicket`, mas diz se a recusa foi só o vencimento: `expired: true` apenas com assinatura e conteúdo
 * válidos e `e` já passado (o checkout pede um bilhete novo). Forjado, malformado ou vencimento longe demais no
 * futuro dão `expired: false`: nada além disso é revelado.
 */
export function verifyCardTicketDetailed(token: string, key: string, now: Date = new Date()): CardTicketCheck {
  const r = inspect(token, key, now);
  if (r === null) return { ok: false, expired: false };
  if (r.e <= r.nowS) return { ok: false, expired: true };
  return { ok: true, ...r.ticket };
}

/** Quanto tempo depois de vencido um bilhete ainda serve para pedir outro (renovação no checkout). */
export const CARD_TICKET_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Conteúdo de um bilhete íntegro, válido ou vencido há no máximo `CARD_TICKET_RENEW_WINDOW_MS`: só para a renovação
 * (quem pede bilhete novo prova que já tinha um do mesmo pedido). Nunca serve para cobrar: o serviço usa
 * `verifyCardTicketDetailed`.
 */
export function verifyCardTicketForRenewal(token: string, key: string, now: Date = new Date()): CardTicket | null {
  const r = inspect(token, key, now);
  if (r === null) return null;
  if (r.e <= r.nowS - CARD_TICKET_RENEW_WINDOW_MS / 1000) return null;
  return r.ticket;
}

/** Assinatura, forma canônica e conteúdo conferidos; `null` para qualquer defeito. Não olha o vencimento passado. */
function inspect(token: string, key: string, now: Date): { ticket: CardTicket; e: number; nowS: number } | null {
  if (!key || typeof token !== "string" || token.length > MAX_TOKEN_LEN) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!payload || !SIGNATURE.test(sig)) return null;
  const given = Buffer.from(sig, "base64url");
  const expected = sign(payload, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (given.toString("base64url") !== sig) return null; // bits baixos do último caractere
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { s, o, p, e, t, m, c } = body as Record<string, unknown>;
  if (typeof s !== "string" || !UUID.test(s) || typeof o !== "string" || !UUID.test(o)) return null;
  if (typeof p !== "string" || !PUBLIC_ID.test(p)) return null;
  if (typeof e !== "number" || !Number.isInteger(e)) return null;
  if (!intIn(t, 1, MAX_TOTAL_CENTS) || !intIn(m, 1, 12)) return null;
  if (c !== undefined && c !== 1) return null;
  const nowS = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(nowS)) return null;
  if (e > nowS + CARD_TICKET_TTL_MS / 1000 + FUTURE_SLACK_S) return null;
  return { ticket: { storeId: s, orderId: o, publicId: p, totalCents: t, maxInstallments: m, ...(c === 1 ? { acceptCnpj: true } : {}) }, e, nowS };
}
