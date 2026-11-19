import { dbHealthy } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Saúde do app: responde 503 se o papel `app` não consegue falar com o banco (`select 1`, com tempo-limite curto). */
export async function GET(): Promise<Response> {
  const ok = await dbHealthy();
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
