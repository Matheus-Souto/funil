import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { product } from "./catalog";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Guarda SÓ o sha256 do token: o link em si só existe no e-mail enviado.
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
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxDownloads: integer("max_downloads").notNull().default(5),
    downloads: integer("downloads").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
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
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("email_log_status_check", sql`${t.status} in ('sent','failed')`),
    check("email_log_kind_check", sql`${t.kind} in ('delivery','seller_notice','test')`),
    index("email_log_order_idx").on(t.orderId, t.kind),
    index("email_log_job_idx").on(t.jobId),
  ],
);
