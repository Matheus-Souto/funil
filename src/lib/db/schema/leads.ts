import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { offer } from "./catalog";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Contato de quem digitou e-mail/celular no checkout e não concluiu a compra
// (captura com aviso, só quando a loja liga `store.lead_capture`). Guarda só e-mail e celular: nunca nome, CPF, IP nem
// user agent. `key_hash` é o sha256 da chave do visitante (quem não tem a chave não altera nem apaga a linha);
// `email_hash`, o sha256 do e-mail normalizado (dedupe e conversão sem expor o e-mail). Convertido (virou pedido) perde
// e-mail e celular na hora. Retenção de 30 dias (`expires_at`). O papel `card` não lê nem escreve aqui.
export const checkoutLead = pgTable(
  "checkout_lead",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(),
    /** Nulo só depois de convertido. */
    email: text("email"),
    emailHash: text("email_hash").notNull(),
    phone: text("phone"),
    status: text("status").notNull().default("open"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("checkout_lead_store_key_uniq").on(t.storeId, t.keyHash),
    check("checkout_lead_status_check", sql`${t.status} in ('open','contacted','converted')`),
    check("checkout_lead_email_check", sql`${t.status} = 'converted' or ${t.email} is not null`),
    check("checkout_lead_converted_check", sql`${t.status} <> 'converted' or (${t.email} is null and ${t.phone} is null)`),
    index("checkout_lead_store_created_idx").on(t.storeId, t.createdAt.desc()),
    index("checkout_lead_store_email_idx").on(t.storeId, t.emailHash),
    index("checkout_lead_expires_idx").on(t.expiresAt),
  ],
);
