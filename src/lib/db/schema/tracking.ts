import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Marca "evento já enviado à API de Conversões do Meta" por (pedido, evento):
// o job `meta_event` é at-least-once e não reenvia o que já tem marca (`sent`, ou `failed` por erro permanente).
export const conversion = pgTable(
  "conversion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
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
    check("conversion_event_check", sql`${t.event} in ('Purchase','InitiateCheckout')`),
    check("conversion_status_check", sql`${t.status} in ('sent','failed')`),
  ],
);
