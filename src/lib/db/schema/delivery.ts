import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { product } from "./catalog";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Um link por item do pedido; os tokens (só sha256) ficam em download_token.
// `revoked_reason`: 'order_status' (reembolso/contestação; restore_downloads desfaz) ou 'renewed' (orders.resend com
// renew; nunca é desfeita).
export const downloadLink = pgTable(
  "download_link",
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxDownloads: integer("max_downloads").notNull().default(5),
    downloads: integer("downloads").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    /** Último download contado (a varredura diária apaga as cópias carimbadas sem uso há 7 dias). */
    lastDownloadAt: timestamp("last_download_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("download_link_downloads_check", sql`${t.downloads} >= 0 and ${t.downloads} <= ${t.maxDownloads}`),
    check(
      "download_link_revoked_check",
      sql`(${t.revokedAt} is null and ${t.revokedReason} is null) or (${t.revokedAt} is not null and ${t.revokedReason} in ('order_status','renewed'))`,
    ),
    index("download_link_order_idx").on(t.orderId),
  ],
);

// Com RLS (enable_store_rls na migration). Destinatário só como sha256 do e-mail em minúsculas.
// `job_id`: o job que enviou (marca de idempotência: o mesmo job rodando de novo não reenvia).
export const emailLog = pgTable(
  "email_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    toHash: text("to_hash").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    /** Provedor que enviou e o id da mensagem nele (o webhook do Resend casa o evento por aqui). */
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    /** Último estado de entrega informado pelo provedor (webhook); `bounced` e `complained` não voltam a `delivered`. */
    deliveryStatus: text("delivery_status"),
    deliveryStatusAt: timestamp("delivery_status_at", { withTimezone: true }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("email_log_provider_check", sql`${t.provider} in ('smtp','resend')`),
    check("email_log_delivery_status_check", sql`${t.deliveryStatus} in ('delivered','bounced','complained')`),
    index("email_log_provider_message_idx").on(t.storeId, t.providerMessageId),
    check("email_log_status_check", sql`${t.status} in ('sent','failed')`),
    check("email_log_kind_check", sql`${t.kind} in ('delivery','seller_notice','test','recovery','team_invite')`),
    index("email_log_order_idx").on(t.orderId, t.kind),
    index("email_log_job_idx").on(t.jobId),
  ],
);

// Com RLS (enable_store_rls na migration). Tokens do link: cada e-mail enviado acrescenta um (os anteriores continuam
// valendo); validade, contador e revogação por status ficam no link. `revoked_at` aqui só na renovação (renew).
// Só o sha256 do token é guardado, e a linha só é gravada depois que o e-mail com o token saiu.
export const downloadToken = pgTable(
  "download_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    linkId: uuid("link_id")
      .notNull()
      .references(() => downloadLink.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("download_token_link_idx").on(t.linkId)],
);
