import { notFound } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { dateTimeSP } from "@/lib/format";
import { listMcpTokens } from "@/lib/mcp/tokens";
import { getStoreSettings } from "@/lib/store-settings";
import Link from "next/link";
import { Notice, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import { NewTokenButton, TokensTable, type TokenRow } from "./tokens-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agentes (MCP)" };

export default async function TokensPage() {
  const panel = await requirePanelActor();
  // Mesmo padrão das páginas protegidas por papel (offers/[id]): quem não tem a permissão vê 404, não um aviso.
  if (!hasPermission(panel.actor.role, "team.manage")) notFound();
  const ctx = { ...panel, origin: "panel" as const };
  const [list, st] = await Promise.all([runAction(listMcpTokens, ctx, {}), runAction(getStoreSettings, ctx, {})]);
  const tokens: TokenRow[] = list.map((t) => ({
    id: t.id,
    name: t.name,
    role: t.role,
    last4: t.last4,
    createdAt: dateTimeSP(t.createdAt),
    createdTs: t.createdAt.getTime(),
    createdBy: t.createdBy,
    lastUsedAt: t.lastUsedAt ? dateTimeSP(t.lastUsedAt) : null,
    // Ordenação de "Último uso": revogados e nunca usados vão para o fim (0).
    lastUsedTs: t.revokedAt ? 0 : (t.lastUsedAt?.getTime() ?? 0),
    revokedAt: t.revokedAt ? dateTimeSP(t.revokedAt) : null,
  }));
  const mcpUrl = `${st.checkoutBaseUrl.replace(/\/+$/, "")}/api/mcp`;
  return (
    <>
      <PageHead title="Agentes (MCP)" actions={<NewTokenButton mcpUrl={mcpUrl} />} />
      <div className={s.noticeStrip}>
        <Notice tone="info" action={<Link href="/admin/aprovacoes">Aprovações</Link>}>
          O agente nunca recebe nome, e-mail, telefone ou CPF de comprador. Ações sensíveis pedidas por ele esperam a sua aprovação.
        </Notice>
      </div>
      <TokensTable tokens={tokens} />
    </>
  );
}
