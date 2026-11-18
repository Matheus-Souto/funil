// SÓ PARA O SMOKE E2E (scripts/verify.sh): o painel ainda não tem telas de oferta, conexões e liberação (Task 14),
// então o smoke configura a loja por aqui. Desligada (404) a menos que E2E_SEED_ROUTES=1, variável que o env só
// aceita com BASE_URL em loopback: uma instalação acessível de fora nunca a liga.
// Mesmo ligado, exige a sessão do DONO no painel e passa por `runAction` (mesmas permissões e auditoria do painel):
// não faz nada que o dono não possa fazer.
import { eq } from "drizzle-orm";
import { ActionError, runAction, type Action } from "@/lib/actions/core";
import { getPanelActor, type PanelActor } from "@/lib/auth/session";
import { createOffer } from "@/lib/catalog/offers";
import { saveSmtp } from "@/lib/delivery/mailer";
import { withStore } from "@/lib/db/client";
import { orders } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { releaseOrder, savePixManual } from "@/lib/payments/manual";
import { refundOrder } from "@/lib/payments/refund";
import { saveMeta } from "@/lib/tracking/meta";

const ACTIONS: Record<string, Action<unknown, unknown>> = {
  "offers.create": createOffer as Action<unknown, unknown>,
  "connections.savePixManual": savePixManual as Action<unknown, unknown>,
  "connections.saveAsaas": saveAsaas as Action<unknown, unknown>,
  "connections.saveSmtp": saveSmtp as Action<unknown, unknown>,
  "connections.saveMeta": saveMeta as Action<unknown, unknown>,
};

/** Operações por `publicId` (o smoke só conhece o id público do pedido): liberar o Pix manual e reembolsar. */
const BY_PUBLIC_ID: Record<string, Action<unknown, unknown>> = {
  release: releaseOrder as Action<unknown, unknown>,
  refund: refundOrder as Action<unknown, unknown>,
};

/** Ligada só com E2E_SEED_ROUTES=1 (o env recusa essa variável fora de BASE_URL em loopback). */
export function e2eRoutesEnabled(e: Pick<typeof env, "E2E_SEED_ROUTES" | "ASAAS_BASE_URL"> = env): boolean {
  return e.E2E_SEED_ROUTES === "1";
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
    if (op === "action" && body?.action && Object.hasOwn(ACTIONS, body.action)) {
      return json(200, await runAction(ACTIONS[body.action]!, call, body.input));
    }
    if (op === "attribution" && typeof body?.publicId === "string") {
      // Origem gravada no pedido (UTM, indicação): o smoke confere o t.js de ponta a ponta. Só leitura.
      const publicId = body.publicId;
      const [o] = await withStore(panel.storeId, (tx) =>
        tx.select({ firstTouch: orders.firstTouch, lastTouch: orders.lastTouch, ref: orders.ref }).from(orders).where(eq(orders.publicId, publicId)),
      );
      return o ? json(200, o) : json(404, { error: "not_found" });
    }
    const byPublicId = Object.hasOwn(BY_PUBLIC_ID, op) ? BY_PUBLIC_ID[op] : undefined;
    if (byPublicId && typeof body?.publicId === "string") {
      const publicId = body.publicId;
      const [o] = await withStore(panel.storeId, (tx) => tx.select({ id: orders.id }).from(orders).where(eq(orders.publicId, publicId)));
      if (!o) return json(404, { error: "not_found" });
      return json(200, await runAction(byPublicId, call, { orderId: o.id }));
    }
  } catch (e) {
    if (e instanceof ActionError) return json(400, { error: e.code, message: e.message });
    throw e;
  }
  return json(404, { error: "not_found" });
}
