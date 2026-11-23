import Link from "next/link";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { listCoupons } from "@/lib/coupons/actions";
import { couponStatus, percentToInput } from "@/lib/coupons/form";
import { firstParam, type Param } from "@/lib/panel-params";
import { storeBaseUrl } from "@/lib/delivery/links";
import { brl, dateSP } from "@/lib/format";
import { metricsBreakdown, periodRange } from "@/lib/metrics";
import { CreditCard, Gift, QrCode } from "lucide-react";
import { Sparkline } from "../../charts";
import { Art, Badge, PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { CouponsPanel, type CouponRow } from "./coupons";
import { OffersTabs } from "./offers-tabs";
import { OFFERS_TABS, type OffersTab } from "./tabs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ofertas" };

const DAY_MS = 86_400_000;
/** "sáb., 15/11" (São Paulo), na dica do mini gráfico. */
const DAY_LABEL = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit" });
const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a * 1000) / b) / 10}%`.replace(".", ","));

/** Texto de validade do cupom, no horário de São Paulo ("de 01/12/2026 até 31/12/2026", "Sem prazo"). */
function validityText(c: { startsAt: Date | null; endsAt: Date | null }): string {
  if (!c.startsAt && !c.endsAt) return "Sem prazo";
  return [c.startsAt ? `de ${dateSP(c.startsAt)}` : null, c.endsAt ? `até ${dateSP(c.endsAt)}` : null].filter(Boolean).join(" ");
}

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ aba?: Param }> }) {
  const panel = await requirePanelActor();
  const aba = firstParam((await searchParams).aba);
  const initialTab: OffersTab = OFFERS_TABS.find(([k]) => k === aba)?.[0] ?? "ofertas";
  const call = { ...panel, origin: "panel" as const };
  const role = panel.actor.role;
  const offers = await runAction(listOffers, call, {});
  const names = (ps: { name: string }[]) => ps.map((p) => p.name).join(" · ");
  const canMetrics = hasPermission(role, "metrics.read");
  const week = periodRange("7d");
  // Uma chamada: números da semana por oferta e as vendas de cada oferta por dia (mini gráfico).
  const week7 = canMetrics ? await runAction(metricsBreakdown, call, week) : null;
  const stats = week7?.byOffer ?? null;
  const days = week7?.byDay.map((d) => d.day) ?? [];
  const sold = new Map(week7?.byOfferDay.map((r) => [`${r.offerId}|${r.day}`, r.paid]) ?? []);
  const dayLabels = Array.from({ length: days.length }, (_, k) => DAY_LABEL.format(new Date(week.from.getTime() + k * DAY_MS + 12 * 3_600_000)));
  const trend = (offerId: string) => days.map((day) => sold.get(`${offerId}|${day}`) ?? 0);
  const base = storeBaseUrl((await getPanelIdentity(panel)).store);
  const now = new Date();
  const couponRows: CouponRow[] = (await runAction(listCoupons, call, { includeArchived: true })).map((c) => ({
    id: c.id,
    code: c.code,
    kind: c.kind,
    percentBp: c.percentBp,
    amountCents: c.amountCents,
    appliesTo: c.appliesTo,
    startsAtIso: c.startsAt?.toISOString() ?? null,
    endsAtIso: c.endsAt?.toISOString() ?? null,
    maxUses: c.maxUses,
    maxPerEmail: c.maxPerEmail,
    active: c.active,
    offerIds: c.offerIds,
    uses: c.uses,
    status: couponStatus(c, now),
    discountText: c.kind === "percent" ? `${percentToInput(c.percentBp ?? 0)}%` : brl(c.amountCents ?? 0),
    validityText: validityText(c),
    discountSort: c.kind === "percent" ? (c.percentBp ?? 0) : (c.amountCents ?? 0),
    endTs: c.endsAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
  }));

  return (
    <>
      <PageHead
        title="Ofertas"
        actions={
          hasPermission(role, "offers.write") ? (
            <Link className={`${s.btn} ${s.btnPrimary}`} href="/admin/offers/nova">
              <PIcon name="plus" size={16} />
              Nova oferta
            </Link>
          ) : null
        }
      />
      <OffersTabs
        initialTab={initialTab}
        coupons={<CouponsPanel coupons={couponRows} offers={offers.map((o) => ({ id: o.id, name: o.name }))} canWrite={hasPermission(role, "offers.write")} />}
        offers={
        <div className={s.stack}>
          {offers.length === 0 ? (
            <section className={`${s.card} ${s.empty}`}>
              <Art name="ticket" />
              <h2>Nenhuma oferta ainda</h2>
              <p>A oferta define o preço, os métodos de pagamento e o produto entregue. Envie o PDF em Produtos e crie a primeira.</p>
            </section>
          ) : null}
          {offers.length > 0 ? (
            <section className={`${s.card} ${s.offerList}`} aria-label="Ofertas">
              {offers.map((o) => {
                const st = stats?.find((x) => x.offerId === o.id);
                const link = `${base}/c/${o.slug}`;
                return (
                  <article key={o.id} className={s.offerRow} aria-labelledby={`oferta-${o.id}`}>
                    <Art name="ticket" size={40} className={s.offerArt} />
                    <div className={s.offerMain}>
                      <div className={s.titleRow} style={{ gap: 8 }}>
                        <h2 id={`oferta-${o.id}`} className={s.offerName}>
                          {o.name}
                        </h2>
                        <Badge tone={o.active ? "success" : "neutral"}>{o.active ? "Ativa" : "Inativa"}</Badge>
                      </div>
                      <div className={s.offerMeta}>
                        <span>
                          {names(o.products)} · <b>{brl(o.priceCents)}</b>
                        </span>
                        {o.methods.includes("pix") ? (
                          <span className={s.chip}>
                            <QrCode size={13} strokeWidth={1.9} aria-hidden="true" />
                            Pix · {o.pixMode === "manual" ? "Manual" : "Asaas"}
                          </span>
                        ) : null}
                        {o.methods.includes("card") ? (
                          <span className={s.chip}>
                            <CreditCard size={13} strokeWidth={1.9} aria-hidden="true" />
                            Cartão · {o.maxInstallments > 1 ? `até ${o.maxInstallments}x` : "1x"}
                          </span>
                        ) : null}
                        {o.bump ? (
                          <span className={s.chip} data-tone="primary">
                            <Gift size={13} strokeWidth={1.9} aria-hidden="true" />
                            Bump: {o.bump.products.length > 1 ? (o.bump.label ?? names(o.bump.products)) : names(o.bump.products)} + {brl(o.bump.priceCents)}
                          </span>
                        ) : null}
                      </div>
                      <div className={s.offerLink}>
                        <code>{link.replace(/^https?:\/\//, "")}</code>
                        <CopyButton value={link} label="Copiar link" iconOnly variant="plain" />
                      </div>
                    </div>
                    {stats ? (
                      <>
                        <div className={s.offerSpark}>
                          <Sparkline values={trend(o.id)} days={dayLabels} label={`Vendas de ${o.name} nos últimos 7 dias`} />
                        </div>
                        <div className={s.offerMetric}>
                          <span>Vendas 7d</span>
                          <b>{st?.paid ?? 0}</b>
                        </div>
                        <div className={s.offerMetric}>
                          <span>Conversão</span>
                          <b>{pct(st?.paid ?? 0, st?.views ?? 0)}</b>
                        </div>
                        <div className={s.offerMetric}>
                          <span>Bump</span>
                          <b>{o.bump ? pct(st?.bumpPaid ?? 0, st?.paid ?? 0) : "—"}</b>
                        </div>
                      </>
                    ) : null}
                    <Link className={`${s.btn} ${s.btnSm}`} href={`/admin/offers/${o.id}`} aria-label={`${hasPermission(role, "offers.write") ? "Editar" : "Ver"} ${o.name}`}>
                      {hasPermission(role, "offers.write") ? "Editar" : "Ver"}
                    </Link>
                  </article>
                );
              })}
            </section>
          ) : null}
          <div className={s.banner} data-tone="neutral">
            <PIcon name="link-2" />
            <div>
              <b>Indicações sem afiliado:</b> acrescente <code className={s.mono}>?ref=nome</code> ao link (ex.: …/c/
              {offers[0]?.slug ?? "sua-oferta"}?ref=ana-paula). As vendas aparecem no Dashboard, em Por indicação.
            </div>
          </div>
        </div>
        }
      />
    </>
  );
}
