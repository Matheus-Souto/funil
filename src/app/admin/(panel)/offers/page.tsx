import Link from "next/link";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { storeBaseUrl } from "@/lib/delivery/links";
import { brl } from "@/lib/format";
import { metricsBreakdown, periodRange } from "@/lib/metrics";
import { Badge, PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "../../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ofertas" };

const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a * 1000) / b) / 10}%`.replace(".", ","));

export default async function OffersPage() {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const role = panel.actor.role;
  const offers = await runAction(listOffers, call, {});
  const names = (ps: { name: string }[]) => ps.map((p) => p.name).join(" · ");
  const stats = hasPermission(role, "metrics.read") ? (await runAction(metricsBreakdown, call, periodRange("7d"))).byOffer : null;
  const base = storeBaseUrl((await getPanelIdentity(panel)).store);

  return (
    <>
      <PageHead
        title="Ofertas"
        sub="Cada oferta tem seu próprio checkout. Coloque o link no botão da página de vendas."
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
            <div className={s.emptyIcon}>
              <PIcon name="tag" size={26} />
            </div>
            <h2>Nenhuma oferta ainda</h2>
            <p>A oferta define o preço, os métodos de pagamento e o produto entregue. Envie o PDF em Produtos e crie a primeira.</p>
          </section>
        ) : null}
        {offers.map((o) => {
          const st = stats?.find((x) => x.offerId === o.id);
          const link = `${base}/c/${o.slug}`;
          return (
            <section key={o.id} className={`${s.card} ${s.offerCard}`} aria-labelledby={`oferta-${o.id}`}>
              <div className={s.stack} style={{ gap: 10 }}>
                <div className={s.titleRow}>
                  <h2 id={`oferta-${o.id}`} className={s.h2} style={{ fontSize: 17 }}>
                    {o.name}
                  </h2>
                  <Badge tone={o.active ? "success" : "neutral"}>{o.active ? "Ativa" : "Inativa"}</Badge>
                </div>
                <p className={s.muted} style={{ margin: 0 }}>
                  {names(o.products)} · <b style={{ color: "var(--color-text)" }}>{brl(o.priceCents)}</b>
                </p>
                <div className={s.chips}>
                  {o.methods.includes("pix") ? <span className={s.chip}>Pix · {o.pixMode === "manual" ? "Manual" : "Asaas"}</span> : null}
                  {o.methods.includes("card") ? (
                    <span className={s.chip}>
                      <PIcon name="credit-card" size={14} />
                      Cartão · {o.maxInstallments > 1 ? `até ${o.maxInstallments}x` : "1x"}
                    </span>
                  ) : null}
                  {o.bump ? (
                    <span className={s.chip} data-tone="primary">
                      <PIcon name="gift" size={14} />
                      Bump: {o.bump.products.length > 1 ? (o.bump.label ?? names(o.bump.products)) : names(o.bump.products)} + {brl(o.bump.priceCents)}
                    </span>
                  ) : (
                    <span className={s.chip}>Sem bump</span>
                  )}
                </div>
                <div className={s.copyBox} style={{ maxWidth: 480 }}>
                  <code>{link.replace(/^https?:\/\//, "")}</code>
                  <CopyButton text={link} label="Copiar link" small />
                </div>
              </div>
              <div className={s.stack} style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
                <Link className={s.btn} href={`/admin/offers/${o.id}`} aria-label={`${hasPermission(role, "offers.write") ? "Editar" : "Ver"} ${o.name}`}>
                  {hasPermission(role, "offers.write") ? "Editar" : "Ver"}
                </Link>
                {st || stats ? (
                  <div className={s.offerStats}>
                    <div>
                      <span>Vendas · 7 dias</span>
                      <b>{st?.paid ?? 0}</b>
                    </div>
                    <div>
                      <span>Conversão</span>
                      <b>{pct(st?.paid ?? 0, st?.views ?? 0)}</b>
                    </div>
                    <div>
                      <span>Bump aceito</span>
                      <b>{o.bump ? pct(st?.bumpPaid ?? 0, st?.paid ?? 0) : "—"}</b>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
        <div className={s.banner} data-tone="neutral">
          <PIcon name="link-2" />
          <div>
            <b>Indicações sem afiliado:</b> acrescente <code className={s.mono}>?ref=nome</code> ao link (ex.: …/c/
            {offers[0]?.slug ?? "sua-oferta"}?ref=ana-paula). As vendas aparecem em Visão geral → Por indicação.
          </div>
        </div>
      </div>
    </>
  );
}
