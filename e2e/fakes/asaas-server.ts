// Asaas falso para o smoke E2E: mesmo comportamento do fake dos testes unitários, atrás de HTTP.
// PORT define a porta. Endpoint só de teste: POST /__control/pay/:paymentId com { callbackUrl, token }
// marca a cobrança como RECEIVED e envia o webhook (header asaas-access-token) para callbackUrl.
// Também serve a API de Conversões do Meta falsa em /meta (o verify aponta META_GRAPH_BASE_URL para cá);
// GET /__control/meta devolve o token aceito e os eventos recebidos.
// GET /__vendas?app=<origem do app>&slug=<oferta>: página de vendas "externa" (outra origem) com o t.js e um link.
import { createFakeAsaas } from "../../tests/fakes/asaas";
import { createFakeMeta } from "../../tests/fakes/meta";

const fake = createFakeAsaas({ apiKey: process.env.ASAAS_FAKE_API_KEY ?? "fake-asaas-key" });
const meta = createFakeMeta({ prefix: "/meta" });
const port = Number(process.env.PORT ?? 0);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const control = /^\/__control\/pay\/([^/]+)$/.exec(url.pathname);
    if (control && req.method === "POST") {
      const id = decodeURIComponent(control[1]!);
      const { callbackUrl, token } = (await req.json()) as { callbackUrl: string; token: string };
      fake.setStatus(id, "RECEIVED");
      const payment = fake.payments.get(id)!;
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "asaas-access-token": token },
        body: JSON.stringify({ event: "PAYMENT_RECEIVED", payment: { id, status: "RECEIVED", value: payment.value } }),
      });
      return Response.json({ webhookStatus: res.status });
    }
    if (url.pathname === "/__control/key") return Response.json({ apiKey: fake.apiKey });
    if (url.pathname === "/__control/meta") return Response.json({ token: meta.token, events: meta.events });
    if (url.pathname.startsWith("/meta/")) return meta.fetch(req);
    if (url.pathname === "/__vendas") {
      const app = url.searchParams.get("app") ?? "";
      const slug = url.searchParams.get("slug") ?? "";
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(app) || !/^[a-z0-9-]+$/.test(slug)) return new Response("bad", { status: 400 });
      const host = new URL(app).host;
      const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vendas</title></head><body>
<h1>Maná bíblico</h1><a id="comprar" href="${app}/c/${slug}">Quero comprar</a>
<script src="${app}/t.js" data-checkout="${host}" defer></script></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return fake.fetch(req);
  },
});

console.log(`asaas-fake ready on ${server.port}`);
