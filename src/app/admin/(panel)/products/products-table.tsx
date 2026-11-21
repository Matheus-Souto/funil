"use client";

// Tabela de produtos com a sortable-data-table do Arc (ordena pelos títulos das colunas).
import type { ReactNode } from "react";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Badge } from "../../blocks";
import s from "../../panel.module.css";
import { PdfViewerButton, ProductCell } from "./pdf-view";

export interface ProductRow extends Record<string, unknown> {
  id: string;
  name: string;
  pages: number | null;
  file: string;
  inUse: boolean;
  usageLabel: string;
  usedIn: string[];
  createdText: string;
  createdTs: number;
}

export function ProductsTable({ rows, canView, statusFilter }: { rows: ProductRow[]; canView: boolean; statusFilter?: ReactNode }) {
  return (
    <div className={s.arcTable}>
      <SortableDataTable<ProductRow>
        rows={rows}
        rowKey="id"
        caption="Produtos"
        itemName={{ one: "produto", other: "produtos" }}
        emptyMessage="Nenhum produto com estes filtros"
        defaultSort={{ key: "createdTs", direction: "desc" }}
        columns={[
          { key: "name", label: "Produto", render: (_, p) => <ProductCell name={p.name} pages={p.pages} /> },
          { key: "file", label: "Arquivo", render: (_, p) => <span className={s.muted}>{p.file}</span> },
          { key: "usageLabel", label: "Status", filter: statusFilter, render: (_, p) => <Badge tone={p.inUse ? "success" : "neutral"}>{p.usageLabel}</Badge> },
          {
            key: "usedIn",
            label: "Usado em",
            sortable: false,
            render: (_, p) =>
              p.usedIn.length ? (
                <span className={s.chips}>
                  {p.usedIn.map((u) => (
                    <span key={u} className={s.chip} data-tone="primary">
                      {u}
                    </span>
                  ))}
                </span>
              ) : (
                <span className={s.muted}>—</span>
              ),
          },
          { key: "createdTs", label: "Enviado", render: (_, p) => <span className={`${s.muted} ${s.nowrap}`}>{p.createdText}</span> },
          // PDF original (sem carimbo): só dono e admin (products.file exige products.write).
          ...(canView ? [{ key: "id", label: "Ver", sortable: false, render: (_: unknown, p: ProductRow) => <PdfViewerButton id={p.id} name={p.name} /> }] : []),
        ]}
      />
    </div>
  );
}
