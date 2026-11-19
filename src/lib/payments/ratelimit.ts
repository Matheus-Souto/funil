// Limites contra teste de cartão. IP e e-mail ficam no Postgres (`rate_limit`, sem RLS, global entre lojas);
// a impressão digital do cartão fica SÓ em memória (Map com expiração) e nunca é persistida nem logada.
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db, type Db, type Tx } from "@/lib/db/client";
import { rateLimit } from "@/lib/db/schema";
import { env } from "@/lib/env";

/** Janela fixa alinhada ao relógio. */
function windowStart(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Onde o contador é gravado: o pool do app (padrão, conexão própria) ou a transação do chamador. */
type Executor = Pick<Db, "insert">;

/**
 * Soma 1 ao contador de `key` na janela fixa atual (INSERT ... ON CONFLICT DO UPDATE ... RETURNING, atômico)
 * e devolve se ainda está dentro do limite. A chamada que estoura também conta. Dentro de uma ação, passe `ctx.tx`
 * em `on`: o contador vai na mesma transação (sem segunda conexão do pool de 5; rollback desfaz a contagem junto).
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSec: number,
  now: Date = new Date(),
  on: Executor | Tx = db,
): Promise<boolean> {
  const count = await bump(key, windowStart(now, windowSec), on);
  maybeCleanup(now);
  return count <= limit;
}

/**
 * Só LÊ o contador de `key` na janela fixa atual: `true` se ainda cabe mais um (contagem < limite).
 * Par de `hitRateLimit`, para limites que contam só o que deu certo (ex.: pedidos criados, não tentativas).
 */
export async function peekRateLimit(key: string, limit: number, windowSec: number, now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ count: rateLimit.count })
    .from(rateLimit)
    .where(and(eq(rateLimit.key, key), eq(rateLimit.windowStart, windowStart(now, windowSec))));
  return (row?.count ?? 0) < limit;
}

/** Soma 1 ao contador de `key` na janela fixa atual (depois que a operação limitada deu certo). */
export async function hitRateLimit(key: string, windowSec: number, now: Date = new Date()): Promise<void> {
  await bump(key, windowStart(now, windowSec));
  maybeCleanup(now);
}

async function bump(key: string, start: Date, on: Executor | Tx = db): Promise<number> {
  const [row] = await on
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

/** Soma os eventos de `key` nos últimos `withinSec` segundos (janela deslizante, precisão de 1 min). */
export async function countRecentEvents(key: string, withinSec: number, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - withinSec * 1000);
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${rateLimit.count}), 0)::int` })
    .from(rateLimit)
    .where(and(eq(rateLimit.key, key), gt(rateLimit.windowStart, since)));
  return Number(row?.n ?? 0);
}

/** 8 grupos de 16 bits de um IPv6 (aceita `::` e IPv4 no fim); `null` se não for IPv6 válido. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const p = v4[2]!.split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    s = `${v4[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x === "" ? [] : x.split(":"));
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/**
 * Chave de limite por IP. IPv4: o próprio endereço. IPv6: canonicalizado e agrupado pela /64 (um cliente costuma
 * receber a /64 inteira e trocar de endereço à vontade dentro dela). IPv4 mapeado (::ffff:a.b.c.d) vira o IPv4.
 */
export function ipRateKey(ip: string): string {
  const v = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(v) === 4) return v;
  const g = ipv6Groups(v);
  if (!g) return v;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
