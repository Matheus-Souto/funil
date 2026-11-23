// Período do Dashboard escolhido no calendário: ?de=AAAA-MM-DD&ate=AAAA-MM-DD (dias de São Paulo, os dois inclusos).
// Links antigos com ?periodo=hoje|7d|30d continuam valendo. Sem parâmetros: o mês atual. Puro (sem banco): só
// converte datas; o servidor usa o resultado nas ações de métricas.

const DAY_MS = 86_400_000;
/** Teto do período: o mesmo da receita por dia (metricsBreakdown.byDay cobre até 400 dias). */
export const MAX_RANGE_DAYS = 366;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SP_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

/** "AAAA-MM-DD" do dia em São Paulo. */
export const spDay = (d: Date) => SP_DAY.format(d);
/** Meia-noite (São Paulo, UTC−3 fixo desde 2019) do dia "AAAA-MM-DD". */
const midnight = (day: string) => new Date(`${day}T00:00:00-03:00`);
const addDays = (day: string, n: number) => spDay(new Date(midnight(day).getTime() + n * DAY_MS + 12 * 3_600_000));
const valid = (v: string | undefined): v is string => !!v && ISO.test(v) && !Number.isNaN(midnight(v).getTime()) && spDay(new Date(midnight(v).getTime() + 12 * 3_600_000)) === v;

export interface DashboardRange {
  /** Primeiro e último dia (inclusos), em São Paulo. */
  de: string;
  ate: string;
  days: number;
  /** Intervalo para as ações: do início do primeiro dia até o fim do último (ou até agora, se termina hoje). */
  from: Date;
  to: Date;
  /** Mesma duração, logo antes ("hoje até agora" compara com "ontem até a mesma hora"). */
  prev: { from: Date; to: Date };
  endsToday: boolean;
  /** "vs. 7 dias anteriores" etc., para os KPIs. */
  compare: string;
  /** Rótulo curto do período: "21/11/26" ou "15/11/26 – 21/11/26". */
  label: string;
  /** O pedido passava de MAX_RANGE_DAYS e o começo foi cortado (a tela avisa). */
  capped: boolean;
}

const short = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(2, 4)}`;

export function parseDashboardRange(sp: { de?: string; ate?: string; periodo?: string }, now: Date = new Date()): DashboardRange {
  const today = spDay(now);
  let de: string;
  let ate: string;
  if (valid(sp.de) && valid(sp.ate)) {
    de = sp.de <= sp.ate ? sp.de : sp.ate;
    ate = sp.de <= sp.ate ? sp.ate : sp.de;
  } else if (sp.periodo === "hoje" || sp.periodo === "7d" || sp.periodo === "30d") {
    // Links antigos (?periodo=): os mesmos dias de antes.
    de = addDays(today, sp.periodo === "hoje" ? 0 : sp.periodo === "30d" ? -29 : -6);
    ate = today;
  } else {
    // Padrão: o mês atual, do dia 1 até hoje.
    de = `${today.slice(0, 8)}01`;
    ate = today;
  }
  if (ate > today) ate = today;
  if (de > ate) de = ate;
  let days = Math.round((midnight(ate).getTime() - midnight(de).getTime()) / DAY_MS) + 1;
  const capped = days > MAX_RANGE_DAYS;
  if (capped) {
    de = addDays(ate, -(MAX_RANGE_DAYS - 1));
    days = MAX_RANGE_DAYS;
  }
  const endsToday = ate === today;
  const from = midnight(de);
  const to = endsToday ? now : midnight(addDays(ate, 1));
  const prev = { from: new Date(from.getTime() - days * DAY_MS), to: new Date(to.getTime() - days * DAY_MS) };
  const compare = days === 1 ? (endsToday ? "ontem no mesmo horário" : "dia anterior") : `${days} dias anteriores`;
  return { de, ate, days, from, to, prev, endsToday, compare, label: days === 1 ? short(de) : `${short(de)} – ${short(ate)}`, capped };
}
