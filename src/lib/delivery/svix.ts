// Verificação de assinatura no padrão Svix (usado pelo webhook do Resend). Só `node:crypto` (o app roda em Node).
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SEC = 5 * 60;

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

/** Assinatura `v1,<base64>` do conteúdo `${id}.${timestamp}.${corpo}` com a chave `whsec_<base64>`. */
export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/**
 * Vale se o timestamp está a no máximo 5 minutos do relógio (para frente ou para trás) e qualquer entrada `v1,<sig>`
 * do cabeçalho bate (comparação em tempo constante; comprimento diferente = falso, sem lançar).
 */
export function verifySvix(secret: string, headers: SvixHeaders, body: string, now: Date = new Date()): boolean {
  if (!/^\d+$/.test(headers.timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(headers.timestamp)) > TOLERANCE_SEC) return false;
  const expected = Buffer.from(svixSignature(secret, headers.id, headers.timestamp, body));
  let ok = false;
  for (const entry of headers.signature.split(" ")) {
    if (!entry.startsWith("v1,")) continue;
    const given = Buffer.from(entry.slice(3));
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}
