import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { listProducts } from "@/lib/catalog/products";
import { fileSize } from "@/lib/format";
import { Art, PageHead } from "../../blocks";
import s from "../../panel.module.css";
import { ProductUpload } from "./upload";
import { TablePager } from "../../table-pager";
import { parsePage, parsePerPage } from "../../per-page";
import type { Param } from "@/lib/panel-params";

export const dynamic = "force-dynamic";
export const metadata = { title: "Produtos" };

const DAY = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ pagina?: Param; por?: Param }> }) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const products = await runAction(listProducts, call, {});
  const sp = await searchParams;
  const perPage = parsePerPage(sp.por);
  const page = parsePage(sp.pagina, products.length, perPage);
  const shown = products.slice((page - 1) * perPage, page * perPage);
  const offers = hasPermission(panel.actor.role, "offers.read") ? await runAction(listOffers, call, {}) : [];
  const usedIn = (id: string) =>
    offers
      .flatMap((o) => (o.products.some((p) => p.id === id) ? [o.name] : o.bump?.products.some((p) => p.id === id) ? [`${o.name} · bump`] : []))
      .join(", ") || "—";
  const canWrite = hasPermission(panel.actor.role, "products.write");

  return (
    <>
      <PageHead title="Produtos" />
      <div className={s.stack}>
        {products.length > 0 ? (
          <section className={`${s.card} ${s.cardFlush}`}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Produto</th>
                  <th scope="col">Arquivo</th>
                  <th scope="col">Usado em</th>
                  <th scope="col">Enviado</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className={s.productCell}>
                        <Art name="pdf" size={40} className={s.fileArt} />
                        <b>{p.name}</b>
                      </span>
                    </td>
                    <td className={s.muted}>
                      {p.fileName} · {fileSize(p.fileSize)}
                    </td>
                    <td className={s.muted}>{usedIn(p.id)}</td>
                    <td className={s.muted}>{DAY.format(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <TablePager page={page} perPage={perPage} total={products.length} />
          </section>
        ) : (
          <section className={`${s.card} ${s.empty}`}>
            <Art name="produto" />
            <h2>Nenhum produto ainda</h2>
            <p>Envie o PDF que o comprador vai receber. Cada um baixa uma cópia com o próprio nome e e-mail.</p>
          </section>
        )}
        {canWrite ? <ProductUpload /> : null}
      </div>
    </>
  );
}
