import Link from "next/link";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { storeBaseUrl } from "@/lib/delivery/links";
import { brl } from "@/lib/format";
import { metricsBreakdown, periodRange } from "@/lib/metrics";
import { CreditCard, Gift, QrCode } from "lucide-react";
import { Sparkline } from "../../charts";
import { Art, Badge, PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "../../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ofertas" };

const DAY_MS = 86_400_000;
const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a * 1000) / b) / 10}%`.replace(".", ","));

export default async function OffersPage() {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const role = panel.actor.role;
  const offers = await runAction(listOffers, call, {});
  const names = (ps: { name: string }[]) => ps.map((p) => p.name).join(" · ");
  const canMetrics = hasPermission(role, "metrics.read");
  const week = periodRange("7d");
  const stats = canMetrics ? (await runAction(metricsBreakdown, call, week)).byOffer : null;
  // Vendas de cada oferta por dia (7 dias) para o mini gráfico: a mesma ação, dia a dia. Ver docs/painel-pendencias.md
  // (o ideal é o servidor devolver isso numa consulta só).
  const daily = canMetrics
    ? await Promise.all(
        Array.from({ length: 7 }, (_, k) => {
          const from = new Date(week.from.getTime() + k * DAY_MS);
          const to = new Date(Math.min(from.getTime() + DAY_MS, week.to.getTime()));
          return runAction(metricsBreakdown, call, { from, to }).then((r) => r.byOffer);
        }),
      )
    : null;
  const trend = (offerId: string) => daily?.map((day) => day.find((x) => x.offerId === offerId)?.paid ?? 0) ?? [];
  const base = storeBaseUrl((await getPanelIdentity(panel)).store);

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
                      <CopyButton text={link} label="Copiar link" small />
                    </div>
                  </div>
                  {stats ? (
                    <>
                      <div className={s.offerSpark}>
                        <Sparkline values={trend(o.id)} label={`Vendas de ${o.name} nos últimos 7 dias`} />
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
    </>
  );
}
