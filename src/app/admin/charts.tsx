"use client";

// Gráficos do painel com os componentes do Arc (https://uiarc.dev, parte grátis): barras por dia, rosca por método e
// sparkline. O funil e os rankings são SVG/HTML próprios no mesmo estilo (o Arc não tem funil). Tudo React: nenhum HTML
// montado em string, então nomes vindos de fora (utm_source, ?ref=, ofertas) entram sempre escapados pelo React.
// Valores de dinheiro seguem em centavos inteiros; só a exibição formata.
import { AnimatedCounter } from "@/components/arc/animated-counter/animated-counter";
import { BarChart } from "@/components/arc/bar-chart/bar-chart";
import { DonutChart as ArcDonut } from "@/components/arc/donut-chart/donut-chart";
import { Sparkline as ArcSparkline } from "@/components/arc/sparkline/sparkline";
import { brl } from "@/lib/format";
import { brandOf } from "./brand-icons";
import s from "./panel.module.css";

/** Eixo e marcadores: R$ sem centavos ("R$ 120", "R$ 1,2 mil"); a exibição só arredonda, os valores seguem em centavos. */
const brlAxis = (cents: number) => {
  const reais = Math.round(cents / 100);
  if (reais < 1000) return `R$ ${reais}`;
  const tenths = Math.round(reais / 100);
  return `R$ ${Math.trunc(tenths / 10)}${tenths % 10 ? `,${tenths % 10}` : ""} mil`;
};
/** Total no centro da rosca: com centavos até R$ 999,99; acima disso, sem centavos (cabe no círculo). */
const brlCenter = (cents: number) => (cents < 100_000 ? brl(cents) : `R$ ${Math.round(cents / 100).toLocaleString("pt-BR")}`);

const pct = (a: number, b: number) => (b === 0 ? "—" : `${(Math.round((a * 1000) / b) / 10).toLocaleString("pt-BR")}%`);

/** Receita por dia (barras do Arc): média do período no topo e o valor do dia ao passar o mouse ou o teclado. */
export function RevenueChart({ days, period }: { days: Array<{ key: string; label: string; axisLabel: string; cents: number }>; period: string }) {
  return (
    <BarChart
      data={days.map((d) => ({ key: d.key, label: d.label, axisLabel: d.axisLabel, value: d.cents }))}
      label="Receita por dia"
      period={period}
      averageLabel="Média por dia"
      valueLabel="Receita do dia"
      categoryLabel="Dia"
      height={190}
      formatValue={brl}
      formatTick={brlAxis}
    />
  );
}

/** Funil do checkout em formato fixo (visitas → pedidos → pagos), com os números e a taxa de cada passo ao lado. */
export function FunnelChart({ views, orders, paid }: { views: number; orders: number; paid: number }) {
  const steps = [
    { name: "Visitas ao checkout", value: views, rate: "" },
    { name: "Pedidos criados", value: orders, rate: pct(orders, views) },
    { name: "Pagos", value: paid, rate: pct(paid, orders) },
  ];
  // Três faixas que se estreitam (formato fixo: o funil não muda de forma com os números, só os rótulos).
  const shapes = ["M0 0 H100 L88 30 H12 Z", "M14 34 H86 L76 64 H24 Z", "M26 68 H74 L64 98 H36 Z"];
  return (
    <div className={s.funnel} role="img" aria-label={`Funil do checkout: ${views} visitas, ${orders} pedidos (${pct(orders, views)}), ${paid} pagos (${pct(paid, orders)})`}>
      <svg viewBox="0 0 100 98" preserveAspectRatio="none" aria-hidden="true" className={s.funnelShape}>
        {shapes.map((d, i) => (
          <path key={d} d={d} data-step={i} />
        ))}
      </svg>
      <ol className={s.funnelSteps} aria-hidden="true">
        {steps.map((st) => (
          <li key={st.name}>
            <b>{st.value.toLocaleString("pt-BR")}</b> {st.name}
            {st.rate ? <small>{st.rate} da etapa anterior</small> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Rosca da receita por método (Arc). A legenda com ícones fica na página; as cores seguem a mesma ordem (--series-*). */
export function DonutChart({ rows }: { rows: Array<{ key: string; label: string; cents: number }> }) {
  const data = rows.filter((r) => r.cents > 0).map((r) => ({ key: r.key, label: r.label, value: r.cents }));
  return <ArcDonut data={data} label="Receita por método" totalLabel="no período" formatValue={brlCenter} size={200} thickness={22} legend={false} emptyLabel="Sem vendas no período" />;
}

/** Iniciais para o avatar da indicação (ex.: "ana-paula" → "AP"). */
const initials = (name: string) =>
  name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

/** Ranking em barras horizontais: origem (com o logo da plataforma) ou indicação (com avatar). */
export function RankChart({ rows, kind }: { rows: Array<{ label: string; cents: number; paid: number }>; kind: "source" | "ref" }) {
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <ul className={s.rank}>
      {rows.map((r) => {
        const brand = kind === "source" ? brandOf(r.label) : undefined;
        const name = brand?.title ?? (r.label === "direto" && kind === "source" ? "Direto" : r.label);
        // Logos pretos (TikTok, X, Threads) seguem a cor do texto para aparecer no tema escuro.
        const fill = brand ? (brand.hex.toLowerCase() === "#000000" ? "currentColor" : brand.hex) : undefined;
        return (
          <li key={r.label}>
            <span className={s.rankName}>
              {brand ? (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d={brand.path} fill={fill} />
                </svg>
              ) : (
                <span className={s.rankAvatar} aria-hidden="true">
                  {initials(name)}
                </span>
              )}
              <span className={s.rankLabel}>{name}</span>
            </span>
            <span className={s.rankBar} aria-hidden="true">
              <i style={{ width: `${Math.max(2, Math.round((r.cents * 100) / max))}%` }} />
            </span>
            <span className={s.rankValue}>
              {brl(r.cents)} <small>· {r.paid}</small>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Valor do KPI rolando como odômetro (centavos em R$ ou contagem). O texto completo fica para leitores de tela. */
export function KpiNumber({ value, money }: { value: number; money?: boolean }) {
  if (!money) return <AnimatedCounter value={value} locale="pt-BR" animateOnView />;
  // Reais rolam; "R$" e os centavos ficam discretos ao lado (sem dividir dinheiro em ponto flutuante).
  const reais = Math.trunc(value / 100);
  const cents = String(Math.abs(value % 100)).padStart(2, "0");
  return (
    <span className={s.money}>
      <span className={s.moneyCur} aria-hidden="true">
        R$
      </span>
      <span aria-hidden="true">
        <AnimatedCounter value={reais} locale="pt-BR" animateOnView />
      </span>
      <span className={s.moneyCents} aria-hidden="true">
        ,{cents}
      </span>
      <span className={s.srOnly}>{brl(value)}</span>
    </span>
  );
}

/** Mini gráfico das vendas dos últimos dias (Sparkline do Arc): passar o mouse mostra o dia e o número de vendas. */
export function Sparkline({ values, days, label }: { values: number[]; days: string[]; label: string }) {
  return (
    <ArcSparkline
      data={values}
      labels={days}
      label={label}
      width={120}
      height={34}
      formatValue={(n) => `${n} ${n === 1 ? "venda" : "vendas"}`}
    />
  );
}
