import { handleE2e } from "@/lib/e2e-seed";

export const dynamic = "force-dynamic";

// Rota SÓ do smoke E2E (configuração da loja sem as telas do painel). Ver src/lib/e2e-seed.ts: 404 fora do smoke.
export async function GET(req: Request, { params }: { params: Promise<{ op: string }> }): Promise<Response> {
  return handleE2e(req, (await params).op);
}

export async function POST(req: Request, { params }: { params: Promise<{ op: string }> }): Promise<Response> {
  return handleE2e(req, (await params).op);
}
