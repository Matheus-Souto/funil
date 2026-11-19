import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Tabelas globais (sem RLS): lojas, usuários, vínculos e sessões.
export const store = pgTable("store", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  domain: text("domain").unique(),
  notifyEmail: text("notify_email"),
  /** Cor da marca no checkout (#RRGGBB). Nula = cor padrão da plataforma. O contraste é garantido em src/lib/brand.ts. */
  brandColor: text("brand_color"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  /** Senha temporária (CLI store:create): o painel exige a troca antes de qualquer outra tela. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membership = pgTable(
  "membership",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (t) => [
    unique("membership_user_store_unique").on(t.userId, t.storeId),
    check("membership_role_check", sql`${t.role} in ('owner','admin','support','traffic')`),
  ],
);

export const session = pgTable("session", {
  idHash: text("id_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  storeId: uuid("store_id")
    .notNull()
    .references(() => store.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Com RLS (enable_store_rls na migration).
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => store.id, { onDelete: "cascade" }),
  actor: jsonb("actor").notNull(),
  origin: text("origin").notNull(),
  action: text("action").notNull(),
  input: jsonb("input").notNull(),
  ok: boolean("ok").notNull(),
  error: text("error"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// Global como users/session: sem store_id nem RLS, pois a tentativa ocorre antes de haver loja/ator. Só guarda sha256 do e-mail.
export const loginAttempt = pgTable(
  "login_attempt",
  {
    emailHash: text("email_hash").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempt_email_at_idx").on(t.emailHash, t.at)],
);
