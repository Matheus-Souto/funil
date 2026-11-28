// App integrado seguindo docs/integracao-apps.md (roteiro mínimo da seção 9), contra um app falso em loopback
// (e2e/support/fake-app.ts) e o Asaas falso: painel (Conexões → App (integração)), POST /testes, POST /pagamentos,
// checkout com `?s=` e Pix do Asaas, aviso assinado com `sequencia`, reenvio idempotente, reembolso e uma liberação por
// sessão. A instância multi é própria deste arquivo (e2e/support/multi-app.ts), com APP_WEBHOOK_ALLOW_LOOPBACK=1.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { FakeApp, sign, verifySignature, type Notice } from "./support/fake-app";
import { RUN_DIR, hostResolverArgs, startMultiApp, type HostResponse, type MultiApp } from "./support/multi-app";
import { DESKTOP, codeOf, firstLogin, seedAction } from "./support/panel";

// Sem trace nem captura de tela neste arquivo: o cenário de cartão digita número e CVV de teste, e a pasta da rodada vira
// artefato do CI (a config global retém trace e captura em falha).
test.use({ launchOptions: { args: hostResolverArgs() }, trace: "off", screenshot: "off" });

const stamp = Date.now();
const STORE = { name: "Loja de Assinaturas", slug: "loja-assinaturas", email: `dono.${stamp}@example.test`, password: "senha-do-app-123" };
const HOST = `${STORE.slug}.localhost`;
const OFFER = { slug: "start-anual", name: "Plano Start anual", appCode: "start_anual", priceCents: 19900, price: "R$ 199,00" };
/** Oferta de app com Pix e cartão (o cartão passa pelo serviço de cartão isolado desta instância). */
const OFFER_CARD = { slug: "creditos-50", name: "50 créditos", appCode: "creditos_50", priceCents: 4990, price: "R$ 49,90" };
/** Cartão e CVV da lista do verify (E2E_CARDS/E2E_CVVS): aprovado pelo Asaas falso. */
const CARD = { number: "4111 1111 1111 1111", holder: "PESSOA E SILVA", expiry: "12/34", cvv: "582" };
const RETURN_HOST = "app.exemplo.com.br";
const RETORNO = `https://${RETURN_HOST}/assinatura/obrigado`;
const PIXEL_ID = "1234567890123";
const BUYER = { nome: "Pessoa Exemplo da Silva", email: `pessoa.${stamp}@exemplo.com`, telefone: "11987654321", cpf: "52998224725" };
const SECOND_CPF = "11144477735";
const conta = (tag: string) => `conta-${tag}-${stamp}`;

let multi: MultiApp;
let owner: Page;
const app = new FakeApp();
let apiKey = "";
let asaasWebhook = { url: "", token: "" };
let paidPublicId = "";

/** Nada de terceiros: o fbevents.js do Meta vira um script vazio (mesma interceptação do smoke), em todo contexto. */
async function blockMeta(context: BrowserContext) {
  await context.route(/^https:\/\/(connect|www)\.facebook\.(net|com)\//, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
}

/**
 * Varre um log da instância com as mesmas regras do `logs_no_card` do scripts/verify.sh (número com ou sem espaços; CVV
 * como valor de cvv/ccv/cvc ou sozinho entre aspas/espaços; a chave ccv/cvv). Devolve só booleanos: o relatório de falha
 * não repete o trecho do log.
 */
function cardInLog(text: string): { number: boolean; cvv: boolean; cvvKey: boolean } {
  const n = CARD.number.replace(/ /g, "");
  const number = new RegExp(`${n.slice(0, 4)} ?${n.slice(4, 8)} ?${n.slice(8, 12)} ?${n.slice(12, 16)}`).test(text);
  const cvv = new RegExp(`(c[cv]v|cvc)["' :=]*${CARD.cvv}([^0-9]|$)|(^|["' ])${CARD.cvv}(["' ]|$)`, "im").test(text);
  const cvvKey = /"(ccv|cvv)"/i.test(text);
  return { number, cvv, cvvKey };
}

/** Chamada do servidor do app à API de integração (Bearer, JSON), no host da loja. */
async function api(path: "testes" | "pagamentos", body: unknown, key = apiKey): Promise<{ status: number; json: Record<string, unknown> | null; raw: HostResponse }> {
  const raw = await multi.hostRequest(HOST, `/api/integracao/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: raw.status, json: raw.text ? (JSON.parse(raw.text) as Record<string, unknown>) : null, raw };
}

/** Pix do Asaas falso: o código termina no id da cobrança; o controle a marca paga e manda o webhook do Asaas ao funil. */
async function payPix(page: Page): Promise<string> {
  const code = (await page.getByTestId("pix-code").textContent())!.trim();
  expect(code.startsWith("00020126fake")).toBe(true);
  const paymentId = code.replace(/^00020126fake/, "");
  const r = await fetch(`${multi.asaasBase}/__control/pay/${paymentId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callbackUrl: asaasWebhook.url, token: asaasWebhook.token }),
  });
  expect(((await r.json()) as { webhookStatus: number }).webhookStatus).toBe(200);
  return paymentId;
}

/** Abre a URL da sessão no checkout. A `url` da API é a pública da loja (https, sem porta); aqui, o mesmo caminho no host de teste. */
async function openSession(page: Page, url: string, extraQuery = "") {
  const u = new URL(url);
  await page.goto(`${multi.storeOrigin(STORE.slug)}${u.pathname}${u.search}${extraQuery}`);
}

async function metaEvents(): Promise<{ event: { event_name: string; custom_data?: Record<string, unknown>; user_data?: Record<string, unknown> } }[]> {
  return ((await (await fetch(`${multi.asaasBase}/__control/meta`)).json()) as { events: [] }).events;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Espera a fila de eventos do Meta esvaziar (nenhum job `meta_event` na fila nem rodando) e devolve os eventos recebidos
 * pelo Meta falso: "um envio só" é o estado depois do processamento, não o primeiro instante em que o contador chega a 1.
 */
async function metaEventsSettled() {
  const sql = postgres(multi.ownerDbUrl, { max: 1 });
  try {
    await expect
      .poll(async () => Number((await sql<{ n: string }[]>`select count(*) as n from job where type = 'meta_event' and status in ('queued', 'running')`)[0]!.n), {
        timeout: 30_000,
      })
      .toBe(0);
    const [{ failed }] = await sql<{ failed: string }[]>`select count(*) as failed from job where type = 'meta_event' and status = 'failed'`;
    expect(Number(failed), "nenhum evento do Meta falhou").toBe(0);
  } finally {
    await sql.end();
  }
  return metaEvents();
}

test.describe("app integrado (docs/integracao-apps.md)", () => {
  // Hooks e testes de 3 min: o beforeAll cria e migra um banco e sobe um `next start`; as compras passam por fila e avisos.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async ({ browser }) => {
    multi = await startMultiApp("apps", { card: true });
    await app.start();
    const created = await multi.createStore({ name: STORE.name, slug: STORE.slug, ownerEmail: STORE.email });
    owner = await browser.newPage({ viewport: DESKTOP, reducedMotion: "reduce" });
    await blockMeta(owner.context());
    await firstLogin(owner, multi.storeOrigin(STORE.slug), { email: STORE.email, temporaryPassword: created.temporaryPassword, password: STORE.password, storeName: STORE.name });
    // Asaas (Pix da oferta de app) e Meta (StartTrial e Purchase) apontando para os falsos desta instância.
    const { apiKey: asaasKey } = (await (await fetch(`${multi.asaasBase}/__control/key`)).json()) as { apiKey: string };
    const asaas = await seedAction<{ webhookUrl: string; webhookToken: string }>(owner, "connections.saveAsaas", { env: "sandbox", apiKey: asaasKey });
    asaasWebhook = { url: asaas.webhookUrl, token: asaas.webhookToken };
    const { token: metaToken } = (await (await fetch(`${multi.asaasBase}/__control/meta`)).json()) as { token: string };
    await seedAction(owner, "connections.saveMeta", { pixelId: PIXEL_ID, accessToken: metaToken });
    await seedAction(owner, "offers.create", {
      slug: OFFER.slug,
      name: OFFER.name,
      delivery: "app",
      appCode: OFFER.appCode,
      priceCents: OFFER.priceCents,
      methods: ["pix"],
      pixMode: "asaas",
    });
    await seedAction(owner, "offers.create", {
      slug: OFFER_CARD.slug,
      name: OFFER_CARD.name,
      delivery: "app",
      appCode: OFFER_CARD.appCode,
      priceCents: OFFER_CARD.priceCents,
      methods: ["pix", "card"],
      pixMode: "asaas",
    });
  });

  test.beforeEach(async ({ context }) => {
    await blockMeta(context);
  });

  test.afterAll(async () => {
    // Limpezas independentes: falha numa não pula as outras; a instância por último, num finally.
    try {
      await Promise.allSettled([owner?.close(), app.stop()]);
    } finally {
      await multi?.stop();
    }
    // Com tudo parado e os logs fechados: nenhum dado do cartão de teste nos logs do app nem do serviço de cartão.
    for (const file of ["multi-apps-app.log", "multi-apps-card.log"]) {
      const path = join(RUN_DIR, file);
      if (existsSync(path)) expect(cardInLog(readFileSync(path, "utf8")), file).toEqual({ number: false, cvv: false, cvvKey: false });
    }
  });

  test("Conexões → App (integração): webhook do app, segredo e chave aparecem uma vez; Enviar teste chega assinado", async () => {
    await owner.goto(`${multi.storeOrigin(STORE.slug)}/admin/connections`);
    await owner.getByRole("button", { name: "Conectar App (integração)" }).click();
    const card = owner.locator("#app");
    await card.getByLabel("URL do webhook").fill(app.url);
    await card.getByLabel("Hosts de retorno").fill(RETURN_HOST);
    await card.getByRole("button", { name: "Salvar webhook" }).click();
    await owner.getByRole("dialog", { name: "Salvar o webhook do app?" }).getByRole("button", { name: "Salvar" }).click();
    await expect(card.getByText("Copie agora: o segredo não aparece de novo.")).toBeVisible();
    app.secret = (await card.locator("code[title]").first().getAttribute("title"))!;
    expect(app.secret.length).toBeGreaterThanOrEqual(32);
    await card.getByRole("button", { name: "Já copiei" }).click();

    await card.getByLabel("Nome da chave").fill("App falso E2E");
    await card.getByRole("button", { name: "Criar chave" }).click();
    await expect(card.getByText("Copie agora: a chave não aparece de novo.")).toBeVisible();
    apiKey = (await card.locator("code[title]").first().getAttribute("title"))!;
    expect(apiKey).toMatch(/^fnl_/);
    await card.getByRole("button", { name: "Já copiei" }).click();

    // Depois de fechado o quadro, nem o segredo nem a chave voltam ao navegador.
    await owner.reload();
    expect(await owner.content()).not.toContain(app.secret);
    expect(await owner.content()).not.toContain(apiKey);

    await owner.getByRole("button", { name: "Configurar App (integração)" }).click();
    await card.getByRole("button", { name: "Enviar teste" }).click();
    await expect(card.getByText("O app recebeu o teste (HTTP 204).")).toBeVisible();
    const ping = app.deliveries.find((d) => d.outcome === "ping")!;
    expect(ping.authentic).toBe(true);
    expect(ping.headers["user-agent"]).toBe("funil-webhook/1");
    expect(ping.headers["content-type"]).toBe("application/json");
    expect(ping.headers["funil-evento"]).toBe(ping.notice!.id);
    expect(ping.notice).toMatchObject({ tipo: "ping", dados: {} });
    expect(ping.notice!.id).toMatch(/^evt_[0-9a-f]{32}$/);
  });

  test("POST /testes: 201 na primeira vez, 200 com o mesmo id depois; erros no envelope; StartTrial no Meta e o teste no painel", async () => {
    const body = { conta: conta("a"), email: BUYER.email, nome: BUYER.nome, origem: { utm_source: "facebook", utm_campaign: "lancamento", fbclid: "IwAR0exemplo" } };
    const first = await api("testes", body);
    expect(first.status).toBe(201);
    expect(first.json!.id).toMatch(/^[0-9a-f-]{36}$/);
    const again = await api("testes", { ...body, origem: { utm_source: "outra" } });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ id: first.json!.id });

    const withAt = await api("testes", { conta: "pessoa@exemplo.com", email: BUYER.email });
    expect(withAt.status).toBe(422);
    expect(withAt.json).toMatchObject({ erro: { codigo: "invalid_input", detalhes: [{ campo: "conta", mensagem: "Use o id interno da conta, não o e-mail" }] } });
    expect(withAt.raw.text).not.toContain("pessoa@exemplo.com"); // o funil nunca devolve o valor enviado
    // Chave com o formato da emitida e um caractere diferente no fim do segredo: passa no formato e falha na credencial.
    const last = apiKey.at(-1)!;
    const badKey = await api("testes", body, `${apiKey.slice(0, -1)}${last === "A" ? "B" : "A"}`);
    expect(badKey.status).toBe(401);
    expect(badKey.json).toEqual({ erro: { codigo: "unauthorized", mensagem: "Chave de integração ausente ou inválida" } });
    const get = await multi.hostRequest(HOST, "/api/integracao/v1/testes", { headers: { authorization: `Bearer ${apiKey}` } });
    expect(get.status).toBe(405);
    expect(get.text).toBe("");

    // Uma vez por conta: depois de a fila do Meta esvaziar, um StartTrial só (valor 0), com external_id = SHA-256 da conta e
    // nunca o e-mail nem a conta em claro.
    const startTrials = (await metaEventsSettled()).filter((e) => e.event.event_name === "StartTrial");
    expect(startTrials).toHaveLength(1);
    const trial = startTrials[0]!;
    expect(trial.event.user_data?.external_id).toEqual([sha256(conta("a"))]);
    expect(trial.event.custom_data).toMatchObject({ value: 0, currency: "BRL" });
    expect(JSON.stringify(trial)).not.toContain(BUYER.email);
    expect(JSON.stringify(trial)).not.toContain(conta("a"));

    // Painel: o teste aparece nos indicadores da loja (loja com oferta de app).
    await owner.goto(`${multi.storeOrigin(STORE.slug)}/admin`);
    const trials = owner.getByRole("region", { name: "Testes do app no período" });
    await expect(trials.getByText("Testes iniciados")).toBeVisible();
    await expect(trials.getByText("lancamento")).toBeVisible();
  });

  test("POST /pagamentos e checkout com ?s=: nome e e-mail travados, Pix do Asaas, aviso assinado com sequencia 1 e uma liberação", async ({ page }) => {
    const body = { conta: conta("a"), oferta: OFFER.slug, email: BUYER.email, nome: BUYER.nome, telefone: BUYER.telefone, retorno: RETORNO };
    const created = await api("pagamentos", body);
    expect(created.status).toBe(201);
    const url = String(created.json!.url);
    expect(url).toMatch(new RegExp(`^https://${HOST.replace(".", "\\.")}/c/${OFFER.slug}\\?s=[0-9a-f-]{36}$`));
    const expires = Date.parse(String(created.json!.expira_em));
    expect(expires - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    // Repetição segura (mesmos campos, em até 2 min, sem pedido ainda): a mesma sessão, 200.
    const repeated = await api("pagamentos", body);
    expect(repeated.status).toBe(200);
    expect(repeated.json).toEqual(created.json);
    // Retorno fora dos hosts configurados e oferta inexistente.
    const badReturn = await api("pagamentos", { ...body, retorno: "https://evil.example/x" });
    expect(badReturn.status).toBe(422);
    expect(badReturn.json).toMatchObject({ erro: { codigo: "invalid_input", detalhes: [{ campo: "retorno" }] } });
    const noOffer = await api("pagamentos", { ...body, oferta: "nao-existe" });
    expect(noOffer.status).toBe(404);
    expect(noOffer.json).toEqual({ erro: { codigo: "not_found", mensagem: "Oferta de app não encontrada" } });

    // Oferta de app não abre sem sessão nem com sessão desconhecida.
    const origin = multi.storeOrigin(STORE.slug);
    await page.goto(`${origin}/c/${OFFER.slug}`);
    await expect(page.getByText("Abra o pagamento pelo app")).toBeVisible();
    await expect(page.getByRole("button", { name: /Gerar Pix/ })).toHaveCount(0);
    await page.goto(`${origin}/c/${OFFER.slug}?s=00000000-0000-4000-8000-000000000000`);
    await expect(page.getByText("Este link de pagamento venceu. Volte ao app e tente de novo.")).toBeVisible();

    await openSession(page, url);
    await expect(page.getByText("Dados da sua conta no app. Para trocar, volte ao app.")).toBeVisible();
    await expect(page.getByText(BUYER.nome)).toBeVisible();
    await expect(page.getByText(BUYER.email)).toBeVisible();
    await expect(page.getByLabel("E-mail", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("WhatsApp")).toHaveCount(0); // o app mandou o telefone
    expect((await page.goto(page.url()))?.headers()["referrer-policy"]).toBe("strict-origin");
    await page.getByLabel("CPF").fill(BUYER.cpf);
    await page.getByRole("button", { name: `Gerar Pix de ${OFFER.price}` }).click();
    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    paidPublicId = new URL(page.url()).pathname.split("/").pop()!;
    await payPix(page);
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("O acesso é liberado no app").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Voltar ao app" }).first()).toHaveAttribute("href", RETORNO);

    // O app recebe pagamento.confirmado assinado, sequencia 1, com a conta e o app_code; nenhum dado pessoal.
    await expect.poll(() => app.noticesOf(paidPublicId).length, { timeout: 20_000 }).toBe(1);
    const d = app.deliveries.find((x) => x.notice?.dados.pedido === paidPublicId)!;
    expect(d.authentic).toBe(true);
    expect(d.headers["funil-evento"]).toBe(d.notice!.id);
    expect(d.headers["user-agent"]).toBe("funil-webhook/1");
    const n: Notice = d.notice!;
    expect(n.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(n.tipo).toBe("pagamento.confirmado");
    expect(n.dados).toMatchObject({ conta: conta("a"), pedido: paidPublicId, app_code: OFFER.appCode, valor_centavos: OFFER.priceCents, metodo: "pix", sequencia: 1 });
    expect(typeof n.dados.pago_em).toBe("string");
    for (const pii of [BUYER.email, BUYER.nome, BUYER.cpf, BUYER.telefone]) expect(d.raw).not.toContain(pii);
    expect(app.orders.get(paidPublicId)).toMatchObject({ estado: "liberado", liberacoes: 1, ultimaSequencia: 1 });

    // Purchase no Meta, um só depois de a fila esvaziar: o app_code como produto e o mesmo external_id do StartTrial.
    const purchases = (await metaEventsSettled()).filter((e) => e.event.event_name === "Purchase");
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.event.custom_data).toMatchObject({ content_ids: [OFFER.appCode] });
    expect(purchases[0]!.event.user_data?.external_id).toEqual([sha256(conta("a"))]);

    // Sessão paga: o mesmo link não abre outro checkout.
    await openSession(page, url);
    await expect(page.getByText("Este link de pagamento venceu. Volte ao app e tente de novo.")).toBeVisible();
  });

  test("assinatura: o app falso recusa corpo alterado, segredo errado e t fora da janela (como o §7.4 manda)", async () => {
    const d = app.deliveries.find((x) => x.notice?.dados.pedido === paidPublicId)!;
    const header = d.headers["funil-assinatura"] as string;
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(app.secret, d.raw, header)).toBe(true);
    expect(verifySignature(app.secret, d.raw.replace(OFFER.appCode, "outro_plano"), header)).toBe(false);
    expect(verifySignature(`${app.secret}x`, d.raw, header)).toBe(false);
    const old = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(verifySignature(app.secret, d.raw, sign(app.secret, d.raw, old))).toBe(false);
    // E pelo servidor do app falso: assinatura forjada leva 401 e não aplica nada.
    const forged = await fetch(app.url, { method: "POST", headers: { "funil-assinatura": sign("segredo-errado", d.raw, Math.floor(Date.now() / 1000)) }, body: d.raw });
    expect(forged.status).toBe(401);
    expect(app.orders.get(paidPublicId)!.liberacoes).toBe(1);
  });

  test("Reenviar aviso ao app: mesmo id, o app não libera de novo; reembolso pelo painel chega com sequencia 2 e retira", async () => {
    const origin = multi.storeOrigin(STORE.slug);
    await owner.goto(`${origin}/admin/orders`);
    await owner.getByRole("link", { name: `#${codeOf(paidPublicId)}` }).click();
    await expect(owner.getByRole("heading", { name: `Pedido #${codeOf(paidPublicId)}` })).toBeVisible();
    const before = app.deliveries.filter((x) => x.notice?.dados.pedido === paidPublicId).length;
    await owner.getByRole("button", { name: "Reenviar aviso ao app" }).click();
    await owner.getByRole("dialog", { name: "Reenviar o aviso ao app?" }).getByRole("button", { name: "Reenviar aviso" }).click();
    await expect.poll(() => app.deliveries.filter((x) => x.notice?.dados.pedido === paidPublicId).length, { timeout: 20_000 }).toBe(before + 1);
    const [first, resent] = app.deliveries.filter((x) => x.notice?.dados.pedido === paidPublicId);
    expect(resent!.authentic).toBe(true);
    expect(resent!.notice!.id).toBe(first!.notice!.id);
    expect(resent!.outcome).toBe("repetido");
    expect(app.orders.get(paidPublicId)).toMatchObject({ estado: "liberado", liberacoes: 1 });

    await owner.getByRole("button", { name: "Reembolsar" }).click();
    await owner.getByRole("dialog", { name: `Reembolsar ${OFFER.price} para ${BUYER.nome}?` }).getByRole("button", { name: `Reembolsar ${OFFER.price}` }).click();
    await expect.poll(() => app.noticesOf(paidPublicId).map((x) => x.tipo), { timeout: 30_000 }).toEqual(["pagamento.confirmado", "pagamento.confirmado", "pagamento.reembolsado"]);
    const refund = app.noticesOf(paidPublicId)[2]!;
    expect(refund.dados).toMatchObject({ conta: conta("a"), pedido: paidPublicId, app_code: OFFER.appCode, sequencia: 2 });
    expect(refund.id).not.toBe(first!.notice!.id);
    expect(app.orders.get(paidPublicId)).toMatchObject({ estado: "retirado", liberacoes: 1, ultimaSequencia: 2 });

    // Reenvio com tudo entregue manda o último (o reembolso), com o mesmo id: o app já o tinha, nada muda.
    await owner.reload();
    await owner.getByRole("button", { name: "Reenviar aviso ao app" }).click();
    await owner.getByRole("dialog", { name: "Reenviar o aviso ao app?" }).getByRole("button", { name: "Reenviar aviso" }).click();
    await expect.poll(() => app.noticesOf(paidPublicId).length, { timeout: 20_000 }).toBe(4);
    expect(app.noticesOf(paidPublicId)[3]!.id).toBe(refund.id);
    expect(app.orders.get(paidPublicId)).toMatchObject({ estado: "retirado", liberacoes: 1, ultimaSequencia: 2 });
  });

  test("sequência antiga: um receptor limpo recebe o reembolso (2) antes da confirmação (1) e não libera nada", async () => {
    // Os dois avisos autênticos que o funil mandou para o pedido pago, entregues fora de ordem a um app falso sem estado
    // (re-assinados agora, como o funil faz a cada tentativa: a assinatura vale por 5 min).
    const of = (tipo: string) => app.deliveries.find((d) => d.authentic && d.notice?.dados.pedido === paidPublicId && d.notice.tipo === tipo)!.raw;
    const confirmRaw = of("pagamento.confirmado");
    const refundRaw = of("pagamento.reembolsado");
    const clean = new FakeApp();
    clean.secret = app.secret;
    await clean.start();
    try {
      for (const raw of [refundRaw, confirmRaw]) {
        const res = await fetch(clean.url, {
          method: "POST",
          headers: { "content-type": "application/json", "funil-assinatura": sign(app.secret, raw, Math.floor(Date.now() / 1000)) },
          body: raw,
        });
        expect(res.status).toBe(200);
      }
      expect(clean.deliveries.map((d) => [d.notice?.tipo, d.outcome])).toEqual([
        ["pagamento.reembolsado", "aplicado"],
        ["pagamento.confirmado", "antigo"],
      ]);
      expect(clean.orders.get(paidPublicId)).toMatchObject({ estado: "retirado", liberacoes: 0, ultimaSequencia: 2 });
    } finally {
      await clean.stop();
    }
  });

  test("sessão vencida de verdade: a sessão válida abre o formulário; com expires_at no passado, o link diz que venceu", async ({ page }) => {
    const created = await api("pagamentos", { conta: conta("d"), oferta: OFFER.slug, email: BUYER.email, nome: BUYER.nome, telefone: BUYER.telefone });
    expect(created.status).toBe(201);
    const url = String(created.json!.url);
    const sessionId = new URL(url).searchParams.get("s")!;
    await openSession(page, url);
    await expect(page.getByText("Dados da sua conta no app. Para trocar, volte ao app.")).toBeVisible();
    await expect(page.getByRole("button", { name: `Gerar Pix de ${OFFER.price}` })).toBeVisible();
    // Vence a sessão no banco descartável desta instância (o mesmo que passar 60 min).
    const sql = postgres(multi.ownerDbUrl, { max: 1 });
    try {
      const rows = await sql`update app_checkout_session set expires_at = now() - interval '1 minute' where id = ${sessionId} returning id`;
      expect(rows).toHaveLength(1);
    } finally {
      await sql.end();
    }
    await openSession(page, url);
    await expect(page.getByText("Este link de pagamento venceu. Volte ao app e tente de novo.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Gerar Pix/ })).toHaveCount(0);
  });

  test("cartão pelo serviço de cartão isolado: oferta de app paga com o cartão de teste, aviso com metodo cartao e uma liberação", async ({ page }) => {
    const created = await api("pagamentos", { conta: conta("c"), oferta: OFFER_CARD.slug, email: BUYER.email, nome: BUYER.nome, telefone: BUYER.telefone });
    expect(created.status).toBe(201);
    await openSession(page, String(created.json!.url), "&metodo=cartao");
    const frame = page.frameLocator('iframe[title="Dados do cartão"]');
    await expect(frame.getByLabel("Número do cartão")).toBeVisible();
    await page.getByLabel("CPF", { exact: true }).fill(BUYER.cpf);
    await frame.getByLabel("Número do cartão").fill(CARD.number);
    await frame.getByLabel("Nome impresso no cartão").fill(CARD.holder);
    await frame.getByLabel("Validade").fill(CARD.expiry);
    await frame.getByLabel("CVV").fill(CARD.cvv);
    await frame.getByLabel("CEP").fill("01310100");
    await frame.getByLabel("Número", { exact: true }).fill("100");
    await page.getByRole("button", { name: `Pagar ${OFFER_CARD.price}` }).click();
    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    const publicId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => app.noticesOf(publicId).length, { timeout: 20_000 }).toBe(1);
    const d = app.deliveries.find((x) => x.notice?.dados.pedido === publicId)!;
    expect(d.authentic).toBe(true);
    expect(d.notice!.dados).toMatchObject({ conta: conta("c"), pedido: publicId, app_code: OFFER_CARD.appCode, valor_centavos: OFFER_CARD.priceCents, metodo: "cartao", sequencia: 1 });
    for (const [label, secret] of [["número", CARD.number.replace(/ /g, "")], ["nome impresso", CARD.holder], ["CPF", BUYER.cpf]] as const) {
      expect(d.raw.includes(secret), `${label} no corpo do aviso`).toBe(false);
    }
    expect(app.orders.get(publicId)).toMatchObject({ estado: "liberado", liberacoes: 1 });
  });

  test("uma liberação por sessão: dois Pix pagos no mesmo link geram aviso só do primeiro; o vendedor é alertado do duplicado", async ({ browser }) => {
    const created = await api("pagamentos", { conta: conta("b"), oferta: OFFER.slug, email: BUYER.email, nome: BUYER.nome, telefone: BUYER.telefone });
    expect(created.status).toBe(201);
    const url = String(created.json!.url);
    // Duas abas da mesma sessão com CPFs diferentes: dois pedidos pendentes (mesmo CPF reaproveitaria o pedido).
    const tabA = await browser.newPage();
    const tabB = await browser.newPage();
    await blockMeta(tabA.context());
    await blockMeta(tabB.context());
    const orderIn = async (tab: Page, cpf: string) => {
      await openSession(tab, url);
      await tab.getByLabel("CPF").fill(cpf);
      await tab.getByRole("button", { name: `Gerar Pix de ${OFFER.price}` }).click();
      await expect(tab).toHaveURL(/\/o\/[\w-]+$/);
      await expect(tab.getByTestId("pix-code")).toBeVisible();
      return new URL(tab.url()).pathname.split("/").pop()!;
    };
    const a = await orderIn(tabA, BUYER.cpf);
    const b = await orderIn(tabB, SECOND_CPF);
    expect(b).not.toBe(a);

    await payPix(tabA);
    await expect(tabA.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => app.noticesOf(a).length, { timeout: 20_000 }).toBe(1);
    // A outra aba, ainda pendente, diz que a sessão já foi paga e não mostra mais o Pix.
    await tabB.reload();
    await expect(tabB.getByRole("heading", { name: "Pagamento já concluído" })).toBeVisible();
    await expect(tabB.getByText("Este link já foi pago em outro pedido.", { exact: false })).toBeVisible();

    // Quem já tinha copiado o Pix da aba B paga mesmo assim: o pedido B vira pago, mas não gera aviso nenhum.
    const sql = postgres(multi.ownerDbUrl, { max: 1 });
    try {
      const [pay] = await sql<{ provider_id: string }[]>`
        select p.provider_id from payment p join orders o on o.id = p.order_id where o.public_id = ${b} and p.provider = 'asaas'`;
      const r = await fetch(`${multi.asaasBase}/__control/pay/${pay!.provider_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callbackUrl: asaasWebhook.url, token: asaasWebhook.token }),
      });
      expect(((await r.json()) as { webhookStatus: number }).webhookStatus).toBe(200);
      await expect.poll(async () => (await sql<{ status: string }[]>`select status from orders where public_id = ${b}`)[0]!.status, { timeout: 20_000 }).toBe("paid");
      // O aviso nasce na mesma transação que confirma o pedido: com B pago e nenhuma linha, nenhum aviso sairá.
      const rows = await sql`select d.event_id from app_webhook_delivery d join orders o on o.id = d.order_id where o.public_id = ${b}`;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
    expect(app.noticesOf(b)).toHaveLength(0);
    expect(app.orders.get(a)).toMatchObject({ estado: "liberado", liberacoes: 1, conta: conta("b") });

    await owner.goto(`${multi.storeOrigin(STORE.slug)}/admin`);
    await expect(owner.getByText(`Pagamento em dobro no mesmo link do app`, { exact: false }).first()).toBeVisible();
    await tabA.close();
    await tabB.close();
  });
});
