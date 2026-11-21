// Peças de apresentação do painel (sem estado): Status, Cartão KPI, listas com barra, cabeçalho de página.
import type { ReactNode } from "react";
import Link from "next/link";
import { statusLabel, statusTone } from "@/lib/orders/labels";
import { PIcon } from "./icons";
import Image from "next/image";
import { CircleCheck, CircleMinus, CircleX, Clock, Info, RotateCcw, ShieldAlert, TimerOff, type LucideIcon } from "lucide-react";
import { KpiNumber } from "./charts";
import s from "./panel.module.css";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/** Ícone de cada status de pedido (o mesmo do filtro da lista). */
const STATUS_ICON: Record<string, LucideIcon> = {
  paid: CircleCheck,
  pending: Clock,
  expired: TimerOff,
  declined: CircleX,
  refunded: RotateCcw,
  disputed: ShieldAlert,
};
const TONE_ICON: Record<Tone, LucideIcon> = { success: CircleCheck, warning: Clock, danger: CircleX, info: Info, neutral: CircleMinus };

export function StatusBadge({ status, method, label }: { status: string; method: string; label?: string }) {
  const tone = statusTone(status, method);
  const Icon = STATUS_ICON[status] ?? TONE_ICON[tone];
  return (
    <span className={s.badge} data-tone={tone}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {label ?? statusLabel(status, method)}
    </span>
  );
}

export function Badge({ tone, children }: { tone?: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone ?? "neutral"];
  return (
    <span className={s.badge} data-tone={tone}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {children}
    </span>
  );
}

/** Variação percentual inteira vs. período anterior (sem float no dinheiro: só a razão é aproximada para exibir). */
export function deltaOf(cur: number, prev: number): { pct: number | null; tone: "up" | "down" | "flat" } {
  if (prev === 0) return { pct: null, tone: cur > 0 ? "up" : "flat" };
  const pct = Math.round(((cur - prev) * 100) / prev);
  return { pct, tone: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}

/** Ilustrações 3D do painel (public/admin/art/<nome>.webp, 240×240, fundo transparente). */
export type ArtName = "receita" | "pedidos" | "pagos" | "ticket" | "produto" | "aprovacoes" | "agentes" | "funil" | "pdf" | "origem" | "indicacao" | "carteira" | "email" | "avisos" | "pingaia";

/** Ilustração decorativa (estados vazios, login): escondida dos leitores de tela. */
export function Art({ name, size = 112, className }: { name: ArtName; size?: number; className?: string }) {
  return <Image className={className ?? s.emptyArt} src={`/admin/art/${name}.webp`} alt="" width={size} height={size} aria-hidden="true" />;
}

export function Kpi({
  label,
  value,
  amount,
  money,
  delta,
  compare,
  empty,
  art,
  layout = "card",
}: {
  label: string;
  value: string;
  /** Valor numérico para o número animado (centavos se `money`). Sem ele, mostra `value` parado. */
  amount?: number;
  money?: boolean;
  delta?: ReturnType<typeof deltaOf>;
  compare?: string;
  empty?: boolean;
  /** Ilustração 3D do card (public/admin/art/<nome>.webp). */
  art?: ArtName;
  /** "cell": um dos números dentro de `.kpiStrip` (vários KPIs num cartão só, ícone à esquerda). */
  layout?: "card" | "cell";
}) {
  if (layout === "cell") {
    return (
      <div className={s.kpiCell}>
        {art ? <Image className={s.kpiCellArt} src={`/admin/art/${art}.webp`} alt="" width={52} height={52} aria-hidden="true" priority /> : null}
        <div className={s.kpiCellBody}>
          <div className={s.kpiLabel}>{label}</div>
          <div className={s.kpiCellValue}>{amount !== undefined ? <KpiNumber value={amount} money={money} /> : value}</div>
          {delta && compare ? (
            <div className={s.delta} data-tone={delta.tone}>
              {delta.tone !== "flat" ? <PIcon name={delta.tone === "up" ? "trending-up" : "trending-down"} size={14} /> : null}
              {delta.pct === null ? (delta.tone === "up" ? "novo" : "—") : `${delta.pct > 0 ? "+" : delta.pct < 0 ? "−" : ""}${Math.abs(delta.pct)}%`}
              <span className={s.deltaCompare}> vs. {compare}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className={s.kpi} data-empty={empty ? "true" : undefined} data-art={art ? "true" : undefined}>
      {art ? <Image className={s.kpiArt} src={`/admin/art/${art}.webp`} alt="" width={72} height={72} aria-hidden="true" priority /> : null}
      <div className={s.kpiLabel}>{label}</div>
      <div className={s.kpiValue}>{amount !== undefined ? <KpiNumber value={amount} money={money} /> : value}</div>
      {delta && compare ? (
        <div className={s.delta} data-tone={delta.tone}>
          {delta.tone !== "flat" ? <PIcon name={delta.tone === "up" ? "trending-up" : "trending-down"} size={15} /> : null}
          {delta.pct === null ? (delta.tone === "up" ? "novo" : "—") : `${delta.pct > 0 ? "+" : delta.pct < 0 ? "−" : ""}${Math.abs(delta.pct)}%`}
          <span className={s.deltaCompare}> vs. {compare}</span>
        </div>
      ) : null}
    </div>
  );
}

export function BarList({ rows, empty }: { rows: Array<{ label: ReactNode; value: number; text: ReactNode; extra?: ReactNode }>; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className={s.muted}>{empty ?? "Nada no período."}</p>;
  return (
    <ul className={s.barList}>
      {rows.map((r, i) => (
        <li key={i} className={s.barItem}>
          <span>{r.label}</span>
          <span className={s.bar} aria-hidden="true">
            <i style={{ width: `${Math.max(2, Math.round((r.value * 100) / max))}%` }} />
          </span>
          <b>
            {r.text}
            {r.extra !== undefined ? <small>{r.extra}</small> : null}
          </b>
        </li>
      ))}
    </ul>
  );
}

/** Aviso de entregas por e-mail com falha (avisos da loja e lista de pedidos). */
export function FailedDeliveries({ items }: { items: Array<{ orderId: string; code: string }> }) {
  return (
    <Notice tone="danger">
      <b>E-mail falhou</b> em {items.length} {items.length === 1 ? "pedido" : "pedidos"}:{" "}
      {items.slice(0, 5).map((f, i) => (
        <span key={f.orderId}>
          {i > 0 ? ", " : ""}
          <Link href={`/admin/orders/${f.orderId}`}>#{f.code}</Link>
        </span>
      ))}
      . Confira o endereço do comprador e a conexão de e-mail, ou reenvie o acesso.
    </Notice>
  );
}

/**
 * Aviso discreto (ponto colorido, texto e ação no fim). Vários lado a lado dentro de `.noticeStrip`. O texto quebra
 * linha quando precisa: nada fica só no `title`, que não abre no toque nem no leitor de tela.
 */
export function Notice({
  tone,
  action,
  alert,
  children,
}: {
  tone: "warning" | "danger" | "info";
  action?: ReactNode;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={s.notice} data-tone={tone} role={alert ? "alert" : undefined}>
      <span className={s.noticeDot} aria-hidden="true" />
      <span className={s.noticeText}>{children}</span>
      {action ? <span className={s.noticeAction}>{action}</span> : null}
    </div>
  );
}

export function PageHead({ title, sub, actions, back, badge }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; badge?: ReactNode }) {
  return (
    <>
      {back ? (
        <Link className={s.back} href={back.href}>
          <PIcon name="arrow-left" size={16} />
          {back.label}
        </Link>
      ) : null}
      <div className={s.pageHead}>
        <div>
          <div className={s.titleRow}>
            <h1>{title}</h1>
            {badge}
          </div>
          {sub ? <p>{sub}</p> : null}
        </div>
        {actions ? <div className={s.headActions}>{actions}</div> : null}
      </div>
    </>
  );
}
