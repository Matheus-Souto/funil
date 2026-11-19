import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelActor, getPanelIdentity } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/orders/labels";
import { orderCounts } from "@/lib/orders/panel";
import { needsSetup } from "@/lib/stores";
import { PIcon } from "../icons";
import s from "../panel.module.css";
import { logoutAction } from "./actions";
import { SideNav, TabBar, type NavEntry } from "./nav";

export const dynamic = "force-dynamic";

// Moldura de tudo em /admin/(panel) (Sidebar do painel do design; abas no celular). /admin/login e /admin/setup ficam
// fora do grupo. O layout NÃO protege páginas nem server actions sozinho: cada uma chama requirePanelActor().
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const panel = await getPanelActor();
  if (!panel) redirect((await needsSetup()) ? "/admin/setup" : "/admin/login");
  const role = panel.actor.role;
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(role, p);
  const id = await getPanelIdentity(panel);
  const pending = can("orders.read") ? (await runAction(orderCounts, { ...panel, origin: "panel" }, {})).pendingManual : 0;

  const items: NavEntry[] = [
    ...(can("metrics.read") ? [{ href: "/admin", label: "Visão geral", icon: "layout-dashboard" as const }] : []),
    ...(can("orders.read") ? [{ href: "/admin/orders", label: "Pedidos", icon: "receipt" as const, badge: pending }] : []),
    ...(can("offers.read") ? [{ href: "/admin/offers", label: "Ofertas", icon: "tag" as const }] : []),
    ...(can("products.read") ? [{ href: "/admin/products", label: "Produtos", icon: "package" as const }] : []),
    ...(can("connections.read")
      ? [
          { href: "/admin/connections", label: "Conexões", icon: "plug" as const, section: "loja" as const },
          { href: "/admin/settings", label: "Configurações", icon: "settings" as const, section: "loja" as const },
        ]
      : []),
  ];

  return (
    <div className={s.root}>
      <a href="#conteudo" className={s.srOnly}>
        Pular para o conteúdo
      </a>
      <header className={s.mobileTop}>
        <Link href="/admin" className={s.brand}>
          funil
        </Link>
        <span className={s.storeName}>· {id.storeName}</span>
        <button type="button" className={s.iconBtn} disabled aria-label="Pergunte à IA (em breve)" title="Pergunte à IA chega na próxima fase">
          <PIcon name="sparkles" />
        </button>
      </header>
      <div className={s.shell}>
        <aside className={s.sidebar} aria-label="Menu do painel">
          <Link href="/admin" className={s.brand}>
            funil
          </Link>
          <div className={s.storeBox}>
            <span>
              <b>{id.storeName}</b>
              <small>{ROLE_LABEL[role]}</small>
            </span>
          </div>
          <button type="button" className={s.ai} aria-disabled="true" title="Pergunte à IA chega na próxima fase">
            <PIcon name="sparkles" />
            <span>Pergunte à IA</span>
            <kbd>Ctrl K</kbd>
          </button>
          <nav aria-label="Navegação do painel" style={{ display: "contents" }}>
            <SideNav items={items} />
          </nav>
          <div className={s.userFoot}>
            <span className={s.avatar}>
              <PIcon name="user" />
            </span>
            <span className={s.userText}>
              <b>{id.userName}</b>
              <small>{id.userEmail}</small>
            </span>
            <form action={logoutAction}>
              <button type="submit" className={s.iconBtn} aria-label="Sair" title="Sair">
                <PIcon name="log-out" />
              </button>
            </form>
          </div>
        </aside>
        <main id="conteudo" className={s.main}>
          <div className={s.mainInner}>{children}</div>
        </main>
      </div>
      <TabBar items={items} logout={logoutAction} />
    </div>
  );
}
