import { handleUnsubscribePage, handleUnsubscribePost } from "@/lib/recovery/unsubscribe";

export const dynamic = "force-dynamic";

// Descadastro dos lembretes de recuperação de venda (link do e-mail e `List-Unsubscribe`). Só faz o parse HTTP; ver
// src/lib/recovery/unsubscribe.ts. GET mostra o botão sem gravar nada; POST (o botão ou o um clique do RFC 8058)
// descadastra.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  return handleUnsubscribePage(req, (await params).token);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  return handleUnsubscribePost(req, (await params).token);
}
