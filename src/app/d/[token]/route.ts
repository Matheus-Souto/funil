import { handleDownloadHead, handleDownloadPage, handleDownloadPost } from "@/lib/delivery/download";

export const dynamic = "force-dynamic";

// Link pessoal de download (e-mail de entrega). Só faz o parse HTTP; ver src/lib/delivery/download.ts.
// GET mostra o botão sem contar; POST (o botão) conta e baixa; HEAD explícito (o Next derivaria do GET) não faz nada.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  return handleDownloadPage(req, (await params).token);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  return handleDownloadPost(req, (await params).token);
}

export function HEAD(): Response {
  return handleDownloadHead();
}
