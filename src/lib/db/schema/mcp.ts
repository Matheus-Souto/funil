import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { store, users } from "./core";

// Com RLS (enable_store_rls na migration). Token MCP da loja: só o sha256 do token inteiro (`token_hash`) e os 4 últimos
// caracteres (`last4`, para a lista do painel); o token só aparece uma vez, na criação. O papel `card` não lê nem escreve
// aqui. Os papéis `reader` e `integration` são exclusivos dos tokens.
export const mcpToken = pgTable(
  "mcp_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    last4: text("last4").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("mcp_token_name_check", sql`char_length(${t.name}) between 1 and 60`),
    check("mcp_token_role_check", sql`${t.role} in ('owner','admin','support','traffic','reader','integration')`),
  ],
);
