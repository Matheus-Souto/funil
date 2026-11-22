// Asaas falso para o smoke E2E: mesmo comportamento do fake dos testes unitários, atrás de HTTP.
// PORT define a porta. Endpoint só de teste: POST /__control/pay/:paymentId com { callbackUrl, token }
// marca a cobrança como RECEIVED e envia o webhook (header asaas-access-token) para callbackUrl.
// Também serve a API de Conversões do Meta falsa em /meta (o verify aponta META_GRAPH_BASE_URL para cá);
// GET /__control/meta devolve o token aceito e os eventos recebidos.
// Também serve o Resend falso em /resend (POST /resend/emails; o verify aponta RESEND_BASE_URL para cá) e a Bot API do
// Telegram falsa em /telegram (getMe e sendMessage; TELEGRAM_BASE_URL). GET /__control/resend e /__control/telegram
// devolvem o que chegou (o e-mail e a mensagem como o app mandou; nunca a chave nem o token).
// GET /__vendas?app=<origem do app>&slug=<oferta>: página de vendas "externa" (outra origem) com o t.js e um link.
import { createFakeAsaas } from "../../tests/fakes/asaas";
import { createFakeMeta } from "../../tests/fakes/meta";

const fake = createFakeAsaas({ apiKey: process.env.ASAAS_FAKE_API_KEY ?? "fake-asaas-key" });
const meta = createFakeMeta({ prefix: "/meta" });
const port = Number(process.env.PORT ?? 0);

type ResendMail = { from: string; to: string[]; subject: string; html: string; text: string; headers?: Record<string, string> };
const resendMails: ResendMail[] = [];
const telegramMessages: { chatId: string; text: string }[] = [];
const TELEGRAM_PATH = /^\/telegram\/bot(\d{5,12}:[A-Za-z0-9_-]{30,60})\/(getMe|sendMessage)$/;

/** Resend falso: aceita qualquer chave `re_…` no Authorization e guarda o e-mail. */
async function resend(req: Request): Promise<Response> {
  if (!/^Bearer re_\S+$/.test(req.headers.get("authorization") ?? "")) return Response.json({ name: "validation_error" }, { status: 401 });
  resendMails.push((await req.json()) as ResendMail);
  return Response.json({ id: `fake-resend-${resendMails.length}` });
}

/** Bot API falsa: qualquer token no formato do @BotFather; o bot se chama `loja_teste_bot`. */
async function telegram(req: Request, method: string): Promise<Response> {
  if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "loja_teste_bot" } });
  const body = (await req.json()) as { chat_id: string; text: string };
  telegramMessages.push({ chatId: String(body.chat_id), text: body.text });
  return Response.json({ ok: true, result: { message_id: telegramMessages.length } });
}

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
    if (url.pathname === "/__control/resend") return Response.json({ mails: resendMails });
    if (url.pathname === "/__control/telegram") return Response.json({ messages: telegramMessages });
    if (url.pathname === "/resend/emails" && req.method === "POST") return resend(req);
    const tg = TELEGRAM_PATH.exec(url.pathname);
    if (tg && req.method === "POST") return telegram(req, tg[2]!);
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
