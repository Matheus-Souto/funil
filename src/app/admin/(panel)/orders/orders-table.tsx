"use client";

// Tabela de pedidos com a sortable-data-table do Arc: clique no título ordena (os pedidos da página aberta; a lista vem
// do servidor já filtrada e paginada, mais recentes primeiro). No celular o próprio Arc vira lista.
import Link from "next/link";
import type { ReactNode } from "react";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import { brl } from "@/lib/format";
import { StatusBadge } from "../../blocks";
import s from "../../panel.module.css";

export interface OrderRow extends Record<string, unknown> {
  id: string;
  code: string;
  buyerName: string;
  email: string;
  offerName: string;
  hasBump: boolean;
  method: string;
  methodLabel: string;
  cents: number;
  status: string;
  statusLabel: string;
  refundRequested: boolean;
  createdText: string;
  createdTs: number;
}

export function OrdersTable({ rows, filters = {} }: { rows: OrderRow[]; filters?: { status?: ReactNode; method?: ReactNode } }) {
  return (
    <div className={s.arcTable}>
      <SortableDataTable<OrderRow>
        rows={rows}
        rowKey="id"
        caption="Pedidos"
        itemName={{ one: "pedido", other: "pedidos" }}
        emptyMessage="Nenhum pedido com estes filtros"
        defaultSort={{ key: "createdTs", direction: "desc" }}
        columns={[
          {
            key: "code",
            label: "Pedido",
            render: (_, o) => (
              <Link className={`${s.rowLink} ${s.mono} ${s.nowrap}`} href={`/admin/orders/${o.id}`}>
                #{o.code}
              </Link>
            ),
          },
          {
            key: "buyerName",
            label: "Cliente",
            render: (_, o) => (
              <span className={s.leadCell}>
                <b>{o.buyerName}</b>
                <small>{o.email}</small>
              </span>
            ),
          },
          {
            key: "offerName",
            label: "Oferta",
            render: (_, o) => (
              <span className={s.leadCell}>
                {o.offerName}
                {o.hasBump ? <small>+ bump</small> : null}
              </span>
            ),
          },
          { key: "methodLabel", label: "Método", filter: filters.method },
          { key: "cents", label: "Valor", numeric: true, render: (_, o) => <span className={s.nowrap}>{brl(o.cents)}</span> },
          {
            key: "statusLabel",
            label: "Status",
            filter: filters.status,
            render: (_, o) => <StatusBadge status={o.status} method={o.method} label={o.refundRequested && o.status === "paid" ? "Estorno solicitado" : undefined} />,
          },
          { key: "createdTs", label: "Data", render: (_, o) => <span className={s.nowrap}>{o.createdText}</span> },
        ]}
      />
    </div>
  );
}
