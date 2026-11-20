import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { product } from "./catalog";
import { store, users } from "./core";
import { mcpToken } from "./mcp";

// Com RLS (enable_store_rls na migration). Fila de aprovação do MCP: ação sensível pedida por um token espera um membro
// da loja aprovar. `input_sealed` guarda a entrada selada (seal() de src/lib/crypto.ts) só enquanto o pedido está
// pendente: vira null ao decidir, expirar ou cancelar. `input_sha256` amarra a aprovação à entrada exata; o índice
// único parcial faz o mesmo pedido pendente (token, ação, entrada) ser um só. O papel `card` não lê nem escreve aqui.
export const approvalRequest = pgTable(
  "approval_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => mcpToken.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    inputSealed: text("input_sealed"),
    inputSha256: text("input_sha256").notNull(),
    summary: jsonb("summary").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    /** UUID de `out.id` da ação aprovada, quando a saída tem um. */
    resultId: uuid("result_id"),
    /** `código: mensagem` do ActionError quando a execução aprovada falha. */
    error: text("error"),
  },
  (t) => [
    check("approval_request_status_check", sql`${t.status} in ('pending','approved','rejected','expired','failed','canceled')`),
    check("approval_request_error_check", sql`char_length(${t.error}) <= 500`),
    index("approval_request_store_status_idx").on(t.storeId, t.status, t.createdAt.desc()),
    index("approval_request_token_idx").on(t.tokenId, t.createdAt.desc()),
    uniqueIndex("approval_request_pending_uniq").on(t.tokenId, t.action, t.inputSha256).where(sql`${t.status} = 'pending'`),
  ],
);

// Com RLS (enable_store_rls na migration). Link de upload de PDF pedido por um token MCP: só o sha256 da chave
// (`key_hash`); a URL nunca vai para log nem auditoria. Uso único (`used_at`), com teto de tentativas (`attempts`).
// O papel `card` não lê nem escreve aqui.
export const uploadLink = pgTable(
  "upload_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => mcpToken.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    fileName: text("file_name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    productId: uuid("product_id").references(() => product.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("upload_link_name_check", sql`char_length(${t.name}) between 1 and 200`),
    check("upload_link_file_name_check", sql`char_length(${t.fileName}) between 1 and 200`),
  ],
);
