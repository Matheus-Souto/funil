"use client";

import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import { bpPercent, brl } from "@/lib/format";
import type { TrialsCampaign } from "@/lib/metrics";
import s from "../panel.module.css";

type Row = TrialsCampaign & Record<string, unknown>;

/** Testes do app por campanha (`utm_campaign` do primeiro toque do teste): testes, pagantes, conversão e receita. */
export function AppTrialsTable({ rows }: { rows: TrialsCampaign[] }) {
  return (
    <div className={s.arcTable}>
      <SortableDataTable<Row>
        rows={rows as Row[]}
        rowKey="campaign"
        caption="Testes do app por campanha"
        emptyMessage="Nenhum teste iniciado no período."
        defaultSort={{ key: "trials", direction: "desc" }}
        columns={[
          { key: "campaign", label: "Campanha", render: (_, r) => <b>{r.campaign}</b> },
          { key: "trials", label: "Testes", numeric: true },
          { key: "paying", label: "Pagantes", numeric: true },
          { key: "conversionBp", label: "Conversão", numeric: true, render: (_, r) => bpPercent(r.conversionBp) },
          { key: "revenueCents", label: "Receita", numeric: true, render: (_, r) => brl(r.revenueCents) },
        ]}
      />
    </div>
  );
}
