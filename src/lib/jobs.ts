// Fila de tarefas. Entrega AT-LEAST-ONCE: um job pode rodar mais de uma vez (queda do processo no meio,
// recuperação de `running` travado), então todo handler deve ser idempotente.
// O job é reivindicado numa transação curta (status running), o handler roda FORA de transação e
// um segundo UPDATE grava o resultado.
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { job } from "@/lib/db/schema";
import { log, redact } from "@/lib/log";

export type JobType = "deliver_order" | "meta_event" | "notify_seller" | "revoke_downloads" | "restore_downloads" | "expire_orders";
export type Job = typeof job.$inferSelect;
export type JobHandler = (job: Job) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

/** Espera (s) antes de cada nova tentativa; esgotada a lista, o job vira `failed`. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200] as const;
const MAX_ERROR = 500;
/** `running` há mais que isto volta para `queued` (processo caiu no meio do handler). */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

export async function enqueue(tx: Tx, j: { storeId: string | null; type: JobType; payload: unknown; runAt?: Date }): Promise<void> {
  await tx.insert(job).values({ storeId: j.storeId, type: j.type, payload: j.payload ?? {}, ...(j.runAt ? { runAt: j.runAt } : {}) });
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

/**
 * Executa até `limit` jobs vencidos (`run_at <= now`). Handlers que tocam dados de loja devem usar
 * `withStore(job.storeId)`; `job` não tem RLS.
 */
export async function runDueJobs(handlers: JobHandlers, limit = 10, now: Date = new Date()): Promise<number> {
  await recoverStuck(now);
  let ran = 0;
  while (ran < limit) {
    const j = await claim(now);
    if (!j) break;
    ran++;
    const handler = handlers[j.type as JobType];
    const finish = (set: Partial<typeof job.$inferInsert>) =>
      db.update(job).set({ lockedAt: null, ...set }).where(and(eq(job.id, j.id), eq(job.status, "running")));
    if (!handler) {
      await finish({ status: "failed", lastError: "sem handler" });
      continue;
    }
    try {
      await handler(j);
      await finish({ status: "done", lastError: null });
    } catch (e) {
      const wait = BACKOFF_SECONDS[j.attempts - 1];
      log.warn("job falhou", { id: j.id, type: j.type, attempts: j.attempts, error: errorText(e) });
      await finish(
        wait === undefined
          ? { status: "failed", lastError: errorText(e) }
          : { status: "queued", lastError: errorText(e), runAt: new Date(now.getTime() + wait * 1000) },
      );
    }
  }
  return ran;
}
