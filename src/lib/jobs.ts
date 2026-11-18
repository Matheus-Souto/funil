import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { job } from "@/lib/db/schema";
import { log, redact } from "@/lib/log";

export type JobType = "deliver_order" | "meta_event" | "notify_seller" | "revoke_downloads" | "expire_orders";
export type Job = typeof job.$inferSelect;
export type JobHandler = (job: Job) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

/** Espera (s) antes de cada nova tentativa; esgotada a lista, o job vira `failed`. */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200] as const;
const MAX_ERROR = 500;

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

/**
 * Executa até `limit` jobs vencidos (`run_at <= now`). Cada job roda na própria transação com
 * FOR UPDATE SKIP LOCKED: workers concorrentes não pegam o mesmo job e uma queda devolve o job à fila.
 * Handlers que tocam dados de loja devem usar `withStore(job.storeId)`; `job` não tem RLS.
 */
export async function runDueJobs(handlers: JobHandlers, limit = 10, now: Date = new Date()): Promise<number> {
  let ran = 0;
  while (ran < limit) {
    const took = await db.transaction(async (tx) => {
      const [j] = await tx
        .select()
        .from(job)
        .where(and(eq(job.status, "queued"), lte(job.runAt, now)))
        .orderBy(asc(job.runAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!j) return false;
      const attempts = j.attempts + 1;
      const handler = handlers[j.type as JobType];
      if (!handler) {
        await tx.update(job).set({ status: "failed", attempts, lastError: "sem handler" }).where(eq(job.id, j.id));
        return true;
      }
      try {
        await handler(j);
        await tx.update(job).set({ status: "done", attempts, lastError: null }).where(eq(job.id, j.id));
      } catch (e) {
        const wait = BACKOFF_SECONDS[j.attempts];
        log.warn("job falhou", { id: j.id, type: j.type, attempts, error: errorText(e) });
        await tx
          .update(job)
          .set(
            wait === undefined
              ? { status: "failed", attempts, lastError: errorText(e) }
              : { attempts, lastError: errorText(e), runAt: new Date(now.getTime() + wait * 1000) },
          )
          .where(eq(job.id, j.id));
      }
      return true;
    });
    if (!took) break;
    ran++;
  }
  return ran;
}
