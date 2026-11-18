import { handleOrderStatus } from "@/lib/checkout";

export const dynamic = "force-dynamic";

/** Status do pedido para o polling da página /o/[publicId]. Ver src/lib/checkout.ts. */
export async function GET(req: Request, { params }: { params: Promise<{ publicId: string }> }): Promise<Response> {
  const { publicId } = await params;
  return handleOrderStatus(req, publicId);
}
