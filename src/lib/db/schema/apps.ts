import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { offer } from "./catalog";
import { store } from "./core";
import { orders } from "./orders";

// As três tabelas usam enable_store_rls na migration.
export const appTrial = pgTable(
  "app_trial",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    account: text("account").notNull(),
    emailHash: text("email_hash").notNull(),
    mailboxHash: text("mailbox_hash").notNull(),
    firstTouch: jsonb("first_touch"),
    ref: text("ref"),
    fbc: text("fbc"),
    fbp: text("fbp"),
    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
    eventId: text("event_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("app_trial_store_account_unique").on(t.storeId, t.account),
    unique("app_trial_store_id_id_unique").on(t.storeId, t.id),
    check("app_trial_account_check", sql`char_length(${t.account}) between 1 and 64`),
  ],
);

export const appCheckoutSession = pgTable(
  "app_checkout_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id").notNull(),
    account: text("account").notNull(),
    buyerName: text("buyer_name").notNull(),
    buyerEmail: text("buyer_email").notNull(),
    buyerPhone: text("buyer_phone"),
    touch: jsonb("touch"),
    ref: text("ref"),
    fbc: text("fbc"),
    fbp: text("fbp"),
    returnUrl: text("return_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    orderId: uuid("order_id"),
    /**
     * O único pedido desta sessão que libera algo no app (o primeiro a gerar aviso, eleito sob `FOR UPDATE` da sessão em
     * `enqueueAppNotice`). Outro pedido pago da mesma sessão é duplicado: sem aviso ao app e com alerta de reembolso.
     */
    releasedOrderId: uuid("released_order_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A anotação preserva a inferência dos tipos apesar das FKs nos dois sentidos entre sessão e pedido.
  (t): PgTableExtraConfigValue[] => [
    unique("app_checkout_session_store_id_id_unique").on(t.storeId, t.id),
    foreignKey({ columns: [t.storeId, t.offerId], foreignColumns: [offer.storeId, offer.id], name: "app_checkout_session_offer_fk" }),
    foreignKey({ columns: [t.storeId, t.orderId], foreignColumns: [orders.storeId, orders.id], name: "app_checkout_session_order_fk" }),
    foreignKey({ columns: [t.storeId, t.releasedOrderId], foreignColumns: [orders.storeId, orders.id], name: "app_checkout_session_released_order_fk" }),
    index("app_checkout_session_order_idx").on(t.orderId).where(sql`${t.orderId} is not null`),
    check("app_checkout_session_account_check", sql`char_length(${t.account}) between 1 and 64`),
  ],
);

export const appWebhookDelivery = pgTable(
  "app_webhook_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    orderId: uuid("order_id"),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastHttpStatus: integer("last_http_status"),
    /**
     * Ordem do aviso dentro do pedido (1 = `pagamento.confirmado`, depois 2, 3...): vai no corpo como `dados.sequencia`
     * para o app descartar transição antiga, e é a ordem de entrega (um aviso só sai com os anteriores resolvidos).
     */
    sequence: integer("sequence"),
    /** `pagamento.reembolso_parcial`: soma devolvida até a ocorrência, fixada na criação (as retentativas a repetem). */
    refundedCents: integer("refunded_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.storeId, t.orderId], foreignColumns: [orders.storeId, orders.id], name: "app_webhook_delivery_order_fk" }),
    unique("app_webhook_delivery_order_sequence_unique").on(t.orderId, t.sequence),
    check("app_webhook_delivery_sequence_check", sql`(${t.orderId} is null) = (${t.sequence} is null) and ${t.sequence} >= 1`),
    check(
      "app_webhook_delivery_refunded_check",
      sql`(${t.eventType} = 'pagamento.reembolso_parcial') = (${t.refundedCents} is not null) and ${t.refundedCents} > 0`,
    ),
    index("app_webhook_delivery_order_idx").on(t.orderId).where(sql`${t.orderId} is not null`),
    check(
      "app_webhook_delivery_event_type_check",
      sql`${t.eventType} in ('pagamento.confirmado','pagamento.reembolsado','pagamento.reembolso_parcial','pagamento.contestado','pagamento.restabelecido','ping')`,
    ),
    check("app_webhook_delivery_status_check", sql`${t.status} in ('pending','delivered','failed')`),
    check("app_webhook_delivery_event_order_check", sql`(${t.eventType} = 'ping') = (${t.orderId} is null)`),
  ],
);
