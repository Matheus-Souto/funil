import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). NUNCA guarda dados do cartão nem do titular: só o estado da tentativa.
// `error_message` é um código nosso (ex.: "sem_cobranca", "resultado_desconhecido"), nunca texto do Asaas.
export const cardAttempt = pgTable(
  "card_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("processing"),
    asaasPaymentId: text("asaas_payment_id"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Quando a tentativa saiu de `processing` (recusa, aprovação, erro). A janela de bloqueio conta daqui. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    check("card_attempt_status_check", sql`${t.status} in ('processing','approved','declined','error')`),
    index("card_attempt_order_idx").on(t.orderId, t.createdAt),
  ],
);

// Global, SEM RLS e sem store_id (como login_attempt): o limite vale antes de haver loja/ator e entre lojas.
// Chaves: `card:ip:<ip>`, `card:email:<sha256(email)>`, `card:decline:ip:<ip>`. Nunca dados de cartão.
export const rateLimit = pgTable(
  "rate_limit",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
