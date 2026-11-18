import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";

// SEM RLS, de propósito: `store_id` é nulo em tarefas globais (ex.: expire_orders) e o worker precisa
// enxergar a fila inteira numa só consulta. Só o worker (src/lib/jobs.ts) lê e grava aqui; qualquer
// handler que toque dados de loja deve rodar dentro de `withStore(job.storeId)`.
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").references(() => store.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").notNull().default("queued"),
    lastError: text("last_error"),
  },
  (t) => [
    check("job_status_check", sql`${t.status} in ('queued','running','done','failed')`),
    index("job_due_idx").on(t.runAt).where(sql`${t.status} = 'queued'`),
  ],
);
