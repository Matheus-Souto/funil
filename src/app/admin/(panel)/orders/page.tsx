import Link from "next/link";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { brl, dateTimeShortSP } from "@/lib/format";
import { METHOD_LABEL, ORDER_METHODS, STATUS_FILTER_LABEL, type OrderMethod, type OrderStatus } from "@/lib/orders/labels";
import { listDeliveryFailures } from "@/lib/alerts";
import { listOrders } from "@/lib/orders/panel";
import { parseOrderMultiFilters, type Param } from "@/lib/panel-params";
import { getStoreSettings } from "@/lib/store-settings";
import { Art, FailedDeliveries, PageHead, StatusBadge } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "../../ui";
import { ColumnFilter, TableShell } from "./table-controls";
import { TablePager } from "../../table-pager";
import { parsePerPage } from "../../per-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pedidos" };

type Search = { status?: Param; method?: Param; q?: Param; pagina?: Param; por?: Param };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const sp = await searchParams;
  const { statuses, methods, q, page } = parseOrderMultiFilters(sp);
  const perPage = parsePerPage(sp.por);
  const data = await runAction(listOrders, call, { statuses, methods, q, page, pageSize: perPage });
  const canExport = hasPermission(panel.actor.role, "orders.export");

  const failed = await runAction(listDeliveryFailures, call, {});
  /** Query string com os filtros atuais (status e método podem repetir) e a página pedida. */
  const qs = (over: { pagina?: string } = {}) => {
    const p = new URLSearchParams();
    for (const v of statuses) p.append("status", v);
    for (const v of methods) p.append("method", v);
    if (q) p.set("q", q);
    if (over.pagina) p.set("pagina", over.pagina);
    const str = p.toString();
    return str ? `?${str}` : "";
  };
  const filtered = Boolean(statuses.length || methods.length || q);

  if (data.counts.all === 0 && !methods.length && !q) {
    const offers = hasPermission(panel.actor.role, "offers.read") ? await runAction(listOffers, call, {}) : [];
    const first = offers.find((o) => o.active);
    const base = hasPermission(panel.actor.role, "connections.read") ? (await runAction(getStoreSettings, call, {})).checkoutBaseUrl : null;
    const link = first && base ? `${base}/c/${first.slug}` : null;
    return (
      <>
        <PageHead title="Pedidos" />
        <section className={`${s.card} ${s.empty}`}>
          <Art name="pedidos" />
          <h2>Os pedidos aparecem aqui</h2>
          <p>Cada pessoa que preencher o checkout vira um pedido, mesmo antes de pagar. Assim você vê quem desistiu e quem pagou.</p>
          <ol className={s.steps} style={{ width: "min(460px, 100%)", textAlign: "left", marginTop: 12 }}>
            <li>
              <span className={s.stepDot}>1</span>
              <span>Abra o checkout e faça uma compra de teste com Pix manual.</span>
            </li>
            <li>
              <span className={s.stepDot}>2</span>
              <span>
                O pedido aparece aqui como <b>Aguardando liberação</b>.
              </span>
            </li>
            <li>
              <span className={s.stepDot}>3</span>
              <span>Libere e confira se o e-mail com o PDF chegou.</span>
            </li>
          </ol>
          {link ? (
            <div className={s.formActions} style={{ justifyContent: "center", marginTop: 12 }}>
              <a className={`${s.btn} ${s.btnPrimary}`} href={link} target="_blank" rel="noreferrer">
                <PIcon name="external-link" size={16} />
                Abrir checkout de teste
              </a>
              <CopyButton text={link} label="Copiar link" />
            </div>
          ) : null}
        </section>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Pedidos"
        actions={
          canExport ? (
            <a className={s.btn} href={`/admin/orders.csv${qs({ pagina: undefined })}`} download>
              <PIcon name="download" size={16} />
              Exportar CSV
            </a>
          ) : null
        }
      />
      {failed.length > 0 ? (
        <div className={s.noticeStrip}>
          <FailedDeliveries items={failed} />
        </div>
      ) : null}
      <TableShell q={q} statuses={statuses} methods={methods} total={data.total} filtered={filtered}>
        {data.items.length === 0 ? (
          <div className={s.empty}>
            <Art name="pedidos" size={96} />
            <h2>Nenhum pedido com estes filtros</h2>
            <p>Tente outra busca ou tire algum filtro das colunas.</p>
            <Link className={`${s.btn} ${s.btnSm}`} href="/admin/orders">
              Limpar filtros
            </Link>
          </div>
        ) : (
          <>
            <table className={`${s.table} ${s.orderTable}`}>
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Cliente</th>
                  <th scope="col">Oferta</th>
                  <th scope="col">
                    <ColumnFilter title="Método" param="method" values={methods} options={ORDER_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m], icon: m }))} />
                  </th>
                  <th scope="col" className={s.num}>
                    Valor
                  </th>
                  <th scope="col">
                    <ColumnFilter
                      title="Status"
                      param="status"
                      values={statuses}
                      options={(["pending", "paid", "expired", "declined", "refunded", "disputed"] as OrderStatus[])
                        .filter((k) => k !== "disputed" || data.counts.disputed > 0)
                        .map((k) => ({ value: k, label: STATUS_FILTER_LABEL[k], count: data.counts[k], icon: k }))}
                    />
                  </th>
                  <th scope="col">Data</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o.id} data-tone={o.status === "pending" && o.method === "pix_manual" ? "warning" : undefined}>
                    <td>
                      <Link className={`${s.rowLink} ${s.mono}`} href={`/admin/orders/${o.id}`}>
                        #{o.code}
                      </Link>
                    </td>
                    <td>
                      {o.buyerName}
                      <small>{o.email}</small>
                    </td>
                    <td>
                      {o.offerName}
                      {o.hasBump ? <small>+ bump</small> : null}
                    </td>
                    <td className={`${s.muted} ${s.nowrap}`}>{METHOD_LABEL[o.method as OrderMethod] ?? o.method}</td>
                    <td className={s.num}>{brl(o.manualAmountCents ?? o.totalCents)}</td>
                    <td>
                      <StatusBadge status={o.status} method={o.method} label={o.refundRequestedAt && o.status === "paid" ? "Estorno solicitado" : undefined} />
                    </td>
                    <td className={`${s.muted} ${s.nowrap}`}>{dateTimeShortSP(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className={s.orderCards}>
              {data.items.map((o) => (
                <li key={o.id}>
                  <Link className={s.orderCard} href={`/admin/orders/${o.id}`}>
                    <b>{o.buyerName}</b>
                    <b className={s.money}>{brl(o.manualAmountCents ?? o.totalCents)}</b>
                    <small>
                      #{o.code} · {METHOD_LABEL[o.method as OrderMethod] ?? o.method} · {dateTimeShortSP(o.createdAt)}
                    </small>
                    <StatusBadge status={o.status} method={o.method} />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        <TablePager page={page} perPage={perPage} total={data.total} />
      </TableShell>
    </>
  );
}
