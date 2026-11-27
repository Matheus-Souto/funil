import { notFound } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { getOffer } from "@/lib/catalog/offers";
import { listProducts } from "@/lib/catalog/products";
import { storeBaseUrl } from "@/lib/delivery/links";
import { cardServiceConfigured, env } from "@/lib/env";
import { firstParam } from "@/lib/panel-params";
import type { ProductRef } from "@/lib/catalog/offer-products";
import { OfferEditor, type OfferData, type ProductOption } from "./editor";
import s from "../../../panel.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Oferta" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /admin/offers/nova cria; /admin/offers/<id> edita (ou só mostra, para quem não tem offers.write). */
export default async function OfferPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ criada?: string | string[] }>;
}) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const role = panel.actor.role;
  const { id } = await params;
  const isNew = id === "nova";
  if (!isNew && !UUID.test(id)) notFound();
  if (isNew && !hasPermission(role, "offers.write")) notFound();

  let offer: OfferData | null = null;
  let offerProducts: ProductRef[] = [];
  if (!isNew) {
    try {
      const o = await runAction(getOffer, call, { id });
      offer = {
        id: o.id,
        slug: o.slug,
        name: o.name,
        delivery: o.delivery as "download" | "app",
        appCode: o.appCode,
        productIds: o.products.map((p) => p.id),
        priceCents: o.priceCents,
        methods: o.methods,
        pixMode: o.pixMode as "manual" | "asaas",
        maxInstallments: o.maxInstallments,
        bump: o.bump ? { productIds: o.bump.products.map((p) => p.id), priceCents: o.bump.priceCents, label: o.bump.label } : null,
        thankYouText: o.thankYouText,
        pixelId: o.pixelId,
        active: o.active,
      };
      offerProducts = [...o.products, ...(o.bump?.products ?? [])];
    } catch (e) {
      if (e instanceof ActionError && e.code === "not_found") notFound();
      throw e;
    }
  }
  const live = hasPermission(role, "products.read") ? await runAction(listProducts, call, {}) : [];
  // Os produtos da oferta entram nos selects mesmo fora da lista (excluídos, ou quem não lê Produtos).
  const products: ProductOption[] = [
    ...live.map((p) => ({ id: p.id, name: p.name })),
    ...offerProducts.filter((p) => !live.some((l) => l.id === p.id)).map((p) => ({ id: p.id, name: p.name, deleted: p.deletedAt !== null })),
  ];
  const ident = await getPanelIdentity(panel);
  return (
    <div className={s.editorCol}>
      <OfferEditor
        key={offer?.id ?? "nova"}
        offer={offer}
        products={products}
        checkoutBase={storeBaseUrl(ident.store)}
        canWrite={hasPermission(role, "offers.write")}
        canPixel={hasPermission(role, "tracking.write")}
        cardAvailable={cardServiceConfigured(env)}
        created={!isNew && firstParam((await searchParams).criada) === "1"}
      />
    </div>
  );
}
