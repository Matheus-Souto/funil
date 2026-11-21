import { notFound } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { dateTimeSP } from "@/lib/format";
import { listMcpTokens } from "@/lib/mcp/tokens";
import { getStoreSettings } from "@/lib/store-settings";
import { PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { TokensPanel, type TokenRow } from "./tokens-panel";

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
    createdBy: t.createdBy,
    lastUsedAt: t.lastUsedAt ? dateTimeSP(t.lastUsedAt) : null,
    revokedAt: t.revokedAt ? dateTimeSP(t.revokedAt) : null,
  }));
  return (
    <>
      <PageHead title="Agentes (MCP)" sub="Tokens para um agente de IA consultar a loja pelo protocolo MCP." />
      <div className={s.alerts}>
        <div className={s.banner} data-tone="info" role="note">
          <PIcon name="shield-check" />
          <div>
            <p>
              O agente nunca recebe nome, e-mail, telefone ou CPF de comprador. Ações sensíveis pedidas pelo agente esperam aprovação em Aprovações.
            </p>
          </div>
        </div>
      </div>
      <TokensPanel tokens={tokens} mcpUrl={`${st.checkoutBaseUrl.replace(/\/+$/, "")}/api/mcp`} />
    </>
  );
}
