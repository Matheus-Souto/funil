import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { getPublicOffer } from "@/lib/catalog/offers";
import { touchFromSearch } from "@/lib/checkout";
import { env } from "@/lib/env";
import { getStoreBrandColor, resolveStore } from "@/lib/stores";
import { BuyerShell } from "../../(design)/shell";
import { CheckoutForm } from "./checkout-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Finalizar compra", robots: { index: false } };

type Search = Record<string, string | string[] | undefined>;

/** Checkout público de uma oferta. Só resolve a loja e a oferta; a regra de negócio fica em `checkout.start`. */
export default async function CheckoutPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const store = await resolveStore((await headers()).get("host") ?? "");
  if (!store) notFound();
  let offer: Awaited<ReturnType<typeof getPublicOffer.run>>;
  try {
    offer = await runAction(getPublicOffer, { storeId: store.id, actor: { kind: "public" }, origin: "public" }, { slug });
  } catch (e) {
    if (e instanceof ActionError && (e.code === "not_found" || e.code === "invalid_input")) notFound();
    throw e;
  }
  const jar = await cookies();
  const { touch, ref } = touchFromSearch(sp, { fbc: jar.get("_fbc")?.value, fbp: jar.get("_fbp")?.value });
  const wantsCard = sp.metodo === "cartao" && offer.methods.includes("card");
  const brandColor = await getStoreBrandColor(store.id);

  return (
    <BuyerShell storeName={store.name} brandColor={brandColor}>
      <CheckoutForm
        storeName={store.name}
        offer={{
          slug: offer.slug,
          name: offer.name,
          productName: offer.productName,
          priceCents: offer.priceCents,
          methods: offer.methods as ("pix" | "card")[],
          pixMode: offer.pixMode as "manual" | "asaas",
          maxInstallments: offer.maxInstallments,
          bump: offer.bump,
        }}
        initialMethod={wantsCard ? "card" : offer.methods.includes("pix") ? "pix" : "card"}
        touch={touch}
        refCode={ref}
        eventId={randomUUID()}
        turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? null}
      />
    </BuyerShell>
  );
}
