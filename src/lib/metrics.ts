// Métricas da visão geral do painel. Dinheiro em centavos inteiros (somas em bigint no banco, convertidas uma vez).
// Receita = soma de `total_cents` dos pedidos `paid` com `paid_at` no período: reembolsados e contestados ficam fora.
// Recuperação por e-mail (`recovery`): só números, contando os lembretes `sent` com `sent_at` no período. Recuperado =
// existe pedido pago, contestado ou reembolsado da mesma oferta, de cliente com o mesmo sha256 do e-mail, com `paid_at`
// entre `sent_at` e `sent_at + 7 dias`. Receita recuperada = soma de `total_cents` desses pedidos, cada pedido uma vez.
import { and, count, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { checkoutLead, checkoutView, orders } from "@/lib/db/schema";
import { LEAD_TTL_DAYS } from "@/lib/leads/capture";
import { WAS_PAID } from "@/lib/recovery/checks";
import { RECOVERY } from "@/lib/recovery/rules";

export type Method = "pix_manual" | "pix_asaas" | "card_asaas";
export const METHODS: readonly Method[] = ["pix_manual", "pix_asaas", "card_asaas"];
export type Period = "hoje" | "7d" | "30d";
export const PERIOD_DAYS: Record<Period, number> = { hoje: 1, "7d": 7, "30d": 30 };

const DAY_MS = 86_400_000;
const SP_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
/** Brasil sem horário de verão desde 2019: meia-noite de São Paulo = 03:00 UTC. */
const spMidnight = (d: Date) => new Date(`${SP_KEY.format(d)}T00:00:00-03:00`);
export const spDayKey = (d: Date): string => SP_KEY.format(d);

/**
 * Período do painel: "hoje" = desde a meia-noite de São Paulo; "7d"/"30d" = os últimos N dias contando hoje.
 * `previous`: o mesmo intervalo decorrido deslocado N dias para trás (comparação "vs. período anterior" justa).
 */
export function periodRange(p: Period, now: Date = new Date(), opts: { previous?: boolean } = {}): { from: Date; to: Date } {
  const days = PERIOD_DAYS[p];
  const from = new Date(spMidnight(now).getTime() - (days - 1) * DAY_MS);
  // Mesmo intervalo decorrido, N dias antes: "hoje até 09:00" compara com "ontem até 09:00" (não com o dia inteiro).
  if (opts.previous) return { from: new Date(from.getTime() - days * DAY_MS), to: new Date(now.getTime() - days * DAY_MS) };
  return { from, to: now };
}

/**
 * Os contatos (`leads`, `leadsConverted`) somem com 30 dias: uma janela que começa antes disso conta menos do que houve.
 * `false` = não compare esses números (ex.: os 30 dias anteriores).
 */
export function leadWindowCovered(from: Date, now: Date = new Date()): boolean {
  return from.getTime() >= now.getTime() - LEAD_TTL_DAYS * DAY_MS;
}

const range = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((r) => r.from.getTime() <= r.to.getTime(), { message: "O início do período deve ser antes do fim", path: ["to"] });

/** Teto do período para tokens MCP (o pool do banco é pequeno); o painel não tem teto (a visão geral lê desde 1970). */
const TOKEN_MAX_DAYS = 400;
function capForToken(ctx: Ctx, from: Date, to: Date): void {
  if (ctx.actor.kind === "token" && to.getTime() - from.getTime() > TOKEN_MAX_DAYS * DAY_MS) {
    throw new ActionError("invalid_input", `Período de no máximo ${TOKEN_MAX_DAYS} dias`);
  }
}

const money = (col: unknown) => sql<number>`coalesce(sum(${col}), 0)::bigint`.mapWith(Number);
const n = () => count().mapWith(Number);

type MethodRow = { orders: number; paid: number; revenueCents: number };
export type RecoveryCase = "lead" | "pix" | "card";
export const RECOVERY_CASES: readonly RecoveryCase[] = ["lead", "pix", "card"];
export interface RecoverySummary {
  sent: number;
  recovered: number;
  recoveredRevenueCents: number;
  byCase: Record<RecoveryCase, { sent: number; recovered: number }>;
}

/**
 * O pedido `o` (cliente `c`) recupera o lembrete `r`: mesma loja e oferta, pago, contestado ou reembolsado, pago entre o
 * envio e 7 dias depois, e cliente com o mesmo sha256 do e-mail (`customer.email` já é gravado minúsculo e sem espaços).
 * SQL escrito à mão com aliases: as três tabelas têm `store_id`/`status` e o drizzle não qualifica colunas de uma
 * consulta de tabela única. Só constantes do código entram com `sql.raw`.
 */
const RECOVERS = sql.raw(`o.store_id = r.store_id
  and o.offer_id = r.offer_id
  and o.status in (${WAS_PAID.map((x) => `'${x}'`).join(", ")})
  and o.paid_at >= r.sent_at
  and o.paid_at <= r.sent_at + interval '${RECOVERY.attributionDays} days'
  and encode(sha256(convert_to(c.email, 'UTF8')), 'hex') = r.email_hash`);

async function recoverySummary(ctx: Ctx, from: Date, to: Date): Promise<RecoverySummary> {
  const sentIn = sql`r.status = 'sent' and r.sent_at >= ${from.toISOString()}::timestamptz and r.sent_at < ${to.toISOString()}::timestamptz`;
  const rows = (await ctx.tx.execute(sql`
    select r.kind,
      count(*)::int as sent,
      (count(*) filter (where exists (select 1 from orders o join customer c on c.id = o.customer_id where ${RECOVERS})))::int as recovered
    from recovery_email r
    where ${sentIn}
    group by r.kind`)) as unknown as Array<{ kind: string; sent: number; recovered: number }>;
  // Cada pedido uma vez, mesmo com vários lembretes que ele recupera.
  const [rev] = (await ctx.tx.execute(sql`
    select coalesce(sum(o.total_cents), 0)::bigint as cents
    from orders o join customer c on c.id = o.customer_id
    where exists (select 1 from recovery_email r where ${sentIn} and ${RECOVERS})`)) as unknown as Array<{ cents: string | number }>;

  const byCase = Object.fromEntries(RECOVERY_CASES.map((k) => [k, { sent: 0, recovered: 0 }])) as RecoverySummary["byCase"];
  for (const r of rows) if (Object.hasOwn(byCase, r.kind)) byCase[r.kind as RecoveryCase] = { sent: Number(r.sent), recovered: Number(r.recovered) };
  return {
    sent: RECOVERY_CASES.reduce((a, k) => a + byCase[k].sent, 0),
    recovered: RECOVERY_CASES.reduce((a, k) => a + byCase[k].recovered, 0),
    recoveredRevenueCents: Number(rev?.cents ?? 0),
    byCase,
  };
}

export const metricsSummary = defineAction({
  name: "metrics.summary",
  description: "Números do período: visitas ao checkout, pedidos, pagos, receita (centavos), por método, por origem (utm_source) e por indicação (ref), contatos capturados (leads) e quantos viraram pedido (leadsConverted). leads e leadsConverted cobrem só os últimos 30 dias (retenção dos contatos): fora disso contam menos do que houve. recovery: lembretes de recuperação por e-mail enviados no período (sent), quantos viraram venda da mesma oferta e do mesmo e-mail em até 7 dias (recovered), a receita desses pedidos (recoveredRevenueCents) e os mesmos números por caso (lead, pix, card); cobre só os últimos 90 dias (retenção dos lembretes).",
  input: range,
  permission: "metrics.read",
  audit: false,
  async run(ctx, { from, to }) {
    capForToken(ctx, from, to);
    const created = and(gte(orders.createdAt, from), lt(orders.createdAt, to));
    const paidIn = and(eq(orders.status, "paid"), gte(orders.paidAt, from), lt(orders.paidAt, to));

    const [v] = await ctx.tx
      .select({ n: n() })
      .from(checkoutView)
      .where(and(gte(checkoutView.at, from), lt(checkoutView.at, to)));
    // Contatos de quem não finalizou a compra: só números (nenhum dado do contato sai daqui).
    const [l] = await ctx.tx
      .select({ n: n(), converted: sql<number>`count(*) filter (where ${checkoutLead.status} = 'converted')`.mapWith(Number) })
      .from(checkoutLead)
      .where(and(gte(checkoutLead.createdAt, from), lt(checkoutLead.createdAt, to)));
    const createdBy = await ctx.tx.select({ method: orders.method, n: n() }).from(orders).where(created).groupBy(orders.method);
    const paidBy = await ctx.tx
      .select({ method: orders.method, n: n(), cents: money(orders.totalCents) })
      .from(orders)
      .where(paidIn)
      .groupBy(orders.method);

    const byMethod = Object.fromEntries(METHODS.map((m) => [m, { orders: 0, paid: 0, revenueCents: 0 }])) as Record<Method, MethodRow>;
    for (const r of createdBy) if (r.method in byMethod) byMethod[r.method as Method].orders = r.n;
    for (const r of paidBy) {
      if (!(r.method in byMethod)) continue;
      byMethod[r.method as Method].paid = r.n;
      byMethod[r.method as Method].revenueCents = r.cents;
    }

    const source = sql<string>`coalesce(nullif(${orders.lastTouch}->>'utm_source', ''), 'direto')`;
    const sources = await ctx.tx.select({ source, paid: n(), revenueCents: money(orders.totalCents) }).from(orders).where(paidIn).groupBy(source);
    const refs = await ctx.tx
      .select({ ref: orders.ref, paid: n(), revenueCents: money(orders.totalCents) })
      .from(orders)
      .where(and(paidIn, isNotNull(orders.ref)))
      .groupBy(orders.ref);

    const byRevenue = <T extends { revenueCents: number; paid: number }>(key: (x: T) => string) => (a: T, b: T) =>
      b.revenueCents - a.revenueCents || b.paid - a.paid || key(a).localeCompare(key(b));
    return {
      views: v?.n ?? 0,
      orders: createdBy.reduce((s, r) => s + r.n, 0),
      paid: paidBy.reduce((s, r) => s + r.n, 0),
      revenueCents: paidBy.reduce((s, r) => s + r.cents, 0),
      leads: l?.n ?? 0,
      leadsConverted: l?.converted ?? 0,
      byMethod,
      bySource: sources.sort(byRevenue((x) => x.source)).slice(0, 50),
      byRef: refs
        .map((r) => ({ ref: r.ref!, paid: r.paid, revenueCents: r.revenueCents }))
        .sort(byRevenue((x) => x.ref))
        .slice(0, 50),
      recovery: await recoverySummary(ctx, from, to),
    };
  },
});

/** Até quantos dias o gráfico de receita por dia cobre (períodos maiores devolvem `byDay` vazio). */
const MAX_DAYS = 400;

export const metricsBreakdown = defineAction({
  name: "metrics.breakdown",
  description:
    "Detalhes do período para o painel: receita por dia (São Paulo), pagos com bump, números por oferta e vendas pagas de cada oferta por dia.",
  input: range,
  permission: "metrics.read",
  audit: false,
  async run(ctx, { from, to }) {
    capForToken(ctx, from, to);
    const paidIn = and(eq(orders.status, "paid"), gte(orders.paidAt, from), lt(orders.paidAt, to));
    const day = sql<string>`to_char(${orders.paidAt} at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')`;
    const daily = await ctx.tx.select({ day, cents: money(orders.totalCents) }).from(orders).where(paidIn).groupBy(day);
    const perDay = new Map(daily.map((d) => [d.day, d.cents]));
    const byDay: Array<{ day: string; revenueCents: number }> = [];
    const last = spDayKey(new Date(Math.max(from.getTime(), to.getTime() - 1)));
    for (let t = spMidnight(from).getTime(), i = 0; i < MAX_DAYS; t += DAY_MS, i++) {
      const key = spDayKey(new Date(t + 12 * 3_600_000));
      byDay.push({ day: key, revenueCents: perDay.get(key) ?? 0 });
      if (key >= last) break;
    }

    const bump = sql<number>`count(*) filter (where ${orders.hasBump})`.mapWith(Number);
    const [b] = await ctx.tx.select({ n: bump }).from(orders).where(paidIn);

    const views = await ctx.tx
      .select({ offerId: checkoutView.offerId, n: n() })
      .from(checkoutView)
      .where(and(gte(checkoutView.at, from), lt(checkoutView.at, to)))
      .groupBy(checkoutView.offerId);
    const created = await ctx.tx
      .select({ offerId: orders.offerId, n: n() })
      .from(orders)
      .where(and(gte(orders.createdAt, from), lt(orders.createdAt, to)))
      .groupBy(orders.offerId);
    const paid = await ctx.tx
      .select({ offerId: orders.offerId, n: n(), bump, cents: money(orders.totalCents) })
      .from(orders)
      .where(paidIn)
      .groupBy(orders.offerId);
    const offers = new Map<string, { offerId: string; views: number; orders: number; paid: number; bumpPaid: number; revenueCents: number }>();
    const at = (id: string) => {
      let o = offers.get(id);
      if (!o) offers.set(id, (o = { offerId: id, views: 0, orders: 0, paid: 0, bumpPaid: 0, revenueCents: 0 }));
      return o;
    };
    for (const r of views) at(r.offerId).views = r.n;
    for (const r of created) at(r.offerId).orders = r.n;
    for (const r of paid) Object.assign(at(r.offerId), { paid: r.n, bumpPaid: r.bump, revenueCents: r.cents });

    // Vendas pagas de cada oferta por dia (São Paulo): o mini gráfico da lista de ofertas. Só com o período no limite do
    // `byDay` (períodos longos devolvem vazio, como ele); dias sem venda não vêm.
    const long = byDay.length > MAX_DAYS - 1;
    const byOfferDay = long
      ? []
      : await ctx.tx
          .select({ offerId: orders.offerId, day, paid: n(), revenueCents: money(orders.totalCents) })
          .from(orders)
          .where(paidIn)
          .groupBy(orders.offerId, day);

    return { byDay: long ? [] : byDay, bumpPaid: b?.n ?? 0, byOffer: [...offers.values()], byOfferDay };
  },
});
