import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { listProducts } from "@/lib/catalog/products";
import { fileSize } from "@/lib/format";
import { Art, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import Link from "next/link";
import { Search } from "lucide-react";
import { NewProductButton } from "./upload";
import { PdfViewerButton, ProductCell } from "./pdf-view";
import { TablePager } from "../../table-pager";
import { parsePage, parsePerPage } from "../../per-page";
import { firstParam, type Param } from "@/lib/panel-params";

export const dynamic = "force-dynamic";
export const metadata = { title: "Produtos" };

const DAY = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit" });

const USE_FILTERS = [
  ["", "Todos"],
  ["em-uso", "Em uso"],
  ["sem-oferta", "Sem oferta"],
] as const;
/** Sem acento e em minúsculas, para a busca achar "manual" em "Maná". */
const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ pagina?: Param; por?: Param; q?: Param; uso?: Param }> }) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const all = await runAction(listProducts, call, {});
  const sp = await searchParams;
  const q = firstParam(sp.q)?.trim().slice(0, 100) ?? "";
  const uso = firstParam(sp.uso) === "em-uso" || firstParam(sp.uso) === "sem-oferta" ? firstParam(sp.uso)! : "";
  const offers = hasPermission(panel.actor.role, "offers.read") ? await runAction(listOffers, call, {}) : [];
  const usedIn = (id: string) =>
    offers.flatMap((o) => (o.products.some((p) => p.id === id) ? [o.name] : o.bump?.products.some((p) => p.id === id) ? [`${o.name} · bump`] : []));
  const products = all.filter(
    (p) =>
      (!q || fold(`${p.name} ${p.fileName}`).includes(fold(q))) &&
      (uso === "" || (uso === "em-uso" ? usedIn(p.id).length > 0 : usedIn(p.id).length === 0)),
  );
  const perPage = parsePerPage(sp.por);
  const page = parsePage(sp.pagina, products.length, perPage);
  const shown = products.slice((page - 1) * perPage, page * perPage);
  const canWrite = hasPermission(panel.actor.role, "products.write");
  const href = (over: { uso?: string }) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    const u = over.uso ?? uso;
    if (u) p.set("uso", u);
    const str = p.toString();
    return `/admin/products${str ? `?${str}` : ""}`;
  };

  return (
    <>
      <PageHead title="Produtos" actions={canWrite ? <NewProductButton /> : null} />
      <div className={s.stack}>
        {all.length > 0 ? (
          <section className={`${s.card} ${s.cardFlush}`}>
            <div className={s.tableBar}>
              <form method="get" role="search" className={s.tableSearch}>
                {uso ? <input type="hidden" name="uso" value={uso} /> : null}
                <Search size={15} strokeWidth={2} aria-hidden="true" />
                <input name="q" defaultValue={q} placeholder="Buscar produto" maxLength={100} aria-label="Buscar produtos" />
              </form>
              <nav className={s.segment} aria-label="Filtrar por uso">
                {USE_FILTERS.map(([v, label]) => (
                  <Link key={v || "todos"} href={href({ uso: v })} aria-current={uso === v ? "page" : undefined}>
                    {label}
                  </Link>
                ))}
              </nav>
              <span className={s.tableCount}>
                {products.length} {products.length === 1 ? "produto" : "produtos"}
              </span>
            </div>
            {products.length > 0 ? (
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">Produto</th>
                    <th scope="col">Arquivo</th>
                    <th scope="col">Usado em</th>
                    <th scope="col">Enviado</th>
                    <th scope="col">
                      <span className={s.srOnly}>Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => {
                    const used = usedIn(p.id);
                    return (
                      <tr key={p.id}>
                        <td>
                          <ProductCell id={p.id} name={p.name} />
                        </td>
                        <td className={s.muted}>
                          {p.fileName} · {fileSize(p.fileSize)}
                        </td>
                        <td>
                          {used.length ? (
                            <span className={s.chips}>
                              {used.map((u) => (
                                <span key={u} className={s.chip} data-tone="primary">
                                  {u}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className={s.muted}>Sem oferta</span>
                          )}
                        </td>
                        <td className={`${s.muted} ${s.nowrap}`}>{DAY.format(p.createdAt)}</td>
                        <td className={s.num}>
                          <PdfViewerButton id={p.id} name={p.name} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className={s.empty}>
                <Art name="produto" size={96} />
                <h2>Nenhum produto com esta busca</h2>
                <Link className={`${s.btn} ${s.btnSm}`} href="/admin/products">
                  Limpar busca
                </Link>
              </div>
            )}
            <TablePager page={page} perPage={perPage} total={products.length} />
          </section>
        ) : (
          <section className={`${s.card} ${s.empty}`}>
            <Art name="produto" />
            <h2>Nenhum produto ainda</h2>
            <p>Envie o PDF que o comprador vai receber. Cada um baixa uma cópia com o próprio nome e e-mail.</p>
          </section>
        )}
      </div>
    </>
  );
}
