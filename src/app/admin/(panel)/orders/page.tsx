import Link from "next/link";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { dateTimeShortSP } from "@/lib/format";
import { METHOD_LABEL, ORDER_METHODS, STATUS_FILTER_LABEL, type OrderMethod, type OrderStatus } from "@/lib/orders/labels";
import { listDeliveryFailures } from "@/lib/alerts";
import { listOrders } from "@/lib/orders/panel";
import { parseOrderMultiFilters, type Param } from "@/lib/panel-params";
import { getStoreSettings } from "@/lib/store-settings";
import { Art, FailedDeliveries, PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "../../ui";
import { ColumnFilter, TableShell } from "../../table-controls";
import { OrdersTable } from "./orders-table";
import { TablePager } from "../../table-pager";
import { ORDERS_PER_PAGE, parsePerPage } from "../../per-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pedidos" };

type Search = { status?: Param; method?: Param; q?: Param; pagina?: Param; por?: Param };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const sp = await searchParams;
  const { statuses, methods, q, page: requested } = parseOrderMultiFilters(sp);
  const perPage = parsePerPage(sp.por, ORDERS_PER_PAGE);
  let page = requested;
  let data = await runAction(listOrders, call, { statuses, methods, q, page, pageSize: perPage });
  // ?pagina= além do fim (link antigo, pedidos que sumiram do filtro): mostra a última página em vez de "nenhum pedido".
  const last = Math.max(1, Math.ceil(data.total / perPage));
  if (data.items.length === 0 && page > last) {
    page = last;
    data = await runAction(listOrders, call, { statuses, methods, q, page, pageSize: perPage });
  }
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
  const statusOptions = (["pending", "paid", "expired", "declined", "refunded", "disputed"] as OrderStatus[])
    .filter((k) => k !== "disputed" || data.counts.disputed > 0)
    .map((k) => ({ value: k, label: STATUS_FILTER_LABEL[k], hint: data.counts[k] }));
  const columnFilters = {
    status: <ColumnFilter compact title="Status" param="status" values={statuses} options={statusOptions.map((o) => ({ value: o.value, label: o.label, count: o.hint, icon: o.value }))} />,
    method: <ColumnFilter compact title="Método" param="method" values={methods} options={ORDER_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m], icon: m }))} />,
  };

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
      <TableShell
        q={q}
        keep={{ status: statuses, method: methods, por: perPage === ORDERS_PER_PAGE ? [] : [String(perPage)] }}
        active={[
          ...statuses.map((v) => ({ param: "status", value: v, label: `Status: ${STATUS_FILTER_LABEL[v]}` })),
          ...methods.map((v) => ({ param: "method", value: v, label: `Método: ${METHOD_LABEL[v]}` })),
        ]}
        placeholder="Buscar por nome ou e-mail"
        searchLabel="Buscar pedidos"
        count={`${data.total} ${data.total === 1 ? "pedido" : "pedidos"}${filtered ? " com estes filtros" : ""}`}
      >
        {data.items.length === 0 ? (
          <div className={s.empty}>
            <Art name="pedidos" size={96} />
            <h2>Nenhum pedido com estes filtros</h2>
            <p>Tente outra busca ou tire algum filtro das colunas.</p>
            <Link className={`${s.btn} ${s.btnSm}`} href={perPage === ORDERS_PER_PAGE ? "/admin/orders" : `/admin/orders?por=${perPage}`}>
              Limpar filtros
            </Link>
          </div>
        ) : (
          <OrdersTable
            paged={data.total > perPage}
            filters={columnFilters}
            rows={data.items.map((o) => ({
              id: o.id,
              code: o.code,
              buyerName: o.buyerName,
              email: o.email,
              offerName: o.offerName,
              hasBump: o.hasBump,
              method: o.method,
              methodLabel: METHOD_LABEL[o.method as OrderMethod] ?? o.method,
              cents: o.manualAmountCents ?? o.totalCents,
              status: o.status,
              statusLabel: STATUS_FILTER_LABEL[o.status as OrderStatus] ?? o.status,
              refundRequested: o.refundRequestedAt !== null,
              createdText: dateTimeShortSP(o.createdAt),
              createdTs: o.createdAt.getTime(),
            }))}
          />
        )}
        <TablePager page={page} perPage={perPage} total={data.total} defaultPerPage={ORDERS_PER_PAGE} />
      </TableShell>
    </>
  );
}
