import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { CHANGE_PASSWORD_PATH, getPanelActor, getPanelIdentity } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { errorFields, log } from "@/lib/log";
import { pendingApprovalsCount } from "@/lib/mcp/approvals";
import { orderCounts } from "@/lib/orders/panel";
import { needsSetup } from "@/lib/stores";
import { accountStores } from "@/lib/team/members";
import { PIcon } from "../icons";
import s from "../panel.module.css";
import { logoutAction } from "./actions";
import { TabBar, type NavEntry } from "./nav";
import { BrandLogo } from "../brand";
import { PanelShell } from "./sidebar";

export const dynamic = "force-dynamic";

// Moldura de tudo em /admin/(panel) (Sidebar do painel do design; abas no celular). /admin/login e /admin/setup ficam
// fora do grupo. O layout NÃO protege páginas nem server actions sozinho: cada uma chama requirePanelActor().
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const panel = await getPanelActor();
  if (!panel) redirect((await needsSetup()) ? "/admin/setup" : "/admin/login");
  if (panel.mustChangePassword) redirect(CHANGE_PASSWORD_PATH);
  const role = panel.actor.role;
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(role, p);
  const id = await getPanelIdentity(panel);
  const pending = can("orders.read") ? (await runAction(orderCounts, { ...panel, origin: "panel" }, {})).pendingManual : 0;

  // Selo do menu: se a contagem falhar, o menu aparece sem selo (não derruba o layout).
  const approvals = can("approvals.decide")
    ? await runAction(pendingApprovalsCount, { ...panel, origin: "panel" }, {}).then(
        (r) => r.count,
        () => 0,
      )
    : 0;

  const jar = await cookies();
  const theme = jar.get("funil-theme")?.value;

  const items: NavEntry[] = [
    ...(can("metrics.read") ? [{ href: "/admin", label: "Dashboard", icon: "layout-dashboard" as const }] : []),
    ...(can("orders.read") ? [{ href: "/admin/orders", label: "Pedidos", icon: "receipt" as const, badge: pending }] : []),
    ...(can("offers.read") ? [{ href: "/admin/offers", label: "Ofertas", icon: "tag" as const }] : []),
    ...(can("products.read") ? [{ href: "/admin/products", label: "Produtos", icon: "package" as const }] : []),
    // Depois de Produtos: no celular as 3 primeiras abas (Visão geral, Pedidos, Ofertas) não mudam; Contatos fica em "Mais".
    ...(can("leads.read") ? [{ href: "/admin/contatos", label: "Contatos", icon: "mail" as const }] : []),
    ...(can("connections.read")
      ? [
          { href: "/admin/connections", label: "Conexões", icon: "plug" as const, section: "loja" as const },
          { href: "/admin/settings", label: "Configurações", icon: "settings" as const, section: "loja" as const },
        ]
      : []),
    ...(can("approvals.decide")
      ? [{ href: "/admin/aprovacoes", label: "Aprovações", icon: "circle-check" as const, section: "loja" as const, ...(approvals > 0 ? { badge: approvals } : {}) }]
      : []),
    ...(can("team.manage")
      ? [
          { href: "/admin/tokens", label: "Agentes (MCP)", icon: "code" as const, section: "loja" as const },
          { href: "/admin/equipe", label: "Equipe", icon: "users" as const, section: "loja" as const },
        ]
      : []),
  ];

  // "Suas lojas" (só no MODE=multi e só com mais de uma loja). Se a consulta falhar, o menu aparece sem a lista: recusa
  // da ação (ActionError) é esperada; qualquer outro erro vai para o log, só com ids e códigos (sem dado pessoal).
  const stores =
    env.MODE === "multi"
      ? await runAction(accountStores, { ...panel, origin: "panel" }, {}).then(
          (r) => (r.length > 1 ? r.map((x) => ({ name: x.name, url: x.panelUrl, current: x.current })) : []),
          (e: unknown) => {
            if (!(e instanceof ActionError)) log.error("painel: falha ao listar as lojas da conta", { storeId: panel.storeId, ...errorFields(e) });
            return [];
          },
        )
      : [];

  return (
    <div className={s.root}>
      <a href="#conteudo" className={s.srOnly}>
        Pular para o conteúdo
      </a>
      <header className={s.mobileTop}>
        <Link href="/admin" className={s.brand} aria-label="PingaPay, dashboard">
          <BrandLogo />
        </Link>
        <span className={s.storeName}>· {id.storeName}</span>
        <button type="button" className={s.iconBtn} disabled aria-label="Pergunte à IA (em breve)" title="Pergunte à IA chega na próxima fase">
          <PIcon name="sparkles" />
        </button>
      </header>
      <PanelShell
        items={items}
        id={{ storeName: id.storeName, userName: id.userName, userEmail: id.userEmail }}
        logout={logoutAction}
        stores={stores}
        initialCollapsed={jar.get("funil-sidebar")?.value === "collapsed"}
        initialTheme={theme === "light" || theme === "dark" ? theme : undefined}
      >
        {children}
      </PanelShell>
      <TabBar items={items} stores={stores} logout={logoutAction} />
    </div>
  );
}
