// Peças de apresentação do painel (sem estado): Status, Cartão KPI, listas com barra, cabeçalho de página.
import type { ReactNode } from "react";
import Link from "next/link";
import { statusLabel, statusTone } from "@/lib/orders/labels";
import { PIcon } from "./icons";
import Image from "next/image";
import { KpiNumber } from "./charts";
import s from "./panel.module.css";

export function StatusBadge({ status, method, label }: { status: string; method: string; label?: string }) {
  return (
    <span className={s.badge} data-tone={statusTone(status, method)}>
      {label ?? statusLabel(status, method)}
    </span>
  );
}

export function Badge({ tone, children }: { tone?: "success" | "warning" | "danger" | "info" | "neutral"; children: ReactNode }) {
  return (
    <span className={s.badge} data-tone={tone}>
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
export type ArtName = "receita" | "pedidos" | "pagos" | "ticket" | "produto" | "aprovacoes" | "agentes" | "funil";

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
}) {
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
    <div className={s.banner} data-tone="danger">
      <PIcon name="mail" />
      <div>
        <b>
          A entrega por e-mail falhou ou voltou em {items.length} {items.length === 1 ? "pedido" : "pedidos"}.
        </b>
        <p>
          Confira o endereço do comprador e a conexão de e-mail em Conexões, ou reenvie o acesso.{" "}
          {items.slice(0, 5).map((f, i) => (
            <span key={f.orderId}>
              {i > 0 ? ", " : ""}
              <Link href={`/admin/orders/${f.orderId}`}>#{f.code}</Link>
            </span>
          ))}
        </p>
      </div>
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
