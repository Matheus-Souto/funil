import { ActionError, runAction } from "@/lib/actions/core";
import { requirePanelActor } from "@/lib/auth/session";
import { exportOrders, ordersCsv } from "@/lib/orders/panel";

export const dynamic = "force-dynamic";

/** GET /admin/orders.csv: planilha dos pedidos com os filtros da lista (orders.export). Sem CPF. */
export async function GET(req: Request): Promise<Response> {
  const panel = await requirePanelActor();
  const p = new URL(req.url).searchParams;
  const input = {
    ...(p.get("status") ? { status: p.get("status") } : {}),
    ...(p.get("method") ? { method: p.get("method") } : {}),
    ...(p.get("q") ? { q: p.get("q") } : {}),
  };
  try {
    const rows = await runAction(exportOrders, { ...panel, origin: "panel" }, input);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    // BOM: o Excel abre o UTF-8 com acentos certos.
    return new Response(`﻿${ordersCsv(rows)}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pedidos-${day}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof ActionError) {
      return new Response(e.code === "forbidden" ? "Seu papel na loja não permite exportar pedidos." : e.message, {
        status: e.code === "forbidden" ? 403 : 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw e;
  }
}
