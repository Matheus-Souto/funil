import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
  /** Páginas do PDF, contadas na validação do envio (nulo até o backfill contar os produtos anteriores à coluna; 0 quando
   *  o backfill não conseguiu contar: as leituras devolvem nulo). */
  pageCount: integer("page_count"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
},
// Alvo das FKs compostas (store_id, product_id) de offer_product: amarra a linha à loja do produto.
(t) => [unique("product_store_id_id_unique").on(t.storeId, t.id)]);

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
    priceCents: integer("price_cents").notNull(),
    methods: text("methods").array().notNull(),
    pixMode: text("pix_mode").notNull(),
    maxInstallments: integer("max_installments").notNull().default(1),
    bumpPriceCents: integer("bump_price_cents"),
    bumpLabel: text("bump_label"),
    thankYouText: text("thank_you_text"),
    pixelId: text("pixel_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_store_slug_unique").on(t.storeId, t.slug),
    unique("offer_store_id_id_unique").on(t.storeId, t.id), // alvo da FK composta de offer_product
    check("offer_price_check", sql`${t.priceCents} > 0`),
    check("offer_methods_check", sql`cardinality(${t.methods}) > 0 and ${t.methods} <@ array['pix','card']::text[]`),
    check("offer_pix_mode_check", sql`${t.pixMode} in ('manual','asaas')`),
    check("offer_installments_check", sql`${t.maxInstallments} between 1 and 12`),
    check("offer_bump_check", sql`${t.bumpPriceCents} is null or ${t.bumpPriceCents} > 0`),
  ],
);

/**
 * Produtos (PDFs) de uma oferta: `main` é o que a oferta vende, `bump` o que o order bump acrescenta. `position` ordena
 * dentro do grupo (0, 1, 2...). Com RLS (enable_store_rls na migration).
 */
export const offerProduct = pgTable(
  "offer_product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    offerId: uuid("offer_id").notNull(),
    productId: uuid("product_id").notNull(),
    kind: text("kind").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    // FKs compostas: a oferta e o produto precisam ser da mesma loja da linha (o RLS só confere o store_id da linha).
    foreignKey({ columns: [t.storeId, t.offerId], foreignColumns: [offer.storeId, offer.id], name: "offer_product_offer_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.storeId, t.productId], foreignColumns: [product.storeId, product.id], name: "offer_product_product_fk" }),
    unique("offer_product_offer_product_unique").on(t.offerId, t.productId),
    // Uma posição por grupo (também serve de índice para ler a lista em ordem): duas gravações concorrentes não
    // conseguem juntar listas.
    unique("offer_product_offer_kind_position_unique").on(t.offerId, t.kind, t.position),
    check("offer_product_kind_check", sql`${t.kind} in ('main','bump')`),
    check("offer_product_position_check", sql`${t.position} >= 0`),
  ],
);
