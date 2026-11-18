// Fila de tarefas. Entrega AT-LEAST-ONCE: um job pode rodar mais de uma vez (queda do processo no meio,
// recuperação de `running` travado), então todo handler deve ser idempotente.
// O job é reivindicado numa transação curta (status running), o handler roda FORA de transação e
// um segundo UPDATE grava o resultado.
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/lib/db/client";
import { job } from "@/lib/db/schema";
import { log, redact } from "@/lib/log";

export type JobType =
  | "deliver_order"
  | "meta_event"
  | "notify_seller"
  | "revoke_downloads"
  | "restore_downloads"
  | "expire_orders"
  | "refund_order"
  | "sweep_watermarks";
export type Job = typeof job.$inferSelect;
/** `signal` é abortado quando o tempo-limite estoura: o handler deve repassá-lo ao HTTP/SMTP que fizer. */
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

/** Espera (s) antes de cada nova tentativa; esgotada a lista, o job vira `failed`. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200] as const;
const MAX_ERROR = 500;
/** `running` há mais que isto volta para `queued` (processo caiu no meio do handler). */
export const STUCK_AFTER_MS = 10 * 60 * 1000;
/** Tempo-limite padrão de cada handler (bem menor que STUCK_AFTER_MS). Estourou = tentativa falha (backoff normal). */
export const HANDLER_TIMEOUT_MS = 120_000;
/** Job cujo tipo não tem handler neste processo (ex.: deploy gradual) volta à fila depois disto, sem contar tentativa. */
export const NO_HANDLER_DELAY_MS = 10 * 60 * 1000;

export async function enqueue(tx: Tx, j: { storeId: string | null; type: JobType; payload: unknown; runAt?: Date }): Promise<void> {
  await tx.insert(job).values({ storeId: j.storeId, type: j.type, payload: j.payload ?? {}, ...(j.runAt ? { runAt: j.runAt } : {}) });
}

/** Há job deste tipo para o pedido ainda na fila ou rodando? (evita enfileirar o mesmo efeito duas vezes) */
export async function hasOpenJob(tx: Tx, type: JobType, orderId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.type, type), inArray(job.status, ["queued", "running"]), sql`${job.payload}->>'orderId' = ${orderId}`))
    .limit(1);
  return row !== undefined;
}

/** Agenda um job global só se não houver outro `queued` do mesmo tipo. Devolve se inseriu. */
export async function scheduleOnce(type: JobType, runAt: Date = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`job:schedule:${type}`}))`);
    const [existing] = await tx.select({ id: job.id }).from(job).where(and(eq(job.type, type), eq(job.status, "queued"))).limit(1);
    if (existing) return false;
    await enqueue(tx, { storeId: null, type, payload: {}, runAt });
    return true;
  });
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return String(redact(msg)).slice(0, MAX_ERROR);
}

/** Devolve à fila (ou falha, se já esgotou as tentativas) os jobs `running` travados. */
async function recoverStuck(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = and(eq(job.status, "running"), lt(job.lockedAt, cutoff));
  const note = "travado em running; recuperado";
  await db.update(job).set({ status: "failed", lockedAt: null, lastError: note }).where(and(stuck, sql`${job.attempts} > ${BACKOFF_SECONDS.length}`));
  await db.update(job).set({ status: "queued", lockedAt: null, lastError: note }).where(stuck);
}

/** Reivindica o próximo job vencido (tentativa já contada). Transação curta, FOR UPDATE SKIP LOCKED. */
async function claim(now: Date): Promise<Job | undefined> {
  // `now` é uma leitura nova do relógio a cada claim: locked_at reflete o momento real da reivindicação.
  return db.transaction(async (tx) => {
    const next = tx
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.status, "queued"), lte(job.runAt, now)))
      .orderBy(asc(job.runAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const [row] = await tx
      .update(job)
      .set({ status: "running", lockedAt: now, attempts: sql`${job.attempts} + 1` })
      .where(inArray(job.id, next))
      .returning();
    return row;
  });
}

export type Clock = () => Date;
/** Agenda `onTimeout` em `ms`; devolve a função que cancela. Injetável nos testes (sem espera real). */
export type Timer = (ms: number, onTimeout: () => void) => () => void;

const realTimer: Timer = (ms, onTimeout) => {
  const h = setTimeout(onTimeout, ms);
  h.unref?.();
  return () => clearTimeout(h);
};

export interface RunOptions {
  timeoutMs?: number;
  timer?: Timer;
}

/** Roda o handler com tempo-limite: estourou -> aborta o `signal` e rejeita (o handler pode seguir em segundo plano). */
async function runWithTimeout(handler: JobHandler, j: Job, timeoutMs: number, timer: Timer): Promise<void> {
  const ctrl = new AbortController();
  let cancel: () => void = () => undefined;
  const timedOut = new Promise<never>((_, reject) => {
    cancel = timer(timeoutMs, () => {
      const e = new Error(`tempo-limite de ${timeoutMs} ms estourado`);
      ctrl.abort(e);
      reject(e);
    });
  });
  try {
    await Promise.race([handler(j, ctrl.signal), timedOut]);
  } finally {
    cancel();
  }
}

/**
 * Executa até `limit` jobs vencidos (`run_at <= now`). `now` é uma data fixa ou um relógio (lido a cada
 * claim/finalização; injetável nos testes). A finalização só vale para a reivindicação que a gerou
 * (`locked_at` igual): um worker lento cujo job foi recuperado e reivindicado por outro não sobrescreve nada. Handlers que tocam dados de loja devem usar
 * `withStore(job.storeId)`; `job` não tem RLS.
 */
export async function runDueJobs(
  handlers: JobHandlers,
  limit = 10,
  now: Date | Clock = () => new Date(),
  opts: RunOptions = {},
): Promise<number> {
  const clock: Clock = typeof now === "function" ? now : () => now;
  const timeoutMs = opts.timeoutMs ?? HANDLER_TIMEOUT_MS;
  const timer = opts.timer ?? realTimer;
  const missing = new Map<string, number>();
  await recoverStuck(clock());
  let ran = 0;
  while (ran < limit) {
    const j = await claim(clock());
    if (!j) break;
    ran++;
    const handler = handlers[j.type as JobType];
    const finish = async (set: (at: Date) => PgUpdateSetSource<typeof job>) => {
      const res = await db
        .update(job)
        .set({ lockedAt: null, ...set(clock()) })
        .where(and(eq(job.id, j.id), eq(job.status, "running"), eq(job.lockedAt, j.lockedAt!)))
        .returning({ id: job.id });
      if (res.length === 0) log.warn("finalização obsoleta ignorada (job reivindicado por outro worker)", { id: j.id, type: j.type });
    };
    if (!handler) {
      // Não é falha do job: devolve à fila sem queimar a tentativa (o claim já tinha contado).
      missing.set(j.type, (missing.get(j.type) ?? 0) + 1);
      await finish((at) => ({
        status: "queued",
        attempts: sql`${job.attempts} - 1`,
        lastError: "sem handler",
        runAt: new Date(at.getTime() + NO_HANDLER_DELAY_MS),
      }));
      continue;
    }
    try {
      await runWithTimeout(handler, j, timeoutMs, timer);
      await finish(() => ({ status: "done", lastError: null }));
    } catch (e) {
      const wait = BACKOFF_SECONDS[j.attempts - 1];
      log.warn("job falhou", { id: j.id, type: j.type, attempts: j.attempts, error: errorText(e) });
      await finish((at) =>
        wait === undefined
          ? { status: "failed", lastError: errorText(e) }
          : { status: "queued", lastError: errorText(e), runAt: new Date(at.getTime() + wait * 1000) },
      );
    }
  }
  if (missing.size > 0) log.warn("jobs sem handler adiados", { types: Object.fromEntries(missing), delayMs: NO_HANDLER_DELAY_MS });
  return ran;
}
