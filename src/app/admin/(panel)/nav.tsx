"use client";

// Navegação do painel (sidebar no desktop, abas no celular). Só mostra o que o papel pode abrir.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PIcon, type PanelIconName } from "../icons";
import s from "../panel.module.css";

export interface NavEntry {
  href: string;
  label: string;
  icon: PanelIconName;
  badge?: number;
  section?: "loja";
}

const isActive = (path: string, href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));

export function SideNav({ items }: { items: NavEntry[] }) {
  const path = usePathname();
  const main = items.filter((i) => !i.section);
  const store = items.filter((i) => i.section === "loja");
  const link = (i: NavEntry) => (
    <li key={i.href}>
      <Link className={s.navItem} href={i.href} aria-current={isActive(path, i.href) ? "page" : undefined}>
        <PIcon name={i.icon} />
        {i.label}
        {i.badge ? (
          <span className={s.navBadge} aria-label={`${i.badge} aguardando`}>
            {i.badge}
          </span>
        ) : null}
      </Link>
    </li>
  );
  return (
    <ul className={s.nav}>
      {main.map(link)}
      <li className={s.navSep} aria-hidden="true">
        Loja
      </li>
      {store.map(link)}
      <li>
        <span className={s.navItem} aria-disabled="true" title="Convites para a equipe chegam na próxima fase">
          <PIcon name="users" />
          Equipe
          <span className={s.navTag}>em breve</span>
        </span>
      </li>
    </ul>
  );
}

export function TabBar({ items, logout }: { items: NavEntry[]; logout: () => Promise<void> }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const tabs = items.filter((i) => !i.section).slice(0, 3);
  const more = items.filter((i) => !tabs.includes(i));
  return (
    <nav className={s.tabs} aria-label="Navegação do painel">
      {tabs.map((i) => (
        <Link key={i.href} className={s.tab} href={i.href} aria-current={isActive(path, i.href) ? "page" : undefined}>
          <PIcon name={i.icon} size={22} />
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
        <PIcon name="menu" size={22} />
        Mais
      </button>
      {open ? (
        <div id="mais-menu" className={s.moreSheet} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {more.map((i) => (
            <Link key={i.href} className={s.navItem} href={i.href} aria-current={isActive(path, i.href) ? "page" : undefined} onClick={() => setOpen(false)}>
              <PIcon name={i.icon} />
              {i.label}
            </Link>
          ))}
          <form action={logout}>
            <button type="submit" className={s.navItem} style={{ width: "100%", border: 0, background: "none", font: "inherit", cursor: "pointer" }}>
              <PIcon name="log-out" />
              Sair
            </button>
          </form>
        </div>
      ) : null}
    </nav>
  );
}
