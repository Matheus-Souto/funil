import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { offer, product } from "./catalog";
import { store } from "./core";

// Todas as tabelas deste arquivo têm RLS (enable_store_rls na migration). Dinheiro em centavos inteiros.
export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    cpf: text("cpf"),
    asaasCustomerId: text("asaas_customer_id"),
  },
  (t) => [unique("customer_store_email_unique").on(t.storeId, t.email)],
);

// Nome SQL `orders` (order é palavra reservada).
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull().unique(),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    status: text("status").notNull().default("pending"),
    method: text("method").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    manualAmountCents: integer("manual_amount_cents"),
    hasBump: boolean("has_bump").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    firstTouch: jsonb("first_touch"),
    lastTouch: jsonb("last_touch"),
    ref: text("ref"),
    fbc: text("fbc"),
    fbp: text("fbp"),
    clientIp: text("client_ip").notNull(),
    userAgent: text("user_agent").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("orders_status_check", sql`${t.status} in ('pending','paid','refunded','disputed','expired','declined')`),
    check("orders_method_check", sql`${t.method} in ('pix_manual','pix_asaas','card_asaas')`),
    check("orders_amounts_check", sql`${t.subtotalCents} > 0 and ${t.totalCents} > 0`),
    index("orders_store_status_idx").on(t.storeId, t.status),
    // Valor único do Pix manual: dois pendentes da mesma loja nunca compartilham o mesmo valor.
    uniqueIndex("orders_manual_amount_pending_unique")
      .on(t.storeId, t.manualAmountCents)
      .where(sql`${t.method} = 'pix_manual' and ${t.status} = 'pending'`),
    index("orders_pending_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'pending'`),
  ],
);

export const orderItem = pgTable(
  "order_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    priceCents: integer("price_cents").notNull(),
    kind: text("kind").notNull(),
  },
  (t) => [check("order_item_kind_check", sql`${t.kind} in ('main','bump')`), index("order_item_order_idx").on(t.orderId)],
);

export const payment = pgTable(
  "payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerId: text("provider_id"),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    raw: jsonb("raw"),
  },
  (t) => [
    check("payment_provider_check", sql`${t.provider} in ('asaas','manual')`),
    // Pagamento manual não tem provider_id; a unicidade só vale quando há id do provedor.
    uniqueIndex("payment_provider_id_unique").on(t.provider, t.providerId).where(sql`${t.providerId} is not null`),
    index("payment_order_idx").on(t.orderId),
    // No máximo uma cobrança Asaas ainda aberta (PENDING) por pedido: chamadas simultâneas não criam duas.
    uniqueIndex("payment_order_open_asaas_unique")
      .on(t.orderId)
      .where(sql`${t.provider} = 'asaas' and ${t.status} = 'PENDING'`),
  ],
);

export const checkoutView = pgTable("checkout_view", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => store.id, { onDelete: "cascade" }),
  offerId: uuid("offer_id")
    .notNull()
    .references(() => offer.id),
  touch: jsonb("touch"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
