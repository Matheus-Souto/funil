import Link from "next/link";
import { redirect } from "next/navigation";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { listAlerts, listDeliveryFailures } from "@/lib/alerts";
import { requirePanelActor, getPanelIdentity } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { listProducts } from "@/lib/catalog/products";
import { connectionsStatus } from "@/lib/connections";
import { cardServiceConfigured, env } from "@/lib/env";
import { brl } from "@/lib/format";
import { leadWindowCovered, metricsBreakdown, metricsSummary, periodRange, PERIOD_DAYS, type Period } from "@/lib/metrics";
import { METHOD_LABEL, type OrderMethod } from "@/lib/orders/labels";
import { orderCounts } from "@/lib/orders/panel";
import { CARD_SETUP_NOTICE, cardSetupNoticeNeeded } from "@/lib/payments/card-messages";
import { firstParam } from "@/lib/panel-params";
import { getStoreSettings } from "@/lib/store-settings";
import { BarList, Kpi, PageHead, deltaOf } from "../blocks";
import { PIcon } from "../icons";
import s from "../panel.module.css";
import { AckButton, CopyField } from "../ui";
import { FailedDeliveries } from "../blocks";
import { ackAlertAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Visão geral" };

const PERIODS: Array<[Period, string]> = [
  ["hoje", "Hoje"],
  ["7d", "7 dias"],
  ["30d", "30 dias"],
];
const COMPARE: Record<Period, string> = { hoje: "ontem no mesmo horário", "7d": "7 dias anteriores", "30d": "30 dias anteriores" };
const WEEKDAY = new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short" });
const RANGE = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "numeric", month: "long" });
/** "12 a 18 de novembro" / "20 de outubro a 18 de novembro". */
function rangeLabel(from: Date, to: Date): string {
  const a = RANGE.format(from);
  const b = RANGE.format(to);
  const [da, ...ma] = a.split(" ");
  const [, ...mb] = b.split(" ");
  return ma.join(" ") === mb.join(" ") ? `${da} a ${b}` : `${a} a ${b}`;
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a * 1000) / b) / 10}%`.replace(".", ","));

export default async function Overview({ searchParams }: { searchParams: Promise<{ periodo?: string | string[] }> }) {
  const panel = await requirePanelActor();
  const role = panel.actor.role;
  if (!hasPermission(role, "metrics.read")) redirect(hasPermission(role, "orders.read") ? "/admin/orders" : "/admin/offers");
  const call = { ...panel, origin: "panel" as const };
  const q = firstParam((await searchParams).periodo);
  const period: Period = q === "hoje" || q === "30d" ? q : "7d";
  const now = new Date();
  const cur = periodRange(period, now);
  const lifetime = await runAction(metricsSummary, call, { from: new Date(0), to: now });
  const id = await getPanelIdentity(panel);

  if (lifetime.orders === 0 && lifetime.views === 0) return <EmptyOverview call={call} storeName={id.storeName} />;

  const m = await runAction(metricsSummary, call, cur);
  const prevRange = periodRange(period, now, { previous: true });
  const prev = await runAction(metricsSummary, call, prevRange);
  // Contatos somem com 30 dias: janela anterior que começa antes disso não tem com o que comparar.
  const leadsCompare = leadWindowCovered(prevRange.from, now) ? COMPARE[period] : undefined;
  const b = await runAction(metricsBreakdown, call, cur);
  const pending = hasPermission(role, "orders.read") ? (await runAction(orderCounts, call, {})).pendingManual : 0;
  const alerts = hasPermission(role, "connections.read") ? await runAction(listAlerts, call, {}) : null;
  const failedDeliveries = alerts?.failedDeliveries ?? (hasPermission(role, "orders.read") ? await runAction(listDeliveryFailures, call, {}) : []);
  const canAck = hasPermission(role, "connections.write");
  // Instalação sem o serviço de cartão (sem CARD_ORIGIN) e oferta ativa com cartão: o comprador só vê Pix.
  const cardNotice = cardSetupNoticeNeeded(cardServiceConfigured(env), hasPermission(role, "offers.read") ? await runAction(listOffers, call, {}) : []);

  const ticket = m.paid > 0 ? Math.round(m.revenueCents / m.paid) : 0;
  const prevTicket = prev.paid > 0 ? Math.round(prev.revenueCents / prev.paid) : 0;
  const unpaid = m.orders - m.byMethod.pix_manual.paid - m.byMethod.pix_asaas.paid - m.byMethod.card_asaas.paid;
  const maxDay = Math.max(0, ...b.byDay.map((d) => d.revenueCents));
  const days = PERIOD_DAYS[period];
  const label = (day: string, i: number) => {
    if (i === b.byDay.length - 1) return "hoje";
    if (days <= 7) return WEEKDAY.format(new Date(`${day}T12:00:00Z`)).replace(".", "");
    return i % 5 === 0 ? day.slice(8, 10) : "";
  };
  const methods = (Object.keys(m.byMethod) as OrderMethod[])
    .map((k) => ({ k, ...m.byMethod[k] }))
    .sort((a, z) => z.revenueCents - a.revenueCents);

  return (
    <>
      <PageHead
        title="Visão geral"
        sub={`${id.storeName} · ${period === "hoje" ? "hoje" : rangeLabel(cur.from, now)}`}
        actions={
          <nav className={s.segment} aria-label="Período">
            {PERIODS.map(([p, l]) => (
              <Link key={p} href={p === "7d" ? "/admin" : `/admin?periodo=${p}`} aria-current={p === period ? "page" : undefined}>
                {l}
              </Link>
            ))}
          </nav>
        }
      />

      <div className={s.alerts}>
        {cardNotice ? <CardSetupBanner /> : null}
        {pending > 0 ? (
          <div className={s.banner}>
            <PIcon name="hourglass" />
            <div>
              <b>
                {pending} {pending === 1 ? "pedido com Pix manual aguarda" : "pedidos com Pix manual aguardam"}
              </b>{" "}
              você conferir no extrato e liberar.
            </div>
            <Link className={s.bannerAction} href="/admin/orders?status=pending&method=pix_manual">
              Conferir agora →
            </Link>
          </div>
        ) : null}
        {alerts?.alerts.map((a) => (
          <div key={a.id} className={s.banner} data-tone="danger" role="alert">
            <PIcon name="triangle-alert" />
            <div>
              <b>{a.title}</b>
              <p>
                {a.body}
                {a.orderId ? (
                  <>
                    {" "}
                    <Link href={`/admin/orders/${a.orderId}`}>Ver pedido</Link>
                  </>
                ) : null}
              </p>
            </div>
            {canAck ? <AckButton onAck={ackAlertAction.bind(null, a.id)} /> : null}
          </div>
        ))}
        {failedDeliveries.length > 0 ? <FailedDeliveries items={failedDeliveries} /> : null}
      </div>

      <div className={s.stack}>
        <section className={s.grid4} aria-label="Números do período">
          <Kpi label="Receita" value={brl(m.revenueCents)} delta={deltaOf(m.revenueCents, prev.revenueCents)} compare={COMPARE[period]} />
          <Kpi label="Pedidos" value={String(m.orders)} delta={deltaOf(m.orders, prev.orders)} compare={COMPARE[period]} />
          <Kpi label="Pagos" value={String(m.paid)} delta={deltaOf(m.paid, prev.paid)} compare={COMPARE[period]} />
          <Kpi label="Ticket médio" value={brl(ticket)} delta={deltaOf(ticket, prevTicket)} compare={COMPARE[period]} />
        </section>

        {lifetime.leads > 0 ? (
          <section className={s.grid2} aria-label="Contatos do período">
            <Kpi label="Contatos capturados" value={String(m.leads)} delta={leadsCompare ? deltaOf(m.leads, prev.leads) : undefined} compare={leadsCompare} />
            <Kpi
              label="Viraram pedido"
              value={String(m.leadsConverted)}
              delta={leadsCompare ? deltaOf(m.leadsConverted, prev.leadsConverted) : undefined}
              compare={leadsCompare}
            />
          </section>
        ) : null}

        {lifetime.recovery.sent > 0 ? (
          <section className={s.grid3} aria-label="Recuperação de vendas por e-mail no período">
            <Kpi label="Lembretes enviados" value={String(m.recovery.sent)} delta={deltaOf(m.recovery.sent, prev.recovery.sent)} compare={COMPARE[period]} />
            <Kpi
              label="Vendas recuperadas"
              value={String(m.recovery.recovered)}
              delta={deltaOf(m.recovery.recovered, prev.recovery.recovered)}
              compare={COMPARE[period]}
            />
            <Kpi
              label="Receita recuperada"
              value={brl(m.recovery.recoveredRevenueCents)}
              delta={deltaOf(m.recovery.recoveredRevenueCents, prev.recovery.recoveredRevenueCents)}
              compare={COMPARE[period]}
            />
          </section>
        ) : null}

        <div className={s.splitWide}>
          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Conversão do checkout</h2>
              <small>visitas → pedidos → pagos</small>
            </div>
            <div className={s.funnel}>
              <div>
                <span>Visitas ao checkout</span>
                <b>{m.views.toLocaleString("pt-BR")}</b>
                <span className={s.bar} aria-hidden="true" style={{ display: "block" }}>
                  <i style={{ width: "100%" }} />
                </span>
              </div>
              <div className={s.funnelStep} aria-hidden="true">
                {pct(m.orders, m.views)}
                <PIcon name="arrow-right" size={16} />
              </div>
              <div>
                <span>Pedidos criados</span>
                <b>{m.orders.toLocaleString("pt-BR")}</b>
                <span className={s.bar} aria-hidden="true" style={{ display: "block" }}>
                  <i style={{ width: `${m.views ? Math.max(2, Math.round((m.orders * 100) / m.views)) : 0}%` }} />
                </span>
              </div>
              <div className={s.funnelStep} aria-hidden="true">
                {pct(m.paid, m.orders)}
                <PIcon name="arrow-right" size={16} />
              </div>
              <div>
                <span>Pagos</span>
                <b>{m.paid.toLocaleString("pt-BR")}</b>
                <span className={s.bar} aria-hidden="true" style={{ display: "block" }}>
                  <i style={{ width: `${m.views ? Math.max(2, Math.round((m.paid * 100) / m.views)) : 0}%` }} />
                </span>
              </div>
            </div>
            <div className={s.funnelFoot}>
              <span>
                <b>{pct(m.paid, m.views)}</b> das visitas viraram venda
              </span>
              <span>
                <b>{Math.max(0, unpaid)}</b> pedidos não pagos (Pix pendente ou expirado, cartão recusado)
              </span>
              <span>
                <b>{pct(b.bumpPaid, m.paid)}</b> aceitaram o bump
              </span>
            </div>
          </section>

          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Por método</h2>
              <small>receita · pagos</small>
            </div>
            <BarList
              rows={methods.map((r) => ({ label: METHOD_LABEL[r.k], value: r.revenueCents, text: brl(r.revenueCents), extra: r.paid }))}
            />
            <p className={s.hint} style={{ marginTop: 14 }}>
              Cartão: {plural(m.byMethod.card_asaas.paid, "pago", "pagos")} de {plural(m.byMethod.card_asaas.orders, "pedido", "pedidos")} (
              {pct(m.byMethod.card_asaas.paid, m.byMethod.card_asaas.orders)}).
            </p>
          </section>
        </div>

        <div className={s.grid3}>
          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Receita por dia</h2>
              <small>R$</small>
            </div>
            <div className={s.chart} role="img" aria-label={`Receita por dia: ${b.byDay.map((d) => `${d.day} ${brl(d.revenueCents)}`).join("; ")}`}>
              {b.byDay.map((d, i) => (
                <div
                  key={d.day}
                  className={s.chartCol}
                  data-today={i === b.byDay.length - 1 ? "true" : undefined}
                  data-max={d.revenueCents === maxDay && maxDay > 0 ? "true" : undefined}
                >
                  {d.revenueCents === maxDay && maxDay > 0 && days <= 7 ? <b>{brl(d.revenueCents).replace("R$ ", "")}</b> : null}
                  <i style={{ height: `${maxDay ? Math.round((d.revenueCents * 100) / maxDay) : 0}%` }} />
                </div>
              ))}
            </div>
            <div className={s.chartLabels} aria-hidden="true">
              {b.byDay.map((d, i) => (
                <span key={d.day}>{label(d.day, i)}</span>
              ))}
            </div>
          </section>
          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Por origem</h2>
              <small>utm_source · pagos</small>
            </div>
            <BarList
              rows={m.bySource.slice(0, 6).map((r) => ({ label: <span className={s.mono}>{r.source}</span>, value: r.revenueCents, text: brl(r.revenueCents), extra: r.paid }))}
              empty="Nenhuma venda paga no período."
            />
          </section>
          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Por indicação</h2>
              <small>?ref= · pagos</small>
            </div>
            <BarList
              rows={m.byRef.slice(0, 6).map((r) => ({ label: <span className={s.mono}>{r.ref}</span>, value: r.revenueCents, text: brl(r.revenueCents), extra: r.paid }))}
              empty="Nenhuma venda com ?ref= no período."
            />
            <p className={s.hint} style={{ marginTop: 14 }}>
              {plural(m.paid - m.byRef.reduce((a, r) => a + r.paid, 0), "venda", "vendas")} sem indicação.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

/** Aviso de cartão indisponível (instalação sem o serviço de cartão; docs/instalacao.md, seção 12). */
function CardSetupBanner() {
  return (
    <div className={s.banner} data-tone="danger" role="alert">
      <PIcon name="triangle-alert" />
      <div>
        <b>Cartão fora do checkout</b>
        <p>{CARD_SETUP_NOTICE}</p>
      </div>
    </div>
  );
}

/** P04: loja nova, sem nenhum pedido nem visita. Primeiros passos a partir do que já está configurado. */
async function EmptyOverview({ call, storeName }: { call: Parameters<typeof runAction>[1]; storeName: string }) {
  const conn = await runAction(connectionsStatus, call, {});
  const products = await runAction(listProducts, call, {});
  const offers = await runAction(listOffers, call, {});
  const settings = await runAction(getStoreSettings, call, {});
  const first = offers.find((o) => o.active);
  const checkout = first ? `${settings.checkoutBaseUrl}/c/${first.slug}` : null;
  const steps: Array<{ label: string; done: boolean; href?: string; cta?: string }> = [
    { label: "Criar a loja", done: true },
    { label: "Configurar como receber (Pix manual ou Asaas)", done: Boolean(conn.pixManual || conn.asaas), href: "/admin/connections", cta: "Configurar" },
    { label: "Enviar o PDF do produto", done: products.length > 0, href: "/admin/products", cta: "Enviar PDF" },
    { label: "Criar a primeira oferta", done: offers.length > 0, href: offers.length ? "/admin/offers" : "/admin/offers/nova", cta: "Criar oferta" },
    { label: "Conectar o Meta Pixel (use o mesmo Pixel ID de antes)", done: Boolean(conn.meta), href: "/admin/connections#meta", cta: "Conectar" },
    { label: "Colocar o script na sua página de vendas", done: false, href: "/admin/settings#script", cta: "Copiar script" },
  ];
  const done = steps.filter((x) => x.done).length;
  return (
    <>
      <PageHead title={`Boas-vindas, ${storeName}`} sub="Sua loja está quase pronta. Falta pouco para a primeira venda." />
      {cardSetupNoticeNeeded(cardServiceConfigured(env), offers) ? (
        <div className={s.alerts}>
          <CardSetupBanner />
        </div>
      ) : null}
      <div className={s.stack}>
        <div className={s.splitWide}>
          <section className={s.card}>
            <div className={s.cardHead}>
              <h2>Primeiros passos</h2>
              <small>
                {done} de {steps.length}
              </small>
            </div>
            <div className={s.progressTrack} aria-hidden="true">
              <i style={{ width: `${Math.round((done * 100) / steps.length)}%` }} />
            </div>
            <ol className={s.steps}>
              {steps.map((x) => (
                <li key={x.label} data-done={x.done ? "true" : undefined}>
                  <span className={s.stepDot}>{x.done ? <PIcon name="check" size={13} /> : null}</span>
                  <span>
                    {x.label}
                    {x.done ? <span className={s.srOnly}> (feito)</span> : null}
                  </span>
                  {!x.done && x.href ? <Link href={x.href}>{x.cta} ›</Link> : null}
                </li>
              ))}
            </ol>
          </section>
          <section className={`${s.card} ${s.empty}`}>
            <div className={s.emptyIcon}>
              <PIcon name="receipt" size={26} />
            </div>
            <h2>Nenhuma venda ainda</h2>
            <p>{checkout ? "Quando alguém comprar, os números aparecem aqui. Divulgue o link do checkout:" : "Quando alguém comprar, os números aparecem aqui."}</p>
            {checkout ? <CopyField text={checkout} /> : null}
          </section>
        </div>
        <section className={s.grid4} aria-label="Números">
          <Kpi label="Receita" value="R$ 0,00" empty />
          <Kpi label="Pedidos" value="0" empty />
          <Kpi label="Pagos" value="0" empty />
          <Kpi label="Visitas ao checkout" value="0" empty />
        </section>
      </div>
    </>
  );
}
