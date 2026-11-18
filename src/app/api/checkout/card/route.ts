import { handleCardCheckout } from "@/lib/payments/asaas/card-http";

export const dynamic = "force-dynamic";

/** Pagamento com cartão (Asaas) digitado no checkout. Ver src/lib/payments/asaas/card-http.ts. */
export async function POST(req: Request): Promise<Response> {
  return handleCardCheckout(req);
}
