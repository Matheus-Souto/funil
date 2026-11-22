import { notFound } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { dateTimeSP } from "@/lib/format";
import { HIDDEN_SUMMARY, listApprovals } from "@/lib/mcp/approvals";
import { TOKEN_ROLE_LABEL } from "@/lib/mcp/tools";
import { PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { ApprovalsPanel, type ApprovalRow } from "./approvals-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Aprovações" };

export default async function ApprovalsPage() {
  const panel = await requirePanelActor();
  // Mesmo padrão das páginas protegidas por papel: quem não decide pedidos vê 404.
  if (!hasPermission(panel.actor.role, "approvals.decide")) notFound();
  const list = await runAction(listApprovals, { ...panel, origin: "panel" }, {});
  const row = (r: (typeof list.pending)[number]): ApprovalRow => ({
    id: r.id,
    agent: r.tokenName,
    agentRole: TOKEN_ROLE_LABEL[r.tokenRole] ?? r.tokenRole,
    description: r.description,
    tool: r.tool,
    fields: r.summary?.fields ?? [],
    notes: r.summary?.notes ?? [],
    hiddenSummary: r.summary === null ? HIDDEN_SUMMARY : null,
    status: r.status,
    createdAt: dateTimeSP(r.createdAt),
    expiresAt: dateTimeSP(r.expiresAt),
    decidedAt: r.decidedAt ? dateTimeSP(r.decidedAt) : null,
    decidedBy: r.decidedBy,
    error: r.error,
    canDecide: r.canDecide,
  });
  return (
    <>
      <PageHead title="Aprovações" />
      <div className={s.alerts}>
        <div className={s.banner} data-tone="info" role="note">
          <PIcon name="shield-check" />
          <div>
            <p>
              Os pedidos valem por 7 dias. Ao aprovar, a ação roda agora, em seu nome. Chaves e senhas aparecem só pelos 4 últimos caracteres; a chave
              Pix aparece inteira, para você conferir para onde vai o dinheiro.
            </p>
          </div>
        </div>
      </div>
      <ApprovalsPanel pending={list.pending.map(row)} history={list.history.map(row)} />
    </>
  );
}
