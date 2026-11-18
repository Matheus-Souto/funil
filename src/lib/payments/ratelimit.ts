// Limites contra teste de cartão. IP e e-mail ficam no Postgres (`rate_limit`, sem RLS, global entre lojas);
// a impressão digital do cartão fica SÓ em memória (Map com expiração) e nunca é persistida nem logada.
import { createHmac } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateLimit } from "@/lib/db/schema";
import { env } from "@/lib/env";

/** Janela fixa alinhada ao relógio. */
function windowStart(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Soma 1 ao contador de `key` na janela fixa atual (INSERT ... ON CONFLICT DO UPDATE ... RETURNING, atômico)
 * e devolve se ainda está dentro do limite. A chamada que estoura também conta.
 */
export async function checkRateLimit(key: string, limit: number, windowSec: number, now: Date = new Date()): Promise<boolean> {
  const count = await bump(key, windowStart(now, windowSec));
  maybeCleanup(now);
  return count <= limit;
}

async function bump(key: string, start: Date): Promise<number> {
  const [row] = await db
    .insert(rateLimit)
    .values({ key, windowStart: start, count: 1 })
    .onConflictDoUpdate({ target: [rateLimit.key, rateLimit.windowStart], set: { count: sql`${rateLimit.count} + 1` } })
    .returning({ count: rateLimit.count });
  return row!.count;
}

const EVENT_SLICE_SEC = 60;

/** Registra um evento (ex.: recusa de cartão de um IP) em fatias de 1 minuto. */
export async function recordEvent(key: string, now: Date = new Date()): Promise<void> {
  await bump(key, windowStart(now, EVENT_SLICE_SEC));
}

/** Houve evento de `key` nos últimos `withinSec` segundos? (janela deslizante, precisão de 1 min) */
export async function hadRecentEvent(key: string, withinSec: number, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - withinSec * 1000);
  const rows = await db
    .select({ key: rateLimit.key })
    .from(rateLimit)
    .where(and(eq(rateLimit.key, key), gt(rateLimit.windowStart, since)))
    .limit(1);
  return rows.length > 0;
}

// Linhas antigas não servem para nada: limpeza ocasional (1 a cada ~200 chamadas), melhor esforço.
const KEEP_MS = 24 * 60 * 60 * 1000;
function maybeCleanup(now: Date): void {
  if (Math.random() >= 0.005) return;
  void db
    .delete(rateLimit)
    .where(lt(rateLimit.windowStart, new Date(now.getTime() - KEEP_MS)))
    .catch(() => undefined);
}

// ---- Impressão digital do cartão (memória do processo) ----

const MAX_ENTRIES = 100_000;
const fingerprints = new Map<string, { count: number; resetAt: number }>();

/** HMAC-SHA256(SECRET, número só com dígitos): não reversível sem o SECRET. */
function fingerprint(number: string): string {
  return createHmac("sha256", env.SECRET).update(number.replace(/\D/g, "")).digest("base64url");
}

/** Conta uma tentativa do cartão e devolve se ainda está dentro do limite (janela de `windowSec` a partir da 1ª). */
export function checkCardFingerprint(number: string, limit: number, windowSec: number, nowMs: number = Date.now()): boolean {
  const key = fingerprint(number);
  let entry = fingerprints.get(key);
  if (!entry || entry.resetAt <= nowMs) {
    if (fingerprints.size >= MAX_ENTRIES) prune(nowMs);
    entry = { count: 0, resetAt: nowMs + windowSec * 1000 };
    fingerprints.set(key, entry);
  }
  entry.count++;
  return entry.count <= limit;
}

function prune(nowMs: number): void {
  for (const [k, v] of fingerprints) if (v.resetAt <= nowMs) fingerprints.delete(k);
  // Ainda cheio (ataque com muitos cartões): descarta os mais antigos (ordem de inserção do Map).
  for (const k of fingerprints.keys()) {
    if (fingerprints.size < MAX_ENTRIES) break;
    fingerprints.delete(k);
  }
}

/** Só para testes. */
export function resetCardFingerprintsForTests(): void {
  fingerprints.clear();
}
