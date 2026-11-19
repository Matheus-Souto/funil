"use server";

// Server actions do checkout público. Só montam a entrada (IP, user agent e cookies do Meta vêm do servidor, nunca do
// navegador) e chamam `startCheckout` / `checkout.view`; a regra de negócio fica em src/lib/checkout.ts.
import { cookies, headers } from "next/headers";
import { ActionError, runAction } from "@/lib/actions/core";
import { NEEDS_CPF, checkoutView, startCheckout } from "@/lib/checkout";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { clientIpFrom } from "@/lib/payments/asaas/card-http";
import { resolveStore } from "@/lib/stores";
import { fbcFromFbclid } from "@/lib/tracking/touch";

export type StartResult =
  | { ok: true; publicId: string; method: "pix_manual" | "pix_asaas" | "card_asaas" }
  | { ok: false; message: string; fields?: Record<string, string>; needsCpf?: boolean };

const GENERIC = "Não foi possível continuar agora. Tente de novo em instantes.";
const NEEDS_CPF_MESSAGE = "O Pix direto da loja está indisponível agora. Informe o CPF para gerar o Pix automático.";

function fieldsOf(details: unknown): Record<string, string> | undefined {
  if (!Array.isArray(details)) return undefined;
  const out: Record<string, string> = {};
  for (const d of details as { path?: unknown; message?: unknown }[]) {
    if (!Array.isArray(d.path)) continue;
    const key = d.path.map(String).join(".");
    out[key] ??= typeof d.message === "string" ? d.message : "Confira este campo";
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sem cookie `_fbc`: deriva do `fbclid` do toque (`fb.1.<ms>.<fbclid>`), como o Pixel faria. */
function fbcFromClick(touch: unknown): string | undefined {
  const fbclid = (touch as { last?: { fbclid?: unknown } } | null)?.last?.fbclid;
  return typeof fbclid === "string" ? fbcFromFbclid(fbclid) : undefined;
}

export async function startCheckoutAction(input: unknown): Promise<StartResult> {
  const h = await headers();
  const store = await resolveStore(h.get("host") ?? "");
  if (!store) return { ok: false, message: "Loja não encontrada" };
  const jar = await cookies();
  const body = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const raw = {
    ...body,
    clientIp: clientIpFrom(h, env.TRUST_PROXY),
    userAgent: (h.get("user-agent") ?? "").slice(0, 500),
    fbc: jar.get("_fbc")?.value?.slice(0, 500) ?? fbcFromClick(body.touch),
    fbp: jar.get("_fbp")?.value?.slice(0, 500),
  };
  try {
    const r = await startCheckout({ storeId: store.id }, raw);
    return { ok: true, publicId: r.publicId, method: r.method };
  } catch (e) {
    if (e instanceof ActionError) {
      if (e.code === "conflict" && e.message === NEEDS_CPF) return { ok: false, needsCpf: true, message: NEEDS_CPF_MESSAGE };
      if (e.code === "invalid_input") return { ok: false, message: e.message === "Entrada inválida" ? "Confira os campos marcados." : e.message, fields: fieldsOf(e.details) };
      if (e.code === "provider_error") return { ok: false, message: GENERIC };
      return { ok: false, message: e.message };
    }
    log.error("checkout: erro inesperado ao criar o pedido", { error: e });
    return { ok: false, message: GENERIC };
  }
}

/** Visita ao checkout (conversão). Melhor esforço: nunca atrapalha o comprador. */
export async function recordCheckoutViewAction(input: unknown): Promise<void> {
  const h = await headers();
  const store = await resolveStore(h.get("host") ?? "");
  if (!store) return;
  const body = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  try {
    // O IP vem do servidor (limite de 30 visitas por IP por hora em cada oferta).
    await runAction(checkoutView, { storeId: store.id, actor: { kind: "public" }, origin: "public" }, { ...body, clientIp: clientIpFrom(h, env.TRUST_PROXY) });
  } catch {
    /* oferta inativa ou entrada inválida: sem registro */
  }
}
