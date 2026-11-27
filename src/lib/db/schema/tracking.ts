import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { appTrial } from "./apps";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Marca o envio à API de Conversões do Meta por pedido ou teste e evento:
// o job `meta_event` é at-least-once e não reenvia o que já tem marca (`sent`, ou `failed` por erro permanente).
export const conversion = pgTable(
  "conversion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    trialId: uuid("trial_id"),
    event: text("event").notNull(),
    eventId: text("event_id").notNull(),
    /** `sent` ou `failed` (erro permanente do Meta: não re-tentar). */
    status: text("status").notNull().default("sent"),
    /** Código do erro do Graph quando `failed`. */
    errorCode: integer("error_code"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("conversion_order_event_unique").on(t.orderId, t.event),
    unique("conversion_trial_event_unique").on(t.trialId, t.event),
    foreignKey({ columns: [t.storeId, t.trialId], foreignColumns: [appTrial.storeId, appTrial.id], name: "conversion_trial_fk" }).onDelete("cascade"),
    check("conversion_subject_check", sql`(${t.orderId} is null) <> (${t.trialId} is null)`),
    check("conversion_event_check", sql`${t.event} in ('Purchase','InitiateCheckout','StartTrial')`),
    check("conversion_status_check", sql`${t.status} in ('sent','failed')`),
  ],
);
