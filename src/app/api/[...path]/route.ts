// Rota de API inexistente: 404 sem corpo e sem ler a requisição (em vez da página de "não encontrado" do Next, que
// traz HTML com nomes de arquivo do build). Vale para a rota antiga do cartão, que saiu do app: uma aba aberta antes
// da atualização que ainda mande o cartão para ela recebe só o 404 (o Caddy já corta essa rota antes do app).
// As rotas reais de /api têm prioridade sobre esta.
export const dynamic = "force-dynamic";

const notFound = (): Response => new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
