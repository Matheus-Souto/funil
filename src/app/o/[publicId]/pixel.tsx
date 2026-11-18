"use client";

// Meta Pixel da página de obrigado: `Purchase` com `eventID: "purchase:<publicId>"` (o mesmo id que o servidor manda
// pela API de Conversões; nunca o id interno do pedido), uma vez por navegador (sessionStorage) por pedido.
// Só é montado com o pedido pago e Pixel configurado.
import { useEffect } from "react";
import { initPixel, trackPixel } from "@/lib/tracking/fbq";

export const purchaseStorageKey = (publicId: string) => `funil_purchase:${publicId}`;

export function PurchasePixel({ pixelId, publicId, valueCents }: { pixelId: string | null; publicId: string; valueCents: number }) {
  useEffect(() => {
    if (!initPixel(pixelId)) return;
    const key = purchaseStorageKey(publicId);
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* sem sessionStorage: dispara assim mesmo (o Meta deduplica pelo eventID) */
    }
    trackPixel("Purchase", { currency: "BRL", value: valueCents / 100 }, `purchase:${publicId}`);
  }, [pixelId, publicId, valueCents]);
  return null;
}
