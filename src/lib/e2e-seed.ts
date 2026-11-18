// SÓ PARA O SMOKE E2E (scripts/verify.sh): o painel ainda não tem telas de oferta, conexões e liberação (Task 14),
// então o smoke configura a loja por aqui. Desligado (404) a menos que ASAAS_BASE_URL aponte para loopback — o env
// só aceita essa variável em produção com loopback (Asaas falso do smoke), então uma instalação real nunca a tem.
// Mesmo ligado, exige a sessão do DONO no painel e passa por `runAction` (mesmas permissões e auditoria do painel):
// não faz nada que o dono não possa fazer.
import { eq } from "drizzle-orm";
import { ActionError, runAction, type Action } from "@/lib/actions/core";
import { getPanelActor, type PanelActor } from "@/lib/auth/session";
import { createOffer } from "@/lib/catalog/offers";
import { withStore } from "@/lib/db/client";
import { orders } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { releaseOrder, savePixManual } from "@/lib/payments/manual";

const ACTIONS: Record<string, Action<unknown, unknown>> = {
  "offers.create": createOffer as Action<unknown, unknown>,
  "connections.savePixManual": savePixManual as Action<unknown, unknown>,
  "connections.saveAsaas": saveAsaas as Action<unknown, unknown>,
};

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const h = new URL(value).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  } catch {
    return false;
  }
}

export function e2eRoutesEnabled(asaasBaseUrl: string | undefined = env.ASAAS_BASE_URL): boolean {
  return isLoopbackUrl(asaasBaseUrl);
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleE2e(
  req: Request,
  op: string,
  opts: { enabled?: boolean; actor?: () => Promise<PanelActor | null> } = {},
): Promise<Response> {
  if (!(opts.enabled ?? e2eRoutesEnabled())) return json(404, { error: "not_found" });
  const panel = await (opts.actor ?? getPanelActor)();
  if (!panel || panel.actor.role !== "owner") return json(401, { error: "unauthorized" });
  if (req.method === "GET" && op === "asaas") return json(200, { baseUrl: env.ASAAS_BASE_URL });
  if (req.method !== "POST" || (req.headers.get("content-type") ?? "").split(";")[0] !== "application/json") {
    return json(400, { error: "invalid_request" });
  }
  const body = (await req.json().catch(() => null)) as { action?: string; input?: unknown; publicId?: string } | null;
  const call = { storeId: panel.storeId, actor: panel.actor, origin: "panel" as const };
  try {
    if (op === "action" && body?.action && ACTIONS[body.action]) {
      return json(200, await runAction(ACTIONS[body.action]!, call, body.input));
    }
    if (op === "release" && typeof body?.publicId === "string") {
      const publicId = body.publicId;
      const [o] = await withStore(panel.storeId, (tx) => tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId)));
      if (!o) return json(404, { error: "not_found" });
      return json(200, await runAction(releaseOrder, call, { orderId: o.id }));
    }
  } catch (e) {
    if (e instanceof ActionError) return json(400, { error: e.code, message: e.message });
    throw e;
  }
  return json(404, { error: "not_found" });
}
