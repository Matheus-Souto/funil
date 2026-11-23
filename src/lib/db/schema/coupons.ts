import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { offer } from "./catalog";
import { store } from "./core";

// Todas as tabelas deste arquivo têm RLS (enable_store_rls na migration). Dinheiro em centavos inteiros.

/**
 * Cupom de desconto da loja. `kind` `percent` usa `percent_bp` (pontos-base: 1000 = 10%); `fixed` usa `amount_cents`.
 * `applies_to`: `main` desconta só o produto principal; `all` estende ao bump. `max_uses` nulo = sem limite;
 * `max_per_email` nulo = sem limite por comprador. A lista de ofertas fica em `coupon_offer` (vazia = todas).
 */
export const coupon = pgTable(
  "coupon",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    kind: text("kind").notNull(),
    percentBp: integer("percent_bp"),
    amountCents: integer("amount_cents"),
    appliesTo: text("applies_to").notNull().default("main"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    maxUses: integer("max_uses"),
    maxPerEmail: integer("max_per_email").default(1),
    active: boolean("active").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("coupon_store_code_unique").on(t.storeId, t.code),
    unique("coupon_store_id_id_unique").on(t.storeId, t.id), // alvo das FKs compostas de coupon_offer e orders
    check("coupon_code_check", sql`${t.code} ~ '^[A-Z0-9_-]{3,32}$'`),
    check("coupon_kind_check", sql`${t.kind} in ('percent','fixed')`),
    check("coupon_percent_check", sql`${t.percentBp} is null or ${t.percentBp} between 1 and 9000`),
    check("coupon_amount_check", sql`${t.amountCents} is null or ${t.amountCents} > 0`),
    check(
      "coupon_value_check",
      sql`(${t.kind} = 'percent') = (${t.percentBp} is not null) and (${t.kind} = 'fixed') = (${t.amountCents} is not null)`,
    ),
    check("coupon_applies_to_check", sql`${t.appliesTo} in ('main','all')`),
    check("coupon_window_check", sql`${t.endsAt} is null or ${t.startsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check("coupon_max_uses_check", sql`${t.maxUses} is null or ${t.maxUses} > 0`),
    check("coupon_max_per_email_check", sql`${t.maxPerEmail} is null or ${t.maxPerEmail} > 0`),
  ],
);

/** Ofertas em que o cupom vale. Sem linhas = todas as ofertas da loja. FKs compostas amarram tudo à mesma loja. */
export const couponOffer = pgTable(
  "coupon_offer",
  {
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    couponId: uuid("coupon_id").notNull(),
    offerId: uuid("offer_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.couponId, t.offerId] }),
    foreignKey({ columns: [t.storeId, t.couponId], foreignColumns: [coupon.storeId, coupon.id], name: "coupon_offer_coupon_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.storeId, t.offerId], foreignColumns: [offer.storeId, offer.id], name: "coupon_offer_offer_fk" }).onDelete("cascade"),
  ],
);
