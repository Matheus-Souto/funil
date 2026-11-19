// Bilhete assinado do pedido: o app emite quando o comprador escolhe cartão; o serviço de cartão confere.
// Formato: base64url(JSON {s,o,p,e}) + "." + base64url(HMAC-SHA256(corpo)). `e` = vencimento em segundos (epoch).
// A chave vem por parâmetro (CARD_TICKET_KEY); nada aqui lê o `env`.
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
}

const sign = (payload: string, key: string): Buffer => createHmac("sha256", key).update(payload).digest();

export function issueCardTicket(t: CardTicket, key: string, now: Date = new Date()): string {
  if (!key) throw new Error("CARD_TICKET_KEY ausente");
  const e = Math.floor((now.getTime() + CARD_TICKET_TTL_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ s: t.storeId, o: t.orderId, p: t.publicId, e })).toString("base64url");
  return `${payload}.${sign(payload, key).toString("base64url")}`;
}

/** Devolve o conteúdo se o bilhete é íntegro, válido e não vencido; `null` para qualquer defeito. */
export function verifyCardTicket(token: string, key: string, now: Date = new Date()): CardTicket | null {
  const r = verifyCardTicketDetailed(token, key, now);
  return r.ok ? { storeId: r.storeId, orderId: r.orderId, publicId: r.publicId } : null;
}

export type CardTicketCheck = ({ ok: true } & CardTicket) | { ok: false; expired: boolean };

/**
 * Como `verifyCardTicket`, mas diz se a recusa foi só o vencimento: `expired: true` apenas com assinatura e conteúdo
 * válidos e `e` já passado (o checkout pede um bilhete novo). Forjado, malformado ou vencimento longe demais no
 * futuro dão `expired: false`: nada além disso é revelado.
 */
export function verifyCardTicketDetailed(token: string, key: string, now: Date = new Date()): CardTicketCheck {
  const no = { ok: false, expired: false } as const;
  if (!key || typeof token !== "string" || token.length > MAX_TOKEN_LEN) return no;
  const parts = token.split(".");
  if (parts.length !== 2) return no;
  const [payload, sig] = parts as [string, string];
  if (!payload || !SIGNATURE.test(sig)) return no;
  const given = Buffer.from(sig, "base64url");
  const expected = sign(payload, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return no;
  if (given.toString("base64url") !== sig) return no; // bits baixos do último caractere
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return no;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return no;
  const { s, o, p, e } = body as Record<string, unknown>;
  if (typeof s !== "string" || !UUID.test(s) || typeof o !== "string" || !UUID.test(o)) return no;
  if (typeof p !== "string" || !PUBLIC_ID.test(p)) return no;
  if (typeof e !== "number" || !Number.isInteger(e)) return no;
  const nowS = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(nowS)) return no;
  if (e > nowS + CARD_TICKET_TTL_MS / 1000 + FUTURE_SLACK_S) return no;
  if (e <= nowS) return { ok: false, expired: true };
  return { ok: true, storeId: s, orderId: o, publicId: p };
}
