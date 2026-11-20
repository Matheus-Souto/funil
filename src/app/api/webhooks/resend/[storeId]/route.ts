import { handleResendWebhook } from "@/lib/delivery/resend-webhook";
import { readCapped } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, ctx: { params: Promise<{ storeId: string }> }): Promise<Response> {
  const { storeId } = await ctx.params;
  if (!UUID.test(storeId)) return new Response(null, { status: 404 });
  const text = await readCapped(req, MAX_BODY);
  if (text === null) return new Response(null, { status: 413 });
  const { status } = await handleResendWebhook(storeId, req.headers, text);
  return new Response(null, { status });
}
