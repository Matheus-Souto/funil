import { runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor } from "@/lib/auth/session";
import { listOffers } from "@/lib/catalog/offers";
import { listProducts } from "@/lib/catalog/products";
import { PageHead } from "../../blocks";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { ProductUpload } from "./upload";

export const dynamic = "force-dynamic";
export const metadata = { title: "Produtos" };

const DAY = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default async function ProductsPage() {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const products = await runAction(listProducts, call, {});
  const offers = hasPermission(panel.actor.role, "offers.read") ? await runAction(listOffers, call, {}) : [];
  const usedIn = (id: string) =>
    offers.flatMap((o) => (o.productId === id ? [o.name] : o.bumpProductId === id ? [`${o.name} · bump`] : [])).join(", ") || "—";
  const canWrite = hasPermission(panel.actor.role, "products.write");

  return (
    <>
      <PageHead title="Produtos" sub="Os arquivos que suas ofertas entregam." />
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
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className={s.productCell}>
                        <span className={s.fileTag} aria-hidden="true">
                          PDF
                        </span>
                        <b>{p.name}</b>
                      </span>
                    </td>
                    <td className={s.muted}>
                      {p.fileName} · {size(p.fileSize)}
                    </td>
                    <td className={s.muted}>{usedIn(p.id)}</td>
                    <td className={s.muted}>{DAY.format(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className={s.tableFoot} style={{ justifyContent: "flex-start" }}>
              <PIcon name="file-text" size={16} />
              Cada comprador baixa uma cópia com o próprio nome e e-mail no rodapé das páginas.
            </div>
          </section>
        ) : (
          <p className={s.muted}>Nenhum produto ainda. Envie o PDF que o comprador vai receber.</p>
        )}
        {canWrite ? <ProductUpload /> : null}
      </div>
    </>
  );
}
