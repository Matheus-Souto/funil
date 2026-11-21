import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { offer } from "./catalog";
import { store } from "./core";
import { checkoutLead } from "./leads";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Um lembrete por e-mail de recuperação de venda: `lead` (quem deixou o contato
// no checkout e não comprou), `pix` (Pix gerado e não pago) ou `card` (cartão recusado). Guarda só sha256 do e-mail
// (`email_hash`) e o sha256 do token de descadastro (`unsub_hash`): nunca e-mail, token nem URL. `lead` não tem pedido
// (`order_id` nulo); `pix` e `card` têm. Apagado o contato (`lead_id` vira nulo), a linha `lead` continua válida. Um
// lembrete por contato e um por pedido e tipo. Retenção de 90 dias (`expires_at`). O papel `card` não lê nem escreve aqui.
export const recoveryEmail = pgTable(
  "recovery_email",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    leadId: uuid("lead_id").references(() => checkoutLead.id, { onDelete: "set null" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    status: text("status").notNull().default("queued"),
    skipReason: text("skip_reason"),
    unsubHash: text("unsub_hash").notNull(),
    jobId: uuid("job_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Criação + 90 dias. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("recovery_email_kind_check", sql`${t.kind} in ('lead','pix','card')`),
    check("recovery_email_status_check", sql`${t.status} in ('queued','sending','sent','failed','skipped')`),
    check("recovery_email_kind_order_check", sql`(${t.kind} = 'lead') = (${t.orderId} is null)`),
    uniqueIndex("recovery_email_unsub_uniq").on(t.unsubHash),
    uniqueIndex("recovery_email_lead_uniq").on(t.leadId).where(sql`${t.leadId} is not null`),
    uniqueIndex("recovery_email_order_kind_uniq").on(t.orderId, t.kind).where(sql`${t.orderId} is not null`),
    index("recovery_email_store_email_idx").on(t.storeId, t.emailHash, t.createdAt.desc()),
    index("recovery_email_store_created_idx").on(t.storeId, t.createdAt.desc()),
    index("recovery_email_expires_idx").on(t.expiresAt),
  ],
);

// Com RLS. E-mail que não recebe mais recuperação nesta loja (descadastro, reclamação ou bounce); só o sha256.
export const emailOptout = pgTable(
  "email_optout",
  {
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.emailHash] }),
    check("email_optout_reason_check", sql`${t.reason} in ('unsubscribe','complaint','bounce')`),
  ],
);
