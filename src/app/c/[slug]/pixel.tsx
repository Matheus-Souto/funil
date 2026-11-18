"use client";

// Meta Pixel do checkout: PageView + InitiateCheckout com o MESMO `eventId` enviado em `checkout.start` (o servidor
// manda o InitiateCheckout pela API de Conversões com esse id quando o pedido é criado; o Meta deduplica).
// Sem Pixel configurado (oferta ou loja), não carrega nada de terceiros.
import { useEffect } from "react";
import { initPixel, trackPixel } from "@/lib/tracking/fbq";

export function CheckoutPixel({ pixelId, eventId, valueCents }: { pixelId: string | null; eventId: string; valueCents: number }) {
  useEffect(() => {
    if (!initPixel(pixelId)) return;
    trackPixel("InitiateCheckout", { currency: "BRL", value: valueCents / 100 }, eventId);
  }, [pixelId, eventId, valueCents]);
  return null;
}
