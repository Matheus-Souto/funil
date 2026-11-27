// Regras do bloco "Testes do app" no Dashboard (sem JSX, testáveis): quando a loja vê o painel e o que cada número
// compara. A página só monta os `Kpi` com o que sai daqui.
import { bpPercent } from "@/lib/format";
import { TRIAL_WINDOW_DAYS, type TrialsSummary } from "@/lib/metrics";

/** Testes sem pagamento são apagados depois da retenção: período mais antigo conta menos testes e infla a conversão. */
export const TRIALS_RETENTION_NOTE = `Só os testes dos últimos ${TRIAL_WINDOW_DAYS} dias (os que não pagaram são apagados depois disso).`;

/**
 * Primeiros passos só em loja sem nada: sem pedido nem visita na vida toda e sem oferta de app ativa. Decide por dado
 * sem período (loja de app com testes antigos não volta para os primeiros passos).
 */
export const overviewIsEmpty = (lifetime: { orders: number; views: number }, hasAppOffer: boolean): boolean =>
  lifetime.orders === 0 && lifetime.views === 0 && !hasAppOffer;

export interface TrialsKpi {
  label: string;
  value: string;
  /** Números da comparação com o período anterior (a página passa por `deltaOf`). Ausente: sem comparação. */
  delta?: { cur: number; prev: number };
  note?: string;
}

/**
 * Testes iniciados comparam com o período anterior (só com as duas janelas dentro da retenção). Pagantes e conversão
 * não: o período anterior teve mais tempo para converter, então a comparação favoreceria sempre o passado.
 */
export function appTrialsKpis(cur: TrialsSummary, prev: TrialsSummary): TrialsKpi[] {
  const retention = cur.retentionCovered ? {} : { note: TRIALS_RETENTION_NOTE };
  const compare = cur.retentionCovered && prev.retentionCovered;
  return [
    { label: "Testes iniciados", value: String(cur.trials), ...(compare ? { delta: { cur: cur.trials, prev: prev.trials } } : {}), ...retention },
    { label: "Pagantes", value: String(cur.paying), note: "Contas dos testes do período que já pagaram, em qualquer data." },
    { label: "Conversão teste → pagante", value: bpPercent(cur.conversionBp), ...retention },
  ];
}
