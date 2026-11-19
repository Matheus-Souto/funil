import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";

// Com RLS (enable_store_rls na migration). Último resultado do monitor semanal das páginas de pagamento
// (src/lib/security/page-monitor.ts, PCI DSS 4.0 11.6.1) por loja e página ("/c", "/o" ou "/form", o iframe do
// cartão): o aviso ao vendedor sai quando o resultado muda. `problems` só guarda códigos; `inventory` só
// origens/caminhos de scripts e o sha256 do /form.js (sem dados).
export const pageCheck = pgTable(
  "page_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    page: text("page").notNull(),
    hash: text("hash").notNull(),
    ok: boolean("ok").notNull(),
    problems: jsonb("problems").notNull().default([]),
    inventory: jsonb("inventory").notNull().default([]),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("page_check_store_page_unique").on(t.storeId, t.page)],
);
