"use client";

// Tabela de contatos com a sortable-data-table do Arc (ordena pelos títulos das colunas na página aberta).
import Link from "next/link";
import type { ReactNode } from "react";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Badge } from "../../blocks";
import s from "../../panel.module.css";
import { LeadRowActions } from "./lead-actions";

export interface LeadRow extends Record<string, unknown> {
  id: string;
  code: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  offerName: string;
  status: "open" | "contacted" | "converted";
  statusLabel: string;
  tone: "warning" | "info" | "success";
  remindedText: string | null;
  orderId: string | null;
  orderCode: string | null;
  createdText: string;
  createdTs: number;
}

export function LeadsTable({ rows, canWrite, canOpenOrders, statusFilter }: { rows: LeadRow[]; canWrite: boolean; canOpenOrders: boolean; statusFilter?: ReactNode }) {
  return (
    <div className={s.arcTable}>
      <SortableDataTable<LeadRow>
        rows={rows}
        rowKey="id"
        caption="Contatos"
        itemName={{ one: "contato", other: "contatos" }}
        emptyMessage="Nenhum contato com estes filtros"
        defaultSort={{ key: "createdTs", direction: "desc" }}
        columns={[
          {
            key: "code",
            label: "Contato",
            render: (_, l) => (
              <span className={s.leadCell}>
                <b className={s.mono}>#{l.code}</b>
                {l.status === "converted" ? (
                  <small>
                    Comprou:{" "}
                    {l.orderId && canOpenOrders ? (
                      <Link className={`${s.rowLink} ${s.mono}`} href={`/admin/orders/${l.orderId}`}>
                        pedido #{l.orderCode}
                      </Link>
                    ) : (
                      <span className={s.mono}>pedido #{l.orderCode}</span>
                    )}
                  </small>
                ) : (
                  <>
                    {l.email ? <small>{l.email}</small> : null}
                    {l.phone ? <small>{l.phone}</small> : null}
                  </>
                )}
              </span>
            ),
          },
          { key: "offerName", label: "Oferta" },
          {
            key: "statusLabel",
            label: "Status",
            filter: statusFilter,
            render: (_, l) => (
              <span className={s.leadCell}>
                <Badge tone={l.tone}>{l.statusLabel}</Badge>
                {l.remindedText ? <small className={s.leadNote}>{l.remindedText}</small> : null}
              </span>
            ),
          },
          { key: "createdTs", label: "Capturado", render: (_, l) => <span className={`${s.muted} ${s.nowrap}`}>{l.createdText}</span> },
          {
            key: "id",
            label: "Ações",
            sortable: false,
            render: (_, l) =>
              l.status === "converted" ? null : <LeadRowActions id={l.id} code={l.code} status={l.status} email={l.email} whatsapp={l.whatsapp} canWrite={canWrite} />,
          },
        ]}
      />
    </div>
  );
}
