import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { listProducts } from "@/lib/catalog/products";
import { fileSize } from "@/lib/format";
import { Art, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import Link from "next/link";
import { NewProductButton } from "./upload";
import { TablePager } from "../../table-pager";
import { PER_PAGE_OPTIONS, parsePage, parsePerPage } from "../../per-page";
import { firstParam, type Param } from "@/lib/panel-params";
import { ColumnFilter, TableShell } from "../../table-controls";
import { ProductsTable } from "./products-table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Produtos" };

const DAY = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit" });

const USES = { "em-uso": "Em uso", "sem-oferta": "Sem oferta" } as const;
type Use = keyof typeof USES;
const isUse = (v: string): v is Use => Object.hasOwn(USES, v);
/** Sem acento e em minúsculas, para a busca achar "manual" em "Maná". */
const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ pagina?: Param; por?: Param; q?: Param; status?: Param }> }) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const all = await runAction(listProducts, call, {});
  const sp = await searchParams;
  const q = firstParam(sp.q)?.trim().slice(0, 100) ?? "";
  const statuses = [...new Set((sp.status === undefined ? [] : Array.isArray(sp.status) ? sp.status : [sp.status]).flatMap((v) => v.split(",")))].filter(isUse);
  const offers = hasPermission(panel.actor.role, "offers.read") ? await runAction(listOffers, call, {}) : [];
  const usedIn = (id: string) =>
    offers.flatMap((o) => (o.products.some((p) => p.id === id) ? [o.name] : o.bump?.products.some((p) => p.id === id) ? [`${o.name} · bump`] : []));
  const usageOf = (id: string): Use => (usedIn(id).length > 0 ? "em-uso" : "sem-oferta");
  const searched = all.filter((p) => !q || fold(`${p.name} ${p.fileName}`).includes(fold(q)));
  const products = searched.filter((p) => statuses.length === 0 || statuses.includes(usageOf(p.id)));
  const perPage = parsePerPage(sp.por);
  const page = parsePage(sp.pagina, products.length, perPage);
  const shown = products.slice((page - 1) * perPage, page * perPage);
  const canWrite = hasPermission(panel.actor.role, "products.write");
  const filtered = statuses.length > 0 || q !== "";

  return (
    <>
      <PageHead title="Produtos" actions={canWrite ? <NewProductButton /> : null} />
      <div className={s.stack}>
        {all.length > 0 ? (
          <TableShell
            q={q}
            keep={{ status: statuses, por: perPage === PER_PAGE_OPTIONS[0] ? [] : [String(perPage)] }}
            placeholder="Buscar produto"
            searchLabel="Buscar produtos"
            count={`${products.length} ${products.length === 1 ? "produto" : "produtos"}${filtered ? " com estes filtros" : ""}`}
          >
            {products.length > 0 ? (
              <ProductsTable
                canView={canWrite}
                statusFilter={
                  <ColumnFilter
                    compact
                    title="Status"
                    param="status"
                    values={statuses}
                    options={(Object.keys(USES) as Use[]).map((k) => ({ value: k, label: USES[k], count: searched.filter((p) => usageOf(p.id) === k).length, icon: k }))}
                  />
                }
                rows={shown.map((p) => {
                  const used = usedIn(p.id);
                  return {
                    id: p.id,
                    name: p.name,
                    pages: p.pageCount,
                    file: `${p.fileName} · ${fileSize(p.fileSize)}`,
                    inUse: used.length > 0,
                    usageLabel: used.length ? USES["em-uso"] : USES["sem-oferta"],
                    usedIn: used,
                    createdText: DAY.format(p.createdAt),
                    createdTs: p.createdAt.getTime(),
                  };
                })}
              />
            ) : (
              <div className={s.empty}>
                <Art name="produto" size={96} />
                <h2>Nenhum produto com estes filtros</h2>
                <Link className={`${s.btn} ${s.btnSm}`} href={perPage === PER_PAGE_OPTIONS[0] ? "/admin/products" : `/admin/products?por=${perPage}`}>
                  Limpar filtros
                </Link>
              </div>
            )}
            <TablePager page={page} perPage={perPage} total={products.length} />
          </TableShell>
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
