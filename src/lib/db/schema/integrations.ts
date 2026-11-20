import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";

// Com RLS (enable_store_rls na migration). `config` é público; `secret` é sempre seal() (nunca texto puro).
export const integration = pgTable(
  "integration",
  {
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    config: jsonb("config").notNull().default({}),
    secret: text("secret"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.kind] }),
    check("integration_kind_check", sql`${t.kind} in ('pix_manual','asaas','smtp','meta','resend')`),
  ],
);
