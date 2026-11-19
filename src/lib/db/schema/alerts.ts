import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { store } from "./core";
import { orders } from "./orders";

// Com RLS (enable_store_rls na migration). Aviso operacional ao vendedor, gravado na MESMA transação que enfileira o
// `notify_seller` com motivo (src/lib/alerts.ts): o e-mail pode falhar ou a loja não ter e-mail de aviso, o painel
// mostra o aviso até alguém clicar em "ok". `detail` só guarda códigos e números (status HTTP, id da cobrança, código
// de erro, centavos estornados, página conferida), nunca dados pessoais.
export const storeAlert = pgTable(
  "store_alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => store.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "store_alert_kind_check",
      sql`${t.kind} in ('chave_asaas_invalida','evento_conta_asaas_anterior','estorno_cancelado','estorno_falhou','estorno_parcial','disjuntor_cartao','monitor_pagina_pagamento')`,
    ),
    index("store_alert_open_idx").on(t.storeId, t.createdAt).where(sql`${t.acknowledgedAt} is null`),
  ],
);
