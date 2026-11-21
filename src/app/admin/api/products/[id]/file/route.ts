import { ActionError, runAction } from "@/lib/actions/core";
import { requirePanelActor } from "@/lib/auth/session";
import { readProductFile } from "@/lib/catalog/products";
import { contentDisposition } from "@/lib/delivery/download";
import { UPLOAD_ERROR_STATUS } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * GET /admin/api/products/<id>/file: o PDF original de um produto para o "Ver PDF" do painel (desenhado pelo pdf.js).
 * Sessão do painel + ação `products.file` (products.write: dono e admin, com auditoria). Sempre como anexo; a CSP com
 * `sandbox` que chega ao navegador vem do next.config.ts (regra própria desta rota: a da rota abaixo não substitui a de
 * /admin), e o teste E2E confere o cabeçalho real.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  // Sessão antes de tudo (nem os parâmetros são lidos sem login).
  const panel = await requirePanelActor();
  const { id } = await ctx.params;
  try {
    const out = await runAction(readProductFile, { ...panel, origin: "panel" }, { id });
    return new Response(out.bytes as unknown as BodyInit, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": contentDisposition(out.fileName),
        "content-length": String(out.bytes.length),
        "cache-control": "private, no-store",
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ActionError) return new Response(e.message, { status: UPLOAD_ERROR_STATUS[e.code] });
    throw e;
  }
}
