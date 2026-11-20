import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Marca de aviso do Telegram já enviado: uma por pedido e evento (`unique`),
// o que impede o aviso em dobro quando o job roda duas vezes. O papel `card` não lê nem escreve aqui. Sem dados do comprador.
export const telegramNotice = pgTable(
  "telegram_notice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("telegram_notice_order_event_unique").on(t.orderId, t.event),
    check("telegram_notice_event_check", sql`${t.event} in ('sale','pix_generated','card_declined','abandoned')`),
  ],
);
