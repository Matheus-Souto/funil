"use client";

// Moldura do painel no desktop: sidebar que expande e recolhe (lembrada no cookie `funil-sidebar`), ícones Lucide,
// dicas com o nome do item quando recolhida e a troca de tema (claro/escuro, lembrada no cookie `funil-theme`).
import Image from "next/image";
import Link from "next/link";
import { Art } from "../blocks";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { KeyRound, LogOut, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { ThemeSwitch, type Theme } from "@/components/arc/theme-switch/theme-switch";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import s from "../panel.module.css";
import { NavIcon, isActive, type NavEntry } from "./nav";

const YEAR = 60 * 60 * 24 * 365;
const setCookie = (name: string, value: string) => {
  document.cookie = `${name}=${value}; path=/; max-age=${YEAR}; samesite=lax`;
};

/** Tema aplicado agora: o atributo do <html> (escolha salva) ou, sem ele, o do sistema. */
function currentTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Tema aplicado, lido do DOM (atributo do <html> e preferência do sistema) e atualizado quando muda. */
function subscribeTheme(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", onChange);
  };
}

function useTheme(initial: Theme | undefined) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => initial ?? "light");
  const change = useCallback((next: Theme, trigger: HTMLElement) => {
    const apply = () => {
      document.documentElement.dataset.theme = next;
      setCookie("funil-theme", next);
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || reduced) return apply();
    const { left, top, width, height } = trigger.getBoundingClientRect();
    document.documentElement.style.setProperty("--x", `${left + width / 2}px`);
    document.documentElement.style.setProperty("--y", `${top + height / 2}px`);
    document.startViewTransition(apply);
  }, []);
  return [theme, change] as const;
}

/** Mostra a dica só com a sidebar recolhida (aberta, o texto já está visível). */
function Tip({ show, label, side = "right", children }: { show: boolean; label: string; side?: "top" | "right"; children: React.ReactElement }) {
  return show ? (
    <Tooltip content={label} side={side}>
      {children}
    </Tooltip>
  ) : (
    children
  );
}

export interface ShellIdentity {
  storeName: string;
  userName: string;
  userEmail: string;
}

export function PanelShell({
  items,
  id,
  logout,
  initialCollapsed,
  initialTheme,
  children,
}: {
  items: NavEntry[];
  id: ShellIdentity;
  logout: () => Promise<void>;
  initialCollapsed: boolean;
  initialTheme: Theme | undefined;
  children: ReactNode;
}) {
  const path = usePathname();
  const reduced = useReducedMotion();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  // Destaque que desliza entre os itens ao passar o mouse (o mesmo efeito do menu de filtros).
  const [hovered, setHovered] = useState<string | null>(null);
  const glide = reduced ? { duration: 0 } : ({ type: "spring", visualDuration: 0.16, bounce: 0.15 } as const);
  const hoverBg = (key: string) =>
    hovered === key ? <motion.span layoutId="nav-hover" className={s.navHover} transition={glide} aria-hidden="true" /> : null;
  const [theme, changeTheme] = useTheme(initialTheme);

  const toggle = useCallback(() => {
    setCollapsed((v) => {
      setCookie("funil-sidebar", v ? "open" : "collapsed");
      return !v;
    });
  }, []);

  // Ctrl/⌘ + B expande ou recolhe, como em editores e no Linear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const main = items.filter((i) => !i.section);
  const store = items.filter((i) => i.section === "loja");
  const initials = id.userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  const link = (i: NavEntry) => {
    const active = isActive(path, i.href);
    return (
      <li key={i.href}>
        <Tip show={collapsed} label={i.badge ? `${i.label} (${i.badge})` : i.label}>
          <Link
            className={s.navItem}
            href={i.href}
            aria-current={active ? "page" : undefined}
            aria-label={collapsed ? i.label : undefined}
            onMouseEnter={() => setHovered(i.href)}
            onFocus={() => setHovered(i.href)}
          >
            {hoverBg(i.href)}
            <span className={s.navIcon}>
              <NavIcon name={i.icon} size={16} />
              {i.badge && collapsed ? <span className={s.navDot} aria-hidden="true" /> : null}
            </span>
            <span className={s.navLabel}>{i.label}</span>
            {i.badge ? (
              <span className={s.navBadge} aria-label={`${i.badge} aguardando`}>
                {i.badge}
              </span>
            ) : null}
          </Link>
        </Tip>
      </li>
    );
  };

  return (
    <div className={s.shell} data-collapsed={collapsed ? "true" : undefined}>
      <aside className={s.sidebar} aria-label="Menu do painel">
        <div className={s.sideTop}>
          <Link href="/admin" className={s.brand} aria-label="PingaPay, dashboard">
            <BrandLogo />
          </Link>
          <Tip show={collapsed} label="Expandir menu (Ctrl B)">
            <button
              type="button"
              className={`${s.iconBtn} ${s.collapseBtn}`}
              onClick={toggle}
              aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
              aria-expanded={!collapsed}
              title={collapsed ? undefined : "Recolher menu (Ctrl B)"}
            >
              {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.75} /> : <PanelLeftClose size={16} strokeWidth={1.75} />}
            </button>
          </Tip>
        </div>

        <Tip show={collapsed} label={id.storeName}>
          <Link href="/admin/settings" className={s.storeBox} title={collapsed ? undefined : "Dados e foto da loja em Configurações"}>
            <span className={s.storeMark} aria-hidden="true">
              {id.storeName.slice(0, 1).toUpperCase()}
            </span>
            <span className={s.storeText}>
              <b>{id.storeName}</b>
            </span>
          </Link>
        </Tip>

        <Tip show={collapsed} label="PingaIA (em breve)">
          <button type="button" className={s.ai} aria-disabled="true" aria-label="Pergunte à PingaIA (em breve)" title={collapsed ? undefined : "A PingaIA chega na próxima fase"}>
            <Art name="pingaia" size={26} className={s.aiArt} />
            <span className={`${s.navLabel} ${s.aiLabel}`}>
              Pergunte à <b>PingaIA</b>
            </span>
          </button>
        </Tip>

        <nav aria-label="Navegação do painel" className={s.navWrap}>
          <ul className={s.nav} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}>
            {main.map(link)}
            <li className={s.navSep} aria-hidden="true">
              <span className={s.navLabel}>Loja</span>
            </li>
            {store.map(link)}
            <li>
              <Tip show={collapsed} label="Equipe (em breve)">
                <span className={s.navItem} aria-disabled="true" title={collapsed ? undefined : "Convites para a equipe chegam na próxima fase"}>
                  <span className={s.navIcon}>
                    <NavIcon name="users" size={16} />
                  </span>
                  <span className={s.navLabel}>Equipe</span>
                  <span className={`${s.navTag} ${s.navLabel}`}>em breve</span>
                </span>
              </Tip>
            </li>
          </ul>
        </nav>

        <div className={s.userFoot}>
          <div className={s.userActions}>
            <ThemeSwitch
              theme={theme}
              iconOnly
              label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
              onThemeChange={(next, trigger) => changeTheme(next, trigger)}
            />
            <Tip show label="Configurações" side={collapsed ? "right" : "top"}>
              <Link href="/admin/settings" className={s.footBtn} aria-label="Configurações">
                <Settings size={15} strokeWidth={1.75} />
              </Link>
            </Tip>
            <Tip show label="Trocar senha" side={collapsed ? "right" : "top"}>
              <Link href="/admin/senha" className={s.footBtn} aria-label="Trocar senha">
                <KeyRound size={15} strokeWidth={1.75} />
              </Link>
            </Tip>
            <form action={logout}>
              <Tip show label="Sair" side={collapsed ? "right" : "top"}>
                <button type="submit" className={s.footBtn} aria-label="Sair">
                  <LogOut size={15} strokeWidth={1.75} />
                </button>
              </Tip>
            </form>
          </div>
          <Tip show={collapsed} label={`${id.userName} · ${id.userEmail}`}>
            <div className={s.userRow}>
              <span className={s.avatar} aria-hidden="true">
                {initials || "?"}
              </span>
              <span className={s.userText}>
                <b>{id.userName}</b>
                <small>{id.userEmail}</small>
              </span>
            </div>
          </Tip>
        </div>
      </aside>
      <main id="conteudo" className={s.main}>
        <div className={s.mainInner}>{children}</div>
      </main>
    </div>
  );
}

/**
 * Logo da PingaPay: a versão de cada tema (o CSS mostra uma só, conforme data-theme ou o tema do sistema) e o ícone
 * no lugar do logo quando a sidebar está recolhida.
 */
export function BrandLogo() {
  return (
    <>
      <Image className={`${s.brandLogo} ${s.onlyLight}`} src="/brand/pingapay-logo-light-2.webp" alt="" width={132} height={24} priority unoptimized />
      <Image className={`${s.brandLogo} ${s.onlyDark}`} src="/brand/pingapay-logo-dark-2.webp" alt="" width={132} height={24} priority unoptimized />
      <Image className={`${s.brandIcon} ${s.onlyLight}`} src="/brand/pingapay-icon-light-2.webp" alt="" width={28} height={28} unoptimized />
      <Image className={`${s.brandIcon} ${s.onlyDark}`} src="/brand/pingapay-icon-dark-2.webp" alt="" width={28} height={28} unoptimized />
    </>
  );
}
