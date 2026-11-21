// Borda HTTP do upload do PDF (POST /admin/api/products/upload): sessão do painel, permissão, corpo em streaming com
// teto de 50 MB e a ação `products.create`. Nenhuma regra de negócio aqui (a validação do PDF vive em products.ts).
//
// Contrato: corpo = bytes do PDF (Content-Type: application/pdf); metadados na query (`name`, `fileName`).
// O Content-Type application/pdf também barra POST cross-site por formulário (que não consegue enviá-lo).
import { runAction, ActionError } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { requirePanelActor, type PanelActor } from "@/lib/auth/session";
import { readBytesCapped, UPLOAD_ERROR_STATUS } from "@/lib/http";
import { createProduct, MAX_PDF_BYTES } from "./products";

const json = (status: number, body: unknown) => Response.json(body, { status });

export async function handleProductUpload(req: Request, opts: { actor?: () => Promise<PanelActor> } = {}): Promise<Response> {
  // Antes de ler qualquer byte do corpo: sessão (redireciona para /admin/login) e permissão.
  const { storeId, actor } = await (opts.actor ?? requirePanelActor)();
  if (!hasPermission(actor.role, "products.write")) return json(403, { error: "Sem permissão para enviar produtos." });
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/pdf")) {
    return json(415, { error: "Envie o PDF com Content-Type application/pdf." });
  }
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "";
  const fileName = url.searchParams.get("fileName") ?? "";
  if (!name.trim() || !fileName.trim()) return json(400, { error: "Informe o nome do produto e o nome do arquivo." });

  const file = await readBytesCapped(req, MAX_PDF_BYTES);
  if (file === null) return json(413, { error: "O PDF passa de 50 MB." });
  try {
    const out = await runAction(createProduct, { storeId, actor, origin: "panel" }, { name, fileName, file });
    return json(200, out);
  } catch (e) {
    if (e instanceof ActionError) return json(UPLOAD_ERROR_STATUS[e.code], { error: e.message });
    throw e;
  }
}
