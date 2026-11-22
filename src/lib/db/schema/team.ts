import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { store, users } from "./core";

// Com RLS (enable_store_rls na migration). Convite para entrar na equipe da loja. Guarda só o sha256 do token
// (`token_hash`; o token `inv_...` vai só no link do e-mail) e o sha256 do e-mail normalizado (`email_hash`:
// trim + minúsculas). O `email` em claro existe só enquanto o convite está `pending` (precisa dele para enviar e
// reenviar) e é apagado ao aceitar, revogar ou vencer. O papel nunca é `owner`. Um convite pendente por e-mail e loja.
// `send_status`/`send_error`/`send_count`/`last_sent_at` registram o envio; `ended_at` marca o fim (aceito, revogado
// ou vencido). O papel `card` não lê nem escreve aqui.
export const teamInvite = pgTable(
  "team_invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    email: text("email"),
    emailHash: text("email_hash").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    sendStatus: text("send_status"),
    sendError: text("send_error"),
    sendCount: integer("send_count").notNull().default(0),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Quando o convite terminou: aceito, revogado ou vencido. */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("team_invite_role_check", sql`${t.role} in ('admin','support','traffic')`),
    check("team_invite_status_check", sql`${t.status} in ('pending','accepted','revoked','expired')`),
    check("team_invite_send_status_check", sql`${t.sendStatus} is null or ${t.sendStatus} in ('sent','failed')`),
    check("team_invite_email_status_check", sql`(${t.status} = 'pending') = (${t.email} is not null)`),
    uniqueIndex("team_invite_pending_email_uniq")
      .on(t.storeId, t.emailHash)
      .where(sql`${t.status} = 'pending'`),
    index("team_invite_store_status_idx").on(t.storeId, t.status, t.createdAt.desc()),
    index("team_invite_ended_idx").on(t.endedAt),
  ],
);
