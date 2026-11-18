import { handleAsaasWebhook } from "@/lib/payments/asaas/webhook";

export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lê o corpo com teto de bytes; `null` se passar do limite. */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: Request, ctx: { params: Promise<{ storeId: string }> }): Promise<Response> {
  const { storeId } = await ctx.params;
  if (!UUID.test(storeId)) return new Response(null, { status: 404 });
  const text = await readCapped(req);
  if (text === null) return new Response(null, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const { status } = await handleAsaasWebhook(storeId, req.headers, json);
  return new Response(null, { status });
}
