"use client";

// Fila de aprovação do MCP em abas (as do Arc): Pendentes (cada pedido numa linha, com Recusar e Aprovar e executar à
// direita) e Histórico (tabela do Arc). O resumo já vem mascarado da ação `approvals.list`; aqui só se exibe. Sem regra
// de negócio: tudo passa pelas actions do painel.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { Art, Badge } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { Dialog, Live, useActionRunner } from "../../ui";
import { approveRequestAction, rejectRequestAction } from "../actions";
import { decideThenRefresh } from "./decision";

export interface ApprovalRow {
  id: string;
  agent: string;
  agentRole: string;
  description: string;
  tool: string;
  fields: Array<{ label: string; value: string }>;
  notes: string[];
  /** Texto no lugar do resumo para quem não decide este pedido (o resumo nem vem da ação). */
  hiddenSummary: string | null;
  status: string;
  createdAt: string;
  /** Para ordenar "Pedido em" pela data, não pelo texto. */
  createdTs: number;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  error: string | null;
  canDecide: boolean;
}

type HistoryRow = ApprovalRow & { statusLabel: string; decision: string } & Record<string, unknown>;

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  approved: { label: "Aprovado", tone: "success" },
  rejected: { label: "Recusado", tone: "neutral" },
  expired: { label: "Expirado", tone: "neutral" },
  failed: { label: "Falhou", tone: "danger" },
  canceled: { label: "Cancelado", tone: "neutral" },
};

function Summary({ fields, notes }: { fields: ApprovalRow["fields"]; notes: string[] }) {
  return (
    <>
      {fields.length > 0 ? (
        <dl className={s.apFields}>
          {fields.map((f, i) => (
            <div key={`${f.label}-${i}`}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {notes.map((n, i) => (
        <p key={i} className={s.apNote} role="note">
          <PIcon name="info" size={14} />
          <span>{n}</span>
        </p>
      ))}
    </>
  );
}

/** Data e quem decidiu (ou quando venceu), para a coluna "Decisão" do histórico. */
function decisionText(r: ApprovalRow) {
  if (r.decidedAt) return `${r.decidedAt}${r.decidedBy ? ` por ${r.decidedBy}` : ""}`;
  if (r.status === "expired") return `expirou em ${r.expiresAt}`;
  return "—";
}

export function ApprovalsPanel({ pending, history }: { pending: ApprovalRow[]; history: ApprovalRow[] }) {
  const [target, setTarget] = useState<ApprovalRow | null>(null);
  const [tab, setTab] = useState("pendentes");
  const approve = useActionRunner();
  const reject = useActionRunner();
  // Falha ao aprovar ou recusar também muda o pedido (outro decidiu, venceu, a execução falhou): recarrega a lista.
  const router = useRouter();
  const closeApprove = () => {
    approve.setMsg(null);
    setTarget(null);
  };
  const busy = approve.pending || reject.pending;

  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Pedidos de aprovação">
          <TabsTrigger value="pendentes">
            Pendentes{pending.length > 0 ? <span className={s.apCount}>{pending.length}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="pendentes">
          <section className={s.setCard} aria-label="Pedidos pendentes">
            {pending.length === 0 ? (
              <div className={s.empty}>
                <Art name="aprovacoes" size={96} />
                <h2>Nada esperando aprovação</h2>
                <p>Quando um agente pedir uma ação sensível (preço, estorno, chaves), o pedido aparece aqui.</p>
              </div>
            ) : (
              pending.map((r) => (
                <article key={r.id} className={s.apRow} aria-label={`Pedido de ${r.agent}: ${r.description}`}>
                  <Avatar name={r.agent} size="md" />
                  <div className={s.apMain}>
                    <div className={s.apHead}>
                      <b>{r.description}</b>
                      <code className={s.apTool}>{r.tool}</code>
                    </div>
                    <small className={s.apMeta}>
                      {r.agent} <Badge tone="info">{r.agentRole}</Badge> · pedido em {r.createdAt} · expira em {r.expiresAt}
                    </small>
                    {r.hiddenSummary ? <p className={s.apMeta}>{r.hiddenSummary}</p> : <Summary fields={r.fields} notes={r.notes} />}
                    {r.canDecide ? null : <p className={s.hint}>Só quem tem permissão para “{r.description}” decide este pedido.</p>}
                  </div>
                  <div className={s.apActions}>
                    <button
                      type="button"
                      className={`${s.btn} ${s.btnSm} ${s.btnDangerGhost}`}
                      disabled={!r.canDecide || busy}
                      aria-label={`Recusar o pedido: ${r.description}`}
                      onClick={() => {
                        approve.setMsg(null);
                        return decideThenRefresh(() => reject.run(() => rejectRequestAction(r.id)), () => router.refresh());
                      }}
                    >
                      Recusar
                    </button>
                    <button
                      type="button"
                      className={`${s.btn} ${s.btnSm} ${s.btnPrimary}`}
                      disabled={!r.canDecide || busy}
                      aria-label={`Aprovar e executar o pedido: ${r.description}`}
                      onClick={() => {
                        approve.setMsg(null);
                        reject.setMsg(null);
                        setTarget(r);
                      }}
                    >
                      Aprovar e executar
                    </button>
                  </div>
                </article>
              ))
            )}
            <Live msg={target ? null : (reject.msg ?? approve.msg)} />
          </section>
        </TabsContent>

        <TabsContent value="historico">
          <section className={`${s.card} ${s.cardFlush}`} aria-label="Histórico de pedidos">
            {history.length === 0 ? (
              <div className={s.empty}>
                <Art name="aprovacoes" size={96} />
                <h2>Nada decidido ainda</h2>
                <p>Pedidos aprovados, recusados ou vencidos ficam aqui.</p>
              </div>
            ) : (
              <div className={s.arcTable}>
                <SortableDataTable<HistoryRow>
                  rows={history.map((r) => ({ ...r, statusLabel: (STATUS[r.status] ?? { label: r.status }).label, decision: decisionText(r) }))}
                  rowKey="id"
                  caption="Histórico de pedidos de aprovação"
                  columns={[
                    {
                      key: "description",
                      label: "Pedido",
                      render: (_, r) => (
                        <span className={s.leadCell}>
                          <b>{r.description}</b>
                          <small className={s.mono}>{r.tool}</small>
                        </span>
                      ),
                    },
                    {
                      key: "agent",
                      label: "Agente",
                      render: (_, r) => (
                        <span className={s.leadCell}>
                          {r.agent}
                          <small>{r.agentRole}</small>
                        </span>
                      ),
                    },
                    {
                      key: "statusLabel",
                      label: "Status",
                      render: (_, r) => {
                        const st = STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
                        return (
                          <span className={s.leadCell}>
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {r.error ? <small className={s.cellError}>Erro: {r.error}</small> : null}
                          </span>
                        );
                      },
                    },
                    { key: "createdTs", label: "Pedido em", numeric: false, render: (_, r) => <span className={s.nowrap}>{r.createdAt}</span> },
                    { key: "decision", label: "Decisão", sortable: false, render: (_, r) => <span className={s.muted}>{r.decision}</span> },
                  ]}
                />
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>

      <Dialog
        open={target !== null}
        onClose={closeApprove}
        title={`Aprovar e executar ${target?.description ?? ""} agora?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={closeApprove} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnPrimary}`}
              disabled={approve.pending || approve.msg?.tone === "error"}
              onClick={async () => {
                if (!target) return;
                reject.setMsg(null);
                const r = await decideThenRefresh(() => approve.run(() => approveRequestAction(target.id)), () => router.refresh());
                if (r.ok) setTarget(null);
              }}
            >
              {approve.pending ? "Executando…" : "Aprovar e executar"}
            </button>
          </>
        }
      >
        {target ? <Summary fields={target.fields} notes={target.notes} /> : null}
        {approve.msg?.tone === "error" ? <Live msg={approve.msg} /> : null}
      </Dialog>
    </>
  );
}
