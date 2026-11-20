import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { getPublicOffer } from "@/lib/catalog/offers";
import { env } from "@/lib/env";
import { getStoreBrandColor, resolveStore } from "@/lib/stores";
import { parseTouch } from "@/lib/tracking/touch";
import { BuyerShell } from "../../(design)/shell";
import { CheckoutForm } from "./checkout-form";
import { CheckoutPixel } from "./pixel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Finalizar compra", robots: { index: false } };

type Search = Record<string, string | string[] | undefined>;

/** URL relativa reconstruída dos parâmetros (o primeiro valor de cada um). */
function urlOf(slug: string, sp: Search): URL {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (typeof one === "string") q.set(k, one);
  }
  return new URL(`/c/${encodeURIComponent(slug)}?${q}`, "http://checkout.local");
}

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
  // Toque: `ft` (primeiro toque do t.js) + parâmetros desta URL; fbc/fbp dos cookies do Pixel (ou do fbclid).
  const { first, last, ref } = parseTouch(urlOf(slug, sp), { _fbc: jar.get("_fbc")?.value, _fbp: jar.get("_fbp")?.value });
  const touch = { first, last };
  const eventId = randomUUID();
  const wantsCard = sp.metodo === "cartao" && offer.methods.includes("card");
  const brandColor = await getStoreBrandColor(store.id);

  return (
    <BuyerShell storeName={store.name} brandColor={brandColor}>
      {offer.pixelId ? <CheckoutPixel pixelId={offer.pixelId} eventId={eventId} valueCents={offer.priceCents} /> : null}
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
        eventId={eventId}
        turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? null}
        cardFrame={
          env.CARD_ISOLATED && env.CARD_ORIGIN && offer.methods.includes("card")
            ? { origin: env.CARD_ORIGIN, src: `${env.CARD_ORIGIN}/form/${encodeURIComponent(store.id)}` }
            : null
        }
      />
    </BuyerShell>
  );
}
