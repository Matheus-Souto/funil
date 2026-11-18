"use server";

// "Gerar novo código Pix" (POST): só chama a ação `orders.regeneratePix` e volta para a página do pedido.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ActionError, runAction } from "@/lib/actions/core";
import { regenerateOrderPix } from "@/lib/checkout";
import { resolveStore } from "@/lib/stores";

export async function regeneratePixAction(publicId: string): Promise<void> {
  const store = await resolveStore((await headers()).get("host") ?? "");
  const back = `/o/${encodeURIComponent(publicId)}`;
  if (!store) redirect(back);
  let query = "";
  try {
    await runAction(regenerateOrderPix, { storeId: store.id, actor: { kind: "public" }, origin: "public" }, { publicId });
  } catch (e) {
    query = e instanceof ActionError && e.code === "rate_limited" ? "?pix=limite" : "?pix=erro";
  }
  redirect(`${back}${query}`);
}
