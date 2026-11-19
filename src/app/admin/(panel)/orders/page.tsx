import Link from "next/link";
import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { brl, shortWhenSP as shortWhen } from "@/lib/format";
import { METHOD_LABEL, ORDER_METHODS, STATUS_FILTER_LABEL, type OrderMethod, type OrderStatus } from "@/lib/orders/labels";
import { listDeliveryFailures } from "@/lib/alerts";
import { listOrders } from "@/lib/orders/panel";
import { parseOrderFilters, type Param } from "@/lib/panel-params";
import { getStoreSettings } from "@/lib/store-settings";
import { FailedDeliveries, PageHead, StatusBadge } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyButton } from "../../ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pedidos" };

type Search = { status?: Param; method?: Param; q?: Param; pagina?: Param };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const { status, method, q, page } = parseOrderFilters(await searchParams);
  const data = await runAction(listOrders, call, { status, method, q, page });
  const canExport = hasPermission(panel.actor.role, "orders.export");

  const failed = await runAction(listDeliveryFailures, call, {});
  const qs = (over: Partial<Record<keyof Search, string | undefined>>) => {
    const p = new URLSearchParams();
    const merged = { status, method, q, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const str = p.toString();
    return str ? `?${str}` : "";
  };
  const filtered = Boolean(status || method || q);

  if (data.counts.all === 0 && !method && !q) {
    const offers = hasPermission(panel.actor.role, "offers.read") ? await runAction(listOffers, call, {}) : [];
    const first = offers.find((o) => o.active);
    const base = hasPermission(panel.actor.role, "connections.read") ? (await runAction(getStoreSettings, call, {})).checkoutBaseUrl : null;
    const link = first && base ? `${base}/c/${first.slug}` : null;
    return (
      <>
        <PageHead title="Pedidos" sub="Nenhum pedido ainda" />
        <section className={`${s.card} ${s.empty}`}>
          <div className={s.emptyIcon}>
            <PIcon name="inbox" size={26} />
          </div>
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

  const from = data.total === 0 ? 0 : (page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, page * data.pageSize);
  return (
    <>
      <PageHead
        title="Pedidos"
        sub={`${data.counts.all} ${data.counts.all === 1 ? "pedido" : "pedidos"}${filtered ? " com estes filtros" : ""}`}
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
        <div className={s.alerts}>
          <FailedDeliveries items={failed} />
        </div>
      ) : null}
      <form className={s.filters} method="get" role="search">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <label className={s.search}>
          <PIcon name="search" size={16} />
          <span className={s.srOnly}>Buscar pedidos</span>
          <input name="q" defaultValue={q} placeholder="Buscar por nome ou e-mail" maxLength={100} />
        </label>
        <label className={s.selectBox}>
          Método:
          <select name="method" defaultValue={method ?? ""}>
            <option value="">Todos</option>
            {ORDER_METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={s.btn}>
          Filtrar
        </button>
      </form>
      <nav className={s.pills} aria-label="Filtrar por status">
        <Link className={s.pill} href={`/admin/orders${qs({ status: undefined, pagina: undefined })}`} aria-current={!status ? "page" : undefined}>
          Todos <b>{data.counts.all}</b>
        </Link>
        {(["pending", "paid", "expired", "declined", "refunded", "disputed"] as OrderStatus[])
          .filter((k) => k !== "disputed" || data.counts.disputed > 0)
          .map((k) => (
            <Link key={k} className={s.pill} href={`/admin/orders${qs({ status: k, pagina: undefined })}`} aria-current={status === k ? "page" : undefined}>
              {STATUS_FILTER_LABEL[k]} <b>{data.counts[k]}</b>
            </Link>
          ))}
      </nav>

      <section className={`${s.card} ${s.cardFlush}`}>
        {data.items.length === 0 ? (
          <p className={s.empty}>Nenhum pedido com estes filtros.</p>
        ) : (
          <>
            <table className={`${s.table} ${s.orderTable}`}>
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Cliente</th>
                  <th scope="col">Oferta</th>
                  <th scope="col">Método</th>
                  <th scope="col" className={s.num}>
                    Valor
                  </th>
                  <th scope="col">Status</th>
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
                    <td className={`${s.muted} ${s.nowrap}`}>{shortWhen(o.createdAt)}</td>
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
                      #{o.code} · {METHOD_LABEL[o.method as OrderMethod] ?? o.method} · {shortWhen(o.createdAt)}
                    </small>
                    <StatusBadge status={o.status} method={o.method} />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className={s.tableFoot}>
          <span>
            Mostrando {from}–{to} de {data.total}
          </span>
          <div>
            {page > 1 ? (
              <Link className={s.btn} href={`/admin/orders${qs({ pagina: String(page - 1) })}`}>
                Anterior
              </Link>
            ) : (
              <span className={s.btn} aria-disabled="true">
                Anterior
              </span>
            )}
            {to < data.total ? (
              <Link className={s.btn} href={`/admin/orders${qs({ pagina: String(page + 1) })}`}>
                Próxima
              </Link>
            ) : (
              <span className={s.btn} aria-disabled="true">
                Próxima
              </span>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
