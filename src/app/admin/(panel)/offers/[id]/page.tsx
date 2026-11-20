import { notFound } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { getPanelIdentity, requirePanelActor } from "@/lib/auth/session";
import { getOffer } from "@/lib/catalog/offers";
import { listProducts } from "@/lib/catalog/products";
import { storeBaseUrl } from "@/lib/delivery/links";
import { cardServiceConfigured, env } from "@/lib/env";
import { firstParam } from "@/lib/panel-params";
import { OfferEditor, type OfferData } from "./editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Oferta" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /admin/offers/nova cria; /admin/offers/<id> edita (ou só mostra, para quem não tem offers.write). */
export default async function OfferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ criada?: string | string[] }> }) {
  const panel = await requirePanelActor();
  const call = { ...panel, origin: "panel" as const };
  const role = panel.actor.role;
  const { id } = await params;
  const isNew = id === "nova";
  if (!isNew && !UUID.test(id)) notFound();
  if (isNew && !hasPermission(role, "offers.write")) notFound();

  let offer: OfferData | null = null;
  if (!isNew) {
    try {
      const o = await runAction(getOffer, call, { id });
      offer = {
        id: o.id,
        slug: o.slug,
        name: o.name,
        productId: o.productId,
        priceCents: o.priceCents,
        methods: o.methods,
        pixMode: o.pixMode as "manual" | "asaas",
        maxInstallments: o.maxInstallments,
        bumpProductId: o.bumpProductId,
        bumpPriceCents: o.bumpPriceCents,
        bumpLabel: o.bumpLabel,
        thankYouText: o.thankYouText,
        pixelId: o.pixelId,
        active: o.active,
      };
    } catch (e) {
      if (e instanceof ActionError && e.code === "not_found") notFound();
      throw e;
    }
  }
  const products = hasPermission(role, "products.read") ? await runAction(listProducts, call, {}) : [];
  const ident = await getPanelIdentity(panel);
  return (
    <OfferEditor
      key={offer?.id ?? "nova"}
      offer={offer}
      products={products.map((p) => ({ id: p.id, name: p.name }))}
      checkoutBase={storeBaseUrl(ident.store)}
      storeName={ident.storeName}
      brandColor={ident.store.brandColor}
      canWrite={hasPermission(role, "offers.write")}
      canPixel={hasPermission(role, "tracking.write")}
      cardAvailable={cardServiceConfigured(env)}
      created={!isNew && firstParam((await searchParams).criada) === "1"}
    />
  );
}
