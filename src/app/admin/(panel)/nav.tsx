"use client";

// Navegação do painel: ícones e itens (a sidebar do desktop fica em sidebar.tsx; aqui, as abas do celular).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Bot, ClipboardCheck, KeyRound, LayoutDashboard, LogOut, Mail, Menu, Package, Plug, ReceiptText, Settings, Tag, Users, type LucideIcon } from "lucide-react";
import s from "../panel.module.css";

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

export const isActive = (path: string, href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));

export function TabBar({ items, logout }: { items: NavEntry[]; logout: () => Promise<void> }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
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
          <Link className={s.navItem} href="/admin/senha" onClick={() => setOpen(false)}>
            <KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />
            Trocar senha
          </Link>
          <form action={logout}>
            <button type="submit" className={s.navItem} style={{ width: "100%", border: 0, background: "none", font: "inherit", cursor: "pointer" }}>
              <LogOut size={18} strokeWidth={1.75} aria-hidden="true" />
              Sair
            </button>
          </form>
        </div>
      ) : null}
    </nav>
  );
}
