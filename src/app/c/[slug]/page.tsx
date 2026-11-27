import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { checkoutOffer } from "@/lib/catalog/checkout-offer";
import { getPublicOffer } from "@/lib/catalog/offers";
import { checkoutMethods } from "@/lib/checkout";
import { clientIpFrom } from "@/lib/client-ip";
import { cardServiceConfigured, env } from "@/lib/env";
import { getStoreBrandColor, resolveStore } from "@/lib/stores";
import { parseTouch } from "@/lib/tracking/touch";
import { BuyerShell } from "../../(design)/shell";
import { appGate } from "./app-gate";
import { AppSessionBlocked, CheckoutForm } from "./checkout-form";
import { initialCoupon } from "./initial-coupon";
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

const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Checkout público de uma oferta. Só resolve a loja e a oferta; a regra de negócio fica em `checkout.start`. */
export default async function CheckoutPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const h = await headers();
  const store = await resolveStore(h.get("host") ?? "");
  if (!store) notFound();
  let offer: Awaited<ReturnType<typeof getPublicOffer.run>>;
  try {
    offer = await runAction(getPublicOffer, { storeId: store.id, actor: { kind: "public" }, origin: "public" }, { slug });
  } catch (e) {
    if (e instanceof ActionError && (e.code === "not_found" || e.code === "invalid_input")) notFound();
    throw e;
  }
  const brandColor = await getStoreBrandColor(store.id);
  // `?s=` decide a tela antes de qualquer formulário ou analytics (app-gate.ts).
  const app = await appGate(store.id, slug, offer.delivery, firstParam(sp.s));
  if (app && "blocked" in app) {
    return (
      <BuyerShell storeName={store.name} brandColor={brandColor}>
        <AppSessionBlocked offerName={offer.name} message={app.blocked} />
      </BuyerShell>
    );
  }
  const appSession = app?.session ?? null;
  const jar = await cookies();
  // Toque: `ft` (primeiro toque do t.js) + parâmetros desta URL; fbc/fbp dos cookies do Pixel (ou do fbclid).
  const { first, last, ref } = parseTouch(urlOf(slug, sp), { _fbc: jar.get("_fbc")?.value, _fbp: jar.get("_fbp")?.value });
  const touch = { first, last };
  const eventId = randomUUID();
  // Chave do contato desta visita (só com a captura ligada): é ela que dá direito de alterar ou apagar a linha.
  // Pelo app não há captura: o comprador já é conhecido pela sessão.
  const lead = offer.leadCapture && !appSession ? { key: randomUUID(), privacyEmail: offer.leadCapture.privacyEmail } : null;
  // Sem o serviço de cartão configurado, só Pix (oferta só de cartão: o checkout mostra o cartão indisponível).
  const cardOrigin = cardServiceConfigured(env) ? env.CARD_ORIGIN : null;
  const methods = checkoutMethods(offer.methods, cardOrigin !== null);
  if (methods.length === 0) notFound();
  const wantsCard = sp.metodo === "cartao" && methods.includes("card");
  // `?cupom=`: prévia no servidor (uma vez por carregamento); cupom ruim só abre o campo com a mensagem neutra. Pelo app
  // não há cupom (o preço é o da oferta).
  const coupon = appSession ? null : await initialCoupon(store.id, slug, sp.cupom, clientIpFrom(h, env.TRUST_PROXY));

  return (
    <BuyerShell storeName={store.name} brandColor={brandColor}>
      {/* InitiateCheckout do navegador: o valor que a pessoa vai pagar (com o cupom do `?cupom=` já aplicado). Pelo app,
          sem Pixel na página: ele manda a URL inteira ao Meta, e o `?s=` dá acesso ao nome e ao e-mail da sessão. O
          InitiateCheckout sai do servidor quando o pedido é criado. */}
      {offer.pixelId && !appSession ? <CheckoutPixel pixelId={offer.pixelId} eventId={eventId} valueCents={coupon?.kind === "applied" ? coupon.totalCents : offer.priceCents} /> : null}
      <CheckoutForm
        storeName={store.name}
        offer={checkoutOffer(offer, methods)}
        initialMethod={wantsCard ? "card" : methods.includes("pix") ? "pix" : "card"}
        touch={touch}
        initialCoupon={coupon}
        refCode={ref}
        eventId={eventId}
        lead={lead}
        appSession={appSession}
        turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? null}
        brandColor={brandColor}
        cardFrame={
          cardOrigin !== null && methods.includes("card")
            ? { origin: cardOrigin, src: `${cardOrigin}/form/${encodeURIComponent(store.id)}` }
            : null
        }
      />
    </BuyerShell>
  );
}
