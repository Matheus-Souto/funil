"use client";

// Gráficos do painel com ECharts (só os módulos usados, carregados no navegador) e números animados do Arc.
// As cores vêm das variáveis do tema (theme.css) e os gráficos se redesenham quando o tema muda.
import { useEffect, useRef, useState } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { AnimatedCounter } from "@/components/arc/animated-counter/animated-counter";
import { brl } from "@/lib/format";
import s from "./panel.module.css";

type ECharts = typeof import("echarts/core");
let loader: Promise<ECharts> | null = null;
function loadECharts(): Promise<ECharts> {
  loader ??= (async () => {
    const core = await import("echarts/core");
    const [{ BarChart, LineChart, PieChart, FunnelChart }, { GraphicComponent, GridComponent, TooltipComponent }, { SVGRenderer }] =
      await Promise.all([import("echarts/charts"), import("echarts/components"), import("echarts/renderers")]);
    core.use([BarChart, LineChart, PieChart, FunnelChart, GraphicComponent, GridComponent, TooltipComponent, SVGRenderer]);
    return core;
  })();
  return loader;
}

export interface ChartTheme {
  text: string;
  muted: string;
  border: string;
  grid: string;
  surface: string;
  accent: string;
  accentInk: string;
  onAccent: string;
  series: string[];
  font: string;
  mono: string;
}

function readTheme(el: Element): ChartTheme {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    text: v("--foreground"),
    muted: v("--text-secondary"),
    border: v("--border"),
    grid: v("--chart-grid"),
    surface: v("--surface-raised"),
    accent: v("--accent"),
    accentInk: v("--accent-strong"),
    onAccent: v("--accent-foreground"),
    series: [v("--series-1"), v("--series-2"), v("--series-3"), v("--series-4"), v("--series-5")],
    font: css.fontFamily,
    mono: v("--font-mono") || "ui-monospace, monospace",
  };
}

/** Avisa quando o tema muda: atributo data-theme do <html> (botão) ou preferência do sistema. */
function useThemeVersion(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((x) => x + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", bump);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", bump);
    };
  }, []);
  return n;
}

/** Base: monta o ECharts, aplica a opção montada com as cores do tema e acompanha o tamanho do card. */
export function EChart({ option, height, label }: { option: (t: ChartTheme) => EChartsCoreOption; height: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [chart, setChart] = useState<ReturnType<ECharts["init"]> | null>(null);
  const version = useThemeVersion();

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    let instance: ReturnType<ECharts["init"]> | null = null;
    void loadECharts().then((echarts) => {
      if (disposed || !ref.current) return;
      instance = echarts.init(ref.current, undefined, { renderer: "svg" });
      ro = new ResizeObserver(() => instance?.resize());
      ro.observe(ref.current);
      setChart(instance);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      instance?.dispose();
    };
  }, []);

  useEffect(() => {
    if (chart && ref.current) chart.setOption(option(readTheme(ref.current)), { notMerge: true });
  }, [chart, version, option]);

  return <div ref={ref} className={s.echart} style={{ height }} role="img" aria-label={label} />;
}

/** Eixo e centro da rosca: R$ inteiros ou "R$ 1,2 mil" (só exibição; os valores seguem em centavos). */
const brlShort = (cents: number) => {
  const reais = Math.trunc(cents / 100);
  if (reais < 1000) return `R$ ${reais}`;
  const tenths = Math.round(reais / 100); // milhares com uma casa, em inteiros
  return `R$ ${Math.trunc(tenths / 10).toLocaleString("pt-BR")}${tenths % 10 ? `,${tenths % 10}` : ""} mil`;
};

function tooltip(t: ChartTheme) {
  return {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: t.text, fontFamily: t.font, fontSize: 13 },
    extraCssText: "border-radius:12px;box-shadow:var(--shadow-floating);",
  };
}

/** Receita por dia: barras arredondadas (finas em 30 dias, quando os valores diários variam muito), hoje em destaque. */
export function RevenueChart({ days }: { days: Array<{ label: string; full: string; cents: number }> }) {
  const many = days.length > 10;
  return (
    <EChart
      height={220}
      label={`Receita por dia: ${days.map((d) => `${d.full} ${brl(d.cents)}`).join("; ")}`}
      option={(t) => ({
        animationDuration: 700,
        animationEasing: "cubicOut",
        grid: { left: 4, right: 4, top: 16, bottom: 4, containLabel: true },
        tooltip: {
          ...tooltip(t),
          trigger: "axis",
          axisPointer: { type: "none" },
          formatter: (p: Array<{ dataIndex: number }>) => {
            const d = days[p[0]?.dataIndex ?? 0];
            return d ? `<div style="font-size:12px;color:${t.muted}">${d.full}</div><b style="font-size:14px">${brl(d.cents)}</b>` : "";
          },
        },
        xAxis: {
          type: "category",
          data: days.map((d) => d.label),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.muted, fontFamily: t.font, fontSize: 12, interval: many ? 4 : 0 },
        },
        yAxis: {
          type: "value",
          splitNumber: 3,
          axisLabel: { color: t.muted, fontFamily: t.font, fontSize: 12, formatter: (v: number) => (v === 0 ? "0" : brlShort(v)) },
          splitLine: { lineStyle: { color: t.grid } },
        },
        series: [
          {
            type: "bar",
            barMaxWidth: many ? 12 : 36,
            data: days.map((d, i) => ({
              value: d.cents,
              itemStyle: { color: i === days.length - 1 ? t.accent : `${t.accent}80`, borderRadius: many ? [4, 4, 2, 2] : [8, 8, 3, 3] },
            })),
            emphasis: { itemStyle: { color: t.accentInk } },
          },
        ],
      })}
    />
  );
}

/** Funil do checkout: visitas → pedidos → pagos, com a taxa de cada passo. */
export function FunnelChart({ views, orders, paid }: { views: number; orders: number; paid: number }) {
  const pct = (a: number, b: number) => (b === 0 ? "—" : `${(Math.round((a * 1000) / b) / 10).toLocaleString("pt-BR")}%`);
  const steps = [
    { name: "Visitas ao checkout", value: views, rate: "" },
    { name: "Pedidos criados", value: orders, rate: pct(orders, views) },
    { name: "Pagos", value: paid, rate: pct(paid, orders) },
  ];
  return (
    <EChart
      height={200}
      label={`Funil do checkout: ${views} visitas, ${orders} pedidos (${pct(orders, views)}), ${paid} pagos (${pct(paid, orders)})`}
      option={(t) => ({
        animationDuration: 700,
        tooltip: {
          ...tooltip(t),
          trigger: "item",
          formatter: (p: { dataIndex: number }) => {
            const st = steps[p.dataIndex];
            return st ? `${st.name}<br/><b>${st.value.toLocaleString("pt-BR")}</b>${st.rate ? ` · ${st.rate}` : ""}` : "";
          },
        },
        series: [
          {
            type: "funnel",
            left: 0,
            top: 6,
            bottom: 6,
            width: "56%",
            min: 0,
            max: 100,
            minSize: "30%",
            gap: 4,
            sort: "none",
            funnelAlign: "center",
            label: {
              show: true,
              position: "right",
              fontFamily: t.font,
              formatter: (p: { dataIndex: number }) => {
                const st = steps[p.dataIndex];
                return st ? `{n|${st.value.toLocaleString("pt-BR")}}  {l|${st.name}}${st.rate ? `\n{r|${st.rate} da etapa anterior}` : ""}` : "";
              },
              rich: {
                n: { fontSize: 18, fontWeight: 600, color: t.text, fontFamily: t.font },
                l: { fontSize: 13, color: t.text, fontFamily: t.font },
                r: { fontSize: 12, color: t.muted, fontFamily: t.font, padding: [4, 0, 0, 0] },
              },
            },
            labelLine: { show: true, length: 14, lineStyle: { color: t.border } },
            itemStyle: { borderWidth: 0 },
            emphasis: { label: { show: true } },
            // Tamanho de cada camada fixo (100, 72, 46): o desenho é só o formato do funil; os números reais vão no rótulo.
            data: steps.map((st, i) => ({
              name: st.name,
              value: [100, 72, 46][i],
              itemStyle: { color: i === 2 ? t.accent : i === 1 ? `${t.accent}99` : `${t.accent}4d` },
            })),
          },
        ],
      })}
    />
  );
}

/** Receita por método de pagamento: rosca com o total no meio. */
export function DonutChart({ rows }: { rows: Array<{ label: string; cents: number; paid: number }> }) {
  const total = rows.reduce((a, r) => a + r.cents, 0);
  const data = rows.filter((r) => r.cents > 0);
  return (
    <EChart
      height={200}
      label={`Receita por método: ${rows.map((r) => `${r.label} ${brl(r.cents)}`).join("; ")}`}
      option={(t) => ({
        animationDuration: 700,
        tooltip: {
          ...tooltip(t),
          trigger: "item",
          formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/><b>${brl(p.value)}</b> · ${Math.round(p.percent)}%`,
        },
        graphic: [
          { type: "text", left: "center", top: "40%", style: { text: brl(total), fill: t.text, font: `600 16px ${t.font}`, align: "center" } },
          { type: "text", left: "center", top: "54%", style: { text: "no período", fill: t.muted, font: `400 12px ${t.font}`, align: "center" } },
        ],
        series: [
          {
            type: "pie",
            radius: ["62%", "86%"],
            padAngle: data.length > 1 ? 3 : 0,
            itemStyle: { borderRadius: 8 },
            label: { show: false },
            data: data.length
              ? data.map((r, i) => ({ name: r.label, value: r.cents, itemStyle: { color: t.series[i % t.series.length] } }))
              : [{ name: "Sem vendas", value: 1, itemStyle: { color: t.grid } }],
            emphasis: { scale: true, scaleSize: 4 },
          },
        ],
      })}
    />
  );
}

/** Ranking em barras horizontais (origem, indicação). */
export function RankChart({ rows, mono }: { rows: Array<{ label: string; cents: number; paid: number }>; mono?: boolean }) {
  const ordered = [...rows].reverse();
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <EChart
      height={Math.max(96, rows.length * 44 + 8)}
      label={rows.map((r) => `${r.label} ${brl(r.cents)} (${r.paid} pagos)`).join("; ")}
      option={(t) => ({
        animationDuration: 700,
        grid: { left: 0, right: 0, top: 4, bottom: 4, containLabel: true },
        tooltip: {
          ...tooltip(t),
          trigger: "item",
          formatter: (p: { dataIndex: number }) => {
            const r = ordered[p.dataIndex];
            return r ? `${r.label}<br/><b>${brl(r.cents)}</b> · ${r.paid} ${r.paid === 1 ? "pago" : "pagos"}` : "";
          },
        },
        xAxis: { type: "value", show: false, max },
        yAxis: {
          type: "category",
          data: ordered.map((r) => r.label),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: t.text, fontSize: 13, margin: 12, fontFamily: mono ? t.mono : t.font },
        },
        series: [
          // trilho (fundo) com o valor no fim
          {
            type: "bar",
            barWidth: 10,
            silent: true,
            z: 1,
            data: ordered.map(() => max),
            itemStyle: { color: t.grid, borderRadius: 5 },
            label: {
              show: true,
              position: "insideRight",
              offset: [0, -16],
              color: t.text,
              fontFamily: t.font,
              fontSize: 12,
              fontWeight: 600,
              formatter: (p: { dataIndex: number }) => {
                const r = ordered[p.dataIndex];
                return r ? `${brl(r.cents)} {n|· ${r.paid}}` : "";
              },
              rich: { n: { color: t.muted, fontSize: 12, fontWeight: 400, fontFamily: t.font } },
            },
          },
          // barra
          {
            type: "bar",
            barWidth: 10,
            barGap: "-100%",
            z: 2,
            data: ordered.map((r, i) => ({
              value: r.cents,
              itemStyle: { color: i === ordered.length - 1 ? t.accent : `${t.accent}b3`, borderRadius: 5 },
            })),
            emphasis: { itemStyle: { color: t.accentInk } },
          },
        ],
      })}
    />
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
