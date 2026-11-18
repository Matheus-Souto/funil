import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// Tabelas globais (sem RLS): lojas, usuários, vínculos e sessões.
export const store = pgTable("store", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  domain: text("domain").unique(),
  notifyEmail: text("notify_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
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
