"use client";

// Fila de aprovação do MCP: pedidos pendentes (aprovar e executar, ou recusar) e o histórico. O resumo já vem mascarado
// da ação `approvals.list`; aqui só se exibe. Sem regra de negócio: tudo passa pelas actions do painel.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "../../blocks";
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
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  error: string | null;
  canDecide: boolean;
}

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  approved: { label: "Aprovado", tone: "success" },
  rejected: { label: "Recusado", tone: "neutral" },
  expired: { label: "Expirado", tone: "neutral" },
  failed: { label: "Falhou", tone: "danger" },
  canceled: { label: "Cancelado", tone: "neutral" },
};

const wrap = { overflowWrap: "anywhere", whiteSpace: "pre-wrap" } as const;

function Summary({ fields, notes }: { fields: ApprovalRow["fields"]; notes: string[] }) {
  return (
    <>
      {fields.length > 0 ? (
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0, max-content) minmax(0, 1fr)", gap: "6px 16px" }}>
          {fields.map((f, i) => (
            <div key={`${f.label}-${i}`} style={{ display: "contents" }}>
              <dt className={s.muted}>{f.label}</dt>
              <dd style={{ margin: 0, fontWeight: 600, ...wrap }}>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {notes.map((n, i) => (
        <div key={i} className={s.banner} role="note">
          <div>
            <p style={wrap}>{n}</p>
          </div>
        </div>
      ))}
    </>
  );
}

export function ApprovalsPanel({ pending, history }: { pending: ApprovalRow[]; history: ApprovalRow[] }) {
  const [target, setTarget] = useState<ApprovalRow | null>(null);
  const approve = useActionRunner();
  const reject = useActionRunner();
  // Falha ao aprovar ou recusar também muda o pedido (outro decidiu, venceu, a execução falhou): recarrega a lista.
  const router = useRouter();
  const closeApprove = () => {
    approve.setMsg(null);
    setTarget(null);
  };

  return (
    <>
      <div className={s.stack}>
        <section className={s.card} aria-labelledby="aprov-pendentes">
          <h2 id="aprov-pendentes" className={s.sectionTitle}>
            Pendentes
          </h2>
          {pending.length === 0 ? <p className={s.muted}>Nenhum pedido de agente esperando aprovação.</p> : null}
          <div className={s.stack}>
            {pending.map((r) => (
              <article key={r.id} className={s.card} aria-label={`Pedido de ${r.agent}: ${r.description}`}>
                <div className={s.stack}>
                  <div>
                    <b style={wrap}>{r.description}</b>{" "}
                    <code className={s.mono} style={wrap}>
                      {r.tool}
                    </code>
                    <br />
                    <small className={s.muted}>
                      Agente: {r.agent} <Badge tone="info">{r.agentRole}</Badge>
                      <br />
                      Pedido em {r.createdAt} · expira em {r.expiresAt}
                    </small>
                  </div>
                  {r.hiddenSummary ? <p className={s.muted}>{r.hiddenSummary}</p> : <Summary fields={r.fields} notes={r.notes} />}
                  <div className={s.formActions}>
                    <button
                      type="button"
                      className={`${s.btn} ${s.btnPrimary}`}
                      disabled={!r.canDecide || approve.pending || reject.pending}
                      aria-label={`Aprovar e executar o pedido: ${r.description}`}
                      onClick={() => {
                        approve.setMsg(null);
                        reject.setMsg(null);
                        setTarget(r);
                      }}
                    >
                      Aprovar e executar
                    </button>
                    <button
                      type="button"
                      className={`${s.btn} ${s.btnDanger}`}
                      disabled={!r.canDecide || approve.pending || reject.pending}
                      aria-label={`Recusar o pedido: ${r.description}`}
                      onClick={() => {
                        approve.setMsg(null);
                        return decideThenRefresh(() => reject.run(() => rejectRequestAction(r.id)), () => router.refresh());
                      }}
                    >
                      Recusar
                    </button>
                  </div>
                  {r.canDecide ? null : <p className={s.hint}>Só quem tem permissão para “{r.description}” decide este pedido.</p>}
                </div>
              </article>
            ))}
          </div>
          <Live msg={target ? null : (reject.msg ?? approve.msg)} />
        </section>

        <section className={s.card} aria-labelledby="aprov-historico">
          <h2 id="aprov-historico" className={s.sectionTitle}>
            Histórico
          </h2>
          {history.length === 0 ? (
            <p className={s.muted}>Nada decidido ainda.</p>
          ) : (
            <div className={s.rows}>
              {history.map((r) => {
                const st = STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
                return (
                  <div className={s.row} key={r.id} style={{ alignItems: "flex-start" }}>
                    <span style={{ minWidth: 0, ...wrap }}>
                      <b>{r.description}</b> <Badge tone={st.tone}>{st.label}</Badge>
                      <br />
                      <small className={s.muted}>
                        {r.agent} ({r.agentRole}) · pedido em {r.createdAt}
                        {r.decidedAt ? ` · decidido em ${r.decidedAt}${r.decidedBy ? ` por ${r.decidedBy}` : ""}` : r.status === "expired" ? ` · expirou em ${r.expiresAt}` : ""}
                      </small>
                      {r.error ? (
                        <>
                          <br />
                          <small>Erro: {r.error}</small>
                        </>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <Dialog
        open={target !== null}
        onClose={closeApprove}
        icon="shield-check"
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
