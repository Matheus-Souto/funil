import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";

// Com RLS (enable_store_rls na migration).
export const product = pgTable("product", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => store.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size").notNull(),
  /** sha256 do PDF enviado: entra na versão das cópias carimbadas (nulo em produtos anteriores à coluna). */
  fileSha256: text("file_sha256"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// Com RLS (enable_store_rls na migration). Dinheiro em centavos inteiros.
export const offer = pgTable(
  "offer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    priceCents: integer("price_cents").notNull(),
    methods: text("methods").array().notNull(),
    pixMode: text("pix_mode").notNull(),
    maxInstallments: integer("max_installments").notNull().default(1),
    bumpProductId: uuid("bump_product_id").references(() => product.id),
    bumpPriceCents: integer("bump_price_cents"),
    bumpLabel: text("bump_label"),
    thankYouText: text("thank_you_text"),
    pixelId: text("pixel_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_store_slug_unique").on(t.storeId, t.slug),
    check("offer_price_check", sql`${t.priceCents} > 0`),
    check("offer_methods_check", sql`cardinality(${t.methods}) > 0 and ${t.methods} <@ array['pix','card']::text[]`),
    check("offer_pix_mode_check", sql`${t.pixMode} in ('manual','asaas')`),
    check("offer_installments_check", sql`${t.maxInstallments} between 1 and 12`),
    check(
      "offer_bump_check",
      sql`(${t.bumpProductId} is null and ${t.bumpPriceCents} is null) or (${t.bumpProductId} is not null and ${t.bumpPriceCents} > 0 and ${t.bumpProductId} <> ${t.productId})`,
    ),
  ],
);
