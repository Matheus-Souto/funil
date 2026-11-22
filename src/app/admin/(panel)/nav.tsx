"use client";

// Navegação do painel: ícones e itens (a sidebar do desktop fica em sidebar.tsx; aqui, as abas do celular).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Bot, ClipboardCheck, DoorOpen, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Package, Plug, ReceiptText, Settings, Store, Tag, Users, type LucideIcon } from "lucide-react";
import s from "../panel.module.css";
import { Dialog, Live, useActionRunner } from "../ui";
import { leaveStoreAction } from "./actions";

const ICONS = {
  "layout-dashboard": LayoutDashboard,
  receipt: ReceiptText,
  tag: Tag,
  package: Package,
  mail: Mail,
  plug: Plug,
  settings: Settings,
  "circle-check": ClipboardCheck,
  code: Bot,
  users: Users,
} satisfies Record<string, LucideIcon>;

export type NavIconName = keyof typeof ICONS;

export function NavIcon({ name, size = 18 }: { name: NavIconName; size?: number }) {
  const Icon = ICONS[name];
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}

export interface NavEntry {
  href: string;
  label: string;
  icon: NavIconName;
  badge?: number;
  section?: "loja";
}

/** Uma loja da conta no menu "Suas lojas" (MODE=multi): o link abre o painel dela. */
export interface StoreLink {
  name: string;
  url: string;
  current: boolean;
}

export const isActive = (path: string, href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));

/**
 * "Sair da loja" do menu do usuário (sidebar e "Mais"): vale para qualquer papel, então não pode depender da página
 * Equipe (só `team.manage`). Quem chama esconde o botão da única dona; `team.leave` confere de novo, sob o lock.
 */
export function LeaveStoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const act = useActionRunner();
  const close = () => {
    act.setMsg(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      tone="danger"
      title="Sair da loja?"
      footer={
        <>
          <button type="button" className={s.btn} onClick={close} data-autofocus>
            Cancelar
          </button>
          <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={act.pending} onClick={() => act.run(() => leaveStoreAction())}>
            <DoorOpen size={16} strokeWidth={1.75} aria-hidden="true" />
            {act.pending ? "Saindo…" : "Sair da loja"}
          </button>
        </>
      }
    >
      <p>Você sai da equipe desta loja e volta para a tela de login. Para voltar, alguém precisa convidar você de novo. A sua conta continua existindo.</p>
      <p>Os tokens MCP e os convites pendentes que você criou nesta loja deixam de valer.</p>
      {act.msg?.tone === "error" ? <Live msg={act.msg} /> : null}
    </Dialog>
  );
}

export function TabBar({
  items,
  stores = [],
  logout,
  canLeave = false,
}: {
  items: NavEntry[];
  stores?: StoreLink[];
  logout: () => Promise<void>;
  /** Mostra "Sair da loja" (escondido para a única dona). */
  canLeave?: boolean;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const tabs = items.filter((i) => !i.section).slice(0, 3);
  const more = items.filter((i) => !tabs.includes(i));
  return (
    <nav className={s.tabs} aria-label="Navegação do painel">
      {tabs.map((i) => (
        <Link key={i.href} className={s.tab} href={i.href} aria-current={isActive(path, i.href) ? "page" : undefined}>
          <NavIcon name={i.icon} size={22} />
          {i.badge ? <span className={s.tabBadge}>{i.badge}</span> : null}
          {i.label}
        </Link>
      ))}
      <button
        type="button"
        className={s.tab}
        aria-expanded={open}
        aria-controls="mais-menu"
        aria-current={more.some((i) => isActive(path, i.href)) ? "page" : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Menu size={22} strokeWidth={1.75} aria-hidden="true" />
        Mais
      </button>
      {open ? (
        <div id="mais-menu" className={s.moreSheet} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {more.map((i) => (
            <Link key={i.href} className={s.navItem} href={i.href} aria-current={isActive(path, i.href) ? "page" : undefined} onClick={() => setOpen(false)}>
              <NavIcon name={i.icon} />
              {i.label}
            </Link>
          ))}
          {/* Suas lojas (MODE=multi): cada loja tem a própria sessão; o link abre o painel dela, que pede a senha. */}
          {stores
            .filter((st) => !st.current)
            .map((st) => (
              <a key={st.url} className={s.navItem} href={st.url}>
                <Store size={18} strokeWidth={1.75} aria-hidden="true" />
                {st.name}
              </a>
            ))}
          <Link className={s.navItem} href="/admin/senha" onClick={() => setOpen(false)}>
            <KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />
            Trocar senha
          </Link>
          {canLeave ? (
            <button
              type="button"
              className={s.navItem}
              style={{ width: "100%", border: 0, background: "none", font: "inherit", cursor: "pointer" }}
              onClick={() => {
                setOpen(false);
                setLeaving(true);
              }}
            >
              <DoorOpen size={18} strokeWidth={1.75} aria-hidden="true" />
              Sair da loja
            </button>
          ) : null}
          <form action={logout}>
            <button type="submit" className={s.navItem} style={{ width: "100%", border: 0, background: "none", font: "inherit", cursor: "pointer" }}>
              <LogOut size={18} strokeWidth={1.75} aria-hidden="true" />
              Sair
            </button>
          </form>
        </div>
      ) : null}
      {canLeave ? <LeaveStoreDialog open={leaving} onClose={() => setLeaving(false)} /> : null}
    </nav>
  );
}
