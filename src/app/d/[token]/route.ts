import { handleDownload } from "@/lib/delivery/download";

export const dynamic = "force-dynamic";

/** Link pessoal de download (e-mail de entrega). Só faz o parse HTTP; ver src/lib/delivery/download.ts. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  return handleDownload(req, (await params).token);
}
