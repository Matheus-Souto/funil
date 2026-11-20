import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import postgres from "postgres";
import { cardLeaks } from "./card-leaks";

// Código do primeiro acesso: o verify sobe o app com este SETUP_TOKEN e o repassa ao Playwright.
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "";
// Origem do serviço de cartão isolado (com o marcador e2e/.card-isolated, o verify sobe o app com CARD_ISOLATED=1 e
// esta CARD_ORIGIN).
const CARD_ORIGIN = process.env.CARD_ORIGIN ?? "";
// Banco descartável da rodada (papel dono, loopback): só para conferir o que o painel gravou.
const OWNER_DB = process.env.E2E_OWNER_DATABASE_URL ?? "";

// Tasks 6-14 acrescentam aqui o fluxo de compra.
test("/api/health responde ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("/t.js: JavaScript com CORS aberto e cache longo (embutido em páginas de vendas de outros domínios)", async ({ request }) => {
  const res = await request.get("/t.js");
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h["content-type"]).toMatch(/^text\/javascript/);
  expect(h["access-control-allow-origin"]).toBe("*");
  expect(h["cache-control"]).toContain("max-age=86400");
  expect((await res.body()).byteLength).toBeLessThan(3072);
});

test("CSP com nonce só nas páginas do comprador (/c e /o); painel sem", async ({ request }) => {
  for (const path of ["/c/qualquer-oferta", "/o/qualquer-pedido"]) {
    const csp = (await request.get(path)).headers()["content-security-policy"] ?? "";
    expect(csp, path).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{22,}' https:\/\/connect\.facebook\.net/);
    expect(csp, path).toContain("frame-ancestors 'none'");
  }
  const a = (await request.get("/c/qualquer-oferta")).headers()["content-security-policy"];
  const b = (await request.get("/c/qualquer-oferta")).headers()["content-security-policy"];
  expect(a).not.toBe(b); // nonce novo a cada requisição
  for (const path of ["/api/health", "/t.js"]) {
    expect((await request.get(path)).headers()["content-security-policy"], path).toBeUndefined();
  }
  // Painel e login: só proteção contra frame (clickjacking), sem a CSP do comprador.
  const login = (await request.get("/admin/login")).headers();
  expect(login["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(login["x-frame-options"]).toBe("DENY");
});

test("página inicial abre no celular", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Funil" })).toBeVisible();
});

test("modo single: /admin leva ao setup, cria a loja, sai e entra de novo", async ({ page }) => {
  const email = "dono@exemplo.com";
  const password = "senha-longa-123";

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/setup$/);
  await shot(page, "p02b-configuracao-inicial-375");
  await page.setViewportSize({ width: 1280, height: 820 });
  await shot(page, "p02-configuracao-inicial-1280");
  await page.setViewportSize({ width: 375, height: 812 });

  const fillSetup = async (code: string) => {
    await page.getByLabel("Código de configuração").fill(code);
    await page.getByLabel("Nome da loja").fill("Loja de Teste");
    await page.getByLabel("Seu nome").fill("Dono");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Senha (mínimo 10 caracteres)").fill(password);
    await page.getByRole("button", { name: "Criar loja" }).click();
  };
  // Sem o código do servidor (SETUP_TOKEN), ninguém vira dono da loja.
  await fillSetup("codigo-errado-0123456789");
  await expect(page).toHaveURL(/\/admin\/setup\?erro=codigo$/);
  await expect(page.getByText("Código de configuração inválido.")).toBeVisible();
  await fillSetup(SETUP_TOKEN);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Boas-vindas, Loja de Teste" })).toBeVisible();

  // No celular, "Sair" fica no menu "Mais" das abas.
  await page.getByRole("button", { name: "Mais" }).click();
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);

  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("senha-errada-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("E-mail ou senha inválidos.")).toBeVisible();

  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Boas-vindas, Loja de Teste" })).toBeVisible();

  // setup não é mais acessível depois de criado o primeiro usuário
  await page.goto("/admin/setup");
  await expect(page).toHaveURL(/\/admin\/login$/);
});

// Webhook do Asaas: o fluxo de pagar pelo endpoint de controle do Asaas falso fica para a Task 11 (UI do checkout);
// aqui só o que a rota já garante.
test("webhook do Asaas: storeId inválido 404, token errado 401, corpo grande 413", async ({ request }) => {
  const uuid = "00000000-0000-4000-8000-000000000000";
  expect((await request.post("/api/webhooks/asaas/nao-e-uuid", { data: {} })).status()).toBe(404);
  const wrong = await request.post(`/api/webhooks/asaas/${uuid}`, {
    headers: { "asaas-access-token": "errado" },
    data: { event: "PAYMENT_RECEIVED", payment: { id: "pay_1" } },
  });
  expect(wrong.status()).toBe(401);
  const big = await request.post(`/api/webhooks/asaas/${uuid}`, {
    headers: { "asaas-access-token": "errado", "content-type": "application/json" },
    data: JSON.stringify({ pad: "x".repeat(70 * 1024) }),
  });
  expect(big.status()).toBe(413);
});

// Cartão isolado (CARD_ISOLATED=1): o verify sobe o serviço de cartão (dist/card/server.js) em CARD_ORIGIN, outra origem
// (127.0.0.1 em outra porta). A rota antiga do cartão no app responde 404 a tudo, sem ler o corpo nem ecoar dados; o
// serviço só aceita POST da própria origem e com bilhete válido.
test("cartão isolado: rota antiga do app 404 sem ecoar dados; serviço de cartão no ar e recusando POST sem bilhete", async ({ request, baseURL }) => {
  expect(CARD_ORIGIN, "o verify passa CARD_ORIGIN (origem do serviço de cartão)").toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const app = new URL(baseURL!).origin;
  expect(CARD_ORIGIN).not.toBe(app);
  const card = {
    orderPublicId: "pedido-que-nao-existe",
    idempotencyKey: "6f1c1f5e-3c55-4a43-9a7b-0d6a3f1f2b11",
    installments: 1,
    card: { holderName: "Teste Smoke", number: "4444444444444444", expiryMonth: "12", expiryYear: "2034", ccv: "987" },
    holder: { cpf: "52998224725", postalCode: "01310100", addressNumber: "100" },
  };
  for (const headers of [{ origin: app }, { origin: "https://evil.example" }, {}] as Record<string, string>[]) {
    const res = await request.post("/api/checkout/card", { headers, data: card });
    expect(res.status(), JSON.stringify(headers)).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("4444");
    expect(text).not.toContain("987");
  }

  expect((await request.get(`${CARD_ORIGIN}/healthz`)).status()).toBe(200);
  const js = await request.get(`${CARD_ORIGIN}/form.js`);
  expect(js.status()).toBe(200);
  expect(js.headers()["content-type"]).toMatch(/javascript/);
  // POST de outra origem (inclusive a do app): 403 antes de ler o corpo. Da origem do cartão sem bilhete válido: 403.
  const fromApp = await request.post(`${CARD_ORIGIN}/api/card`, { headers: { origin: app }, data: { ...card, ticket: "x" } });
  expect(fromApp.status()).toBe(403);
  expect(await fromApp.json()).toMatchObject({ error: "forbidden_origin" });
  const noTicket = await request.post(`${CARD_ORIGIN}/api/card`, { headers: { origin: CARD_ORIGIN }, data: { ...card, ticket: "x" } });
  expect(noTicket.status()).toBe(403);
  expect(await noTicket.json()).toEqual({ error: "ticket", ticketExpired: false });
});

// ---------------------------------------------------------------------------------------------------------------
// Tasks 11–14: o dono configura a loja PELO PAINEL (conexões, produtos com upload, oferta com bump) e as compras
// acontecem pelo checkout, no celular (375×812), como o comprador faria; o dono libera, reenvia e reembolsa pelo painel.
// A rota só do smoke /api/test-only (src/lib/e2e-seed.ts) ficou só para o que o painel não tem: a URL do Asaas falso, a
// origem gravada no pedido e um membro `support` (tela de equipe é da fase 2). O Asaas é o falso do verify.
// Capturas de tela vão para a pasta da execução do verify (<run>/screenshots).
const SHOTS = join(process.env.PW_OUTPUT_DIR ? dirname(process.env.PW_OUTPUT_DIR) : ".verify/local", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => window.scrollTo(0, 0)); // o painel tem sidebar fixa: captura a partir do topo
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

const OWNER = { email: "dono@exemplo.com", password: "senha-longa-123" };
const SUPPORT = { email: "atendimento@exemplo.com", password: "senha-suporte-123" };
const PIXEL_ID = "1234567890123";
const stamp = Date.now();
const buyerEmail = (tag: string) => `comprador.${tag}.${stamp}@exemplo.com`;
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
/** Código curto do pedido no painel (#XXXXXXXX): 8 primeiros caracteres alfanuméricos do id público, em maiúsculas. */
const codeOf = (publicId: string) => publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);

test.describe("painel e compra pelo checkout (Tasks 11–14)", () => {
  test.describe.configure({ mode: "serial" });

  let owner: Page;
  let asaasBase = "";
  let manualPublicId = "";
  let asaasPublicId = "";
  let webhook = { url: "", token: "" };

  /** fetch de dentro do navegador do dono (cookie de sessão do painel, mesma origem). */
  async function asOwner<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
    const r = await owner.evaluate(
      async ({ path, init }) => {
        const res = await fetch(path, {
          method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
          headers: init.json !== undefined ? { "content-type": "application/json" } : {},
          body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        });
        return { status: res.status, body: await res.json() };
      },
      { path, init },
    );
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body as T;
  }

  /** Abre o pedido no painel do dono pela lista (busca pelo e-mail do comprador). */
  async function openOrder(page: Page, publicId: string, email: string) {
    await page.goto(`/admin/orders?q=${encodeURIComponent(email)}`);
    await page.getByRole("link", { name: `#${codeOf(publicId)}` }).click();
    await expect(page.getByRole("heading", { name: `Pedido #${codeOf(publicId)}` })).toBeVisible();
  }

  test.beforeAll(async ({ browser }) => {
    owner = await browser.newPage({ viewport: DESKTOP });
    await owner.goto("/admin/login");
    await owner.getByLabel("E-mail").fill(OWNER.email);
    await owner.getByLabel("Senha").fill(OWNER.password);
    await owner.getByRole("button", { name: "Entrar" }).click();
    await expect(owner).toHaveURL(/\/admin$/);
    asaasBase = (await asOwner<{ baseUrl: string }>("/api/test-only/asaas")).baseUrl;
  });

  test("painel: conexões (Pix manual, Asaas com URL e token do webhook, SMTP, Meta), cada uma com diálogo de confirmação", async ({ request }) => {
    const page = owner;
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Boas-vindas, Loja de Teste" })).toBeVisible();
    await shot(page, "p04-visao-geral-vazia-1280");

    await page.goto("/admin/connections");
    await shot(page, "p14a-conexoes-vazias-1280");
    const pix = page.locator("#pix-manual-card");
    await pix.getByLabel("Chave Pix").fill("contato@manakids.com.br");
    await pix.getByLabel("Nome do recebedor").fill("Mana Kids");
    await pix.getByLabel("Cidade").fill("Sao Paulo");
    await pix.getByRole("button", { name: "Salvar chave Pix" }).click();
    const pixDialog = page.getByRole("dialog", { name: "Salvar esta chave Pix?" });
    await expect(pixDialog).toBeVisible();
    await page.keyboard.press("Escape"); // Esc fecha sem salvar
    await expect(pixDialog).toBeHidden();
    await pix.getByRole("button", { name: "Salvar chave Pix" }).click();
    await pixDialog.getByRole("button", { name: "Salvar chave" }).click();
    await expect(pix.getByText("Chave Pix salva.")).toBeVisible();
    await expect(pix.getByText("MANA KIDS")).toBeVisible();

    const asaas = page.locator("#asaas");
    const { apiKey } = (await (await request.get(`${asaasBase}/__control/key`)).json()) as { apiKey: string };
    await asaas.getByLabel("Chave de API").fill(apiKey);
    await asaas.getByRole("button", { name: "Conectar Asaas" }).click();
    await page.getByRole("dialog", { name: "Conectar o Asaas em sandbox?" }).getByRole("button", { name: "Testar e salvar" }).click();
    await expect(asaas.getByText("Asaas conectado.")).toBeVisible();
    await expect(asaas.getByText("configurado")).toBeVisible();
    const url = (await asaas.locator("code").first().textContent())!.trim();
    expect(url).toMatch(/\/api\/webhooks\/asaas\/[0-9a-f-]{36}$/);
    await asaas.getByRole("button", { name: "Mostrar" }).click();
    const token = (await asaas.getByLabel("Token de autenticação do webhook").textContent())!.trim();
    expect(token.length).toBeGreaterThan(20);
    expect(await page.content()).not.toContain(apiKey); // a chave nunca volta ao navegador
    webhook = { url, token };
    await asaas.getByText("Como configurar no Asaas").click();
    await expect(asaas.getByText("reative a fila")).toBeVisible();

    // SMTP da loja: Mailpit do compose (a ação testa a conexão antes de salvar).
    const smtp = page.locator("#smtp");
    await smtp.getByLabel("Servidor").fill("127.0.0.1");
    await smtp.getByLabel("Porta", { exact: true }).fill("1025");
    await smtp.getByLabel("Remetente (e-mail)").fill("contato@manakids.com.br");
    await smtp.getByRole("button", { name: "Testar e salvar" }).click();
    await page.getByRole("dialog", { name: "Salvar o SMTP da loja?" }).getByRole("button", { name: "Testar e salvar" }).click();
    await expect(smtp.getByText("SMTP testado e salvo.")).toBeVisible();

    // Meta: Pixel + API de Conversões falsa do verify (${asaasBase}/meta). O token é testado antes de salvar.
    const { token: metaToken } = (await (await request.get(`${asaasBase}/__control/meta`)).json()) as { token: string };
    const meta = page.locator("#meta");
    await meta.getByLabel("Pixel ID").fill(PIXEL_ID);
    await meta.getByLabel("Token da API de Conversões").fill(metaToken);
    await meta.getByRole("button", { name: "Salvar" }).click();
    await page.getByRole("dialog", { name: "Salvar a conexão com o Meta?" }).getByRole("button", { name: "Testar e salvar" }).click();
    await expect(meta.getByText("Meta conectado: token conferido e salvo.")).toBeVisible();
    expect(await page.content()).not.toContain(metaToken);
    await meta.getByRole("button", { name: "Testar", exact: true }).click();
    await expect(meta.getByText("Conexão com o Meta funcionando.")).toBeVisible();
    await page.reload();
    await shot(page, "p14-conexoes-1280");
  });

  test("painel: produtos com upload do PDF (validação e progresso) e oferta com bump pelo editor", async () => {
    const page = owner;
    await page.goto("/admin/products");
    // Arquivo que não é PDF: recusado antes de enviar.
    await page.getByLabel("Arquivo PDF do produto").setInputFiles({ name: "nota.txt", mimeType: "text/plain", buffer: Buffer.from("oi") });
    await expect(page.getByText("Envie um arquivo PDF.")).toBeVisible();
    // PDF corrompido: a mensagem do servidor (validação com pdf-lib) aparece.
    await page.getByLabel("Nome do produto").fill("Arquivo quebrado");
    await page.getByLabel("Arquivo PDF do produto").setInputFiles({ name: "quebrado.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nnada") });
    await page.getByRole("button", { name: "Criar produto" }).click();
    await expect(page.getByText("O PDF está corrompido ou tem estrutura inválida.", { exact: false })).toBeVisible();

    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const pdf = Buffer.from(await doc.save());
    for (const name of ["Maná bíblico · versão básica", "Maná bíblico · versão completa"]) {
      await page.getByLabel("Nome do produto").fill(name);
      await page.getByLabel("Arquivo PDF do produto").setInputFiles({ name: "mana.pdf", mimeType: "application/pdf", buffer: pdf });
      await page.getByRole("button", { name: "Criar produto" }).click();
      await expect(page.getByText(`Produto “${name}” criado.`)).toBeVisible();
    }
    await expect(page.getByRole("cell", { name: "Maná bíblico · versão completa" })).toBeVisible();
    await shot(page, "p13-produtos-1280");

    async function newOffer(o: { slug: string; manual: boolean; bump: boolean; maxInstallments?: number }) {
      await page.goto("/admin/offers/nova");
      await page.getByLabel("Nome da oferta").fill("Maná bíblico para crianças");
      await page.getByLabel("Preço", { exact: true }).fill("9,90");
      await page.getByLabel("Produto entregue").selectOption({ label: "Maná bíblico · versão básica" });
      await page.getByLabel("Endereço (slug)").fill(o.slug);
      await page.getByLabel("Cartão de crédito").check();
      if (o.maxInstallments) await page.getByLabel("Parcelas máximas no cartão").selectOption(String(o.maxInstallments));
      await page.locator("label", { hasText: o.manual ? /^Manual$/ : /^Asaas \(automático\)$/ }).click();
      await expect(page.getByLabel(o.manual ? "Manual" : "Asaas (automático)", { exact: true })).toBeChecked();
      if (o.bump) {
        await page.getByLabel("Oferecer order bump").check();
        await page.getByLabel("Produto do bump").selectOption({ label: "Maná bíblico · versão completa" });
        await page.getByLabel("Preço do acréscimo").fill("17,10");
        await page.getByLabel("Título da caixa").fill("Quero a versão completa");
      }
      await page.getByLabel("Mensagem exibida depois do pagamento confirmado").fill("Que essas histórias tragam momentos especiais em família!");
      await page.getByRole("button", { name: "Criar oferta" }).click();
      await expect(page).toHaveURL(/\/admin\/offers\/[0-9a-f-]{36}\?criada=1$/);
      await expect(page.getByText("Oferta criada.")).toBeVisible();
    }
    await newOffer({ slug: "mana-basica", manual: true, bump: true, maxInstallments: 3 });
    await expect(page.getByText("Total com bump: R$ 27,00")).toBeVisible();
    // Preço é sensível: mudar abre o diálogo; cancelar não salva.
    await page.getByLabel("Preço", { exact: true }).fill("12,90");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    const priceDialog = page.getByRole("dialog", { name: "Alterar o preço desta oferta?" });
    await expect(priceDialog.getByText("R$ 9,90 → R$ 12,90")).toBeVisible();
    await shot(page, "p12b-dialogo-preco-1280");
    await priceDialog.getByRole("button", { name: "Cancelar" }).click();
    await page.getByLabel("Preço", { exact: true }).fill("9,90");
    await shot(page, "p12-oferta-editor-1280");
    await newOffer({ slug: "mana-auto", manual: false, bump: false });

    await page.goto("/admin/offers");
    await expect(page.getByText("Bump: Maná bíblico · versão completa + R$ 17,10")).toBeVisible();
    await shot(page, "p11-ofertas-1280");
    await page.goto("/admin/settings");
    await expect(page.getByText("data-checkout=")).toBeVisible();
    await shot(page, "p15-configuracoes-1280");
  });

  test.afterAll(async () => {
    await owner?.close();
  });

  // Nada de terceiros nos testes: o fbevents.js do Meta vira um script vazio (a fila `fbq.queue` guarda as chamadas).
  // Toda violação de CSP nas páginas do comprador (console do navegador) reprova o teste.
  let cspViolations: string[] = [];
  test.beforeEach(async ({ context, page }) => {
    cspViolations = [];
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
    });
    await context.route(/^https:\/\/(connect|www)\.facebook\.(net|com)\//, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  });
  test.afterEach(() => {
    expect(cspViolations).toEqual([]);
  });

  /** Fila crua do `fbq` (set/init/track), na ordem. */
  const pixelQueue = (page: Page) =>
    page.evaluate(() => ((window as unknown as { fbq?: { queue: unknown[][] } }).fbq?.queue ?? []).map((a) => Array.from(a)));

  /** Chamadas `fbq("track", ...)` feitas pela página (eventos do Pixel no navegador). */
  const pixelTracks = (page: Page) =>
    page.evaluate(() =>
      ((window as unknown as { fbq?: { queue: unknown[][] } }).fbq?.queue ?? [])
        .map((a) => Array.from(a))
        .filter((a) => a[0] === "track")
        .map((a) => ({ event: a[1] as string, params: a[2] as Record<string, unknown> | undefined, eventId: (a[3] as { eventID?: string } | undefined)?.eventID })),
    );
  type MetaEvent = { event_name: string; event_id: string; custom_data: { value: number; currency: string } };
  const metaEvents = async (request: APIRequestContext) =>
    ((await (await request.get(`${asaasBase}/__control/meta`)).json()) as { events: { pixelId: string; event: MetaEvent }[] }).events;

  async function fillBuyer(page: Page, tag: string) {
    await page.getByLabel("Nome completo").fill("Maria Aparecida Souza");
    await page.getByLabel("E-mail", { exact: true }).fill(buyerEmail(tag));
    await page.getByLabel("WhatsApp").fill("11987654321");
  }

  test("página de vendas com t.js (utm_source=ig, ref=joao) -> Pix manual com bump: valor único, dono libera, obrigado, Pixel e CAPI com o mesmo event id", async ({ page, request, baseURL }) => {
    // Página de vendas externa (outra origem: o servidor falso do verify) com o trecho do t.js e um link para o checkout.
    const app = new URL(baseURL!).origin;
    await page.goto(`${asaasBase}/__vendas?app=${encodeURIComponent(app)}&slug=mana-basica&utm_source=ig&utm_campaign=stories&ref=joao`);
    await expect(page.locator("#comprar")).toHaveAttribute("href", /utm_source=ig.*ref=joao.*ft=/);
    await page.locator("#comprar").click();
    await expect(page).toHaveURL(/\/c\/mana-basica\?.*utm_source=ig/);
    await expect(page.getByRole("heading", { name: "Seus dados" })).toBeVisible();
    // Pixel no navegador: PageView + InitiateCheckout com o eventID que vai em checkout.start.
    await expect.poll(async () => (await pixelTracks(page)).map((t) => t.event)).toEqual(["PageView", "InitiateCheckout"]);
    // Sem coleta automática do Meta na página de pagamento: autoConfig desligado ANTES do init.
    expect((await pixelQueue(page)).slice(0, 2)).toEqual([
      ["set", "autoConfig", false, PIXEL_ID],
      ["init", PIXEL_ID],
    ]);
    const initiate = (await pixelTracks(page)).find((t) => t.event === "InitiateCheckout")!;
    expect(initiate.eventId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByLabel("CPF")).toHaveCount(0); // Pix manual não pede CPF
    await fillBuyer(page, "manual");
    await shot(page, "01-checkout-pix-bump-desmarcado");
    await page.getByText("Quero a versão completa").click();
    await expect(page.getByTestId("total")).toHaveText("R$ 27,00");
    await shot(page, "02-checkout-pix-manual-bump-marcado");
    await page.getByRole("button", { name: "Gerar Pix de R$ 27,00" }).click();

    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    const amount = page.getByTestId("unique-amount");
    await expect(amount).toHaveText(/^R\$ 27,\d\d$/);
    expect(Number((await amount.textContent())!.replace(/\D/g, ""))).toBeGreaterThan(2700);
    await expect(page.getByText("o envio acontece depois que o pagamento for conferido", { exact: false })).toBeVisible();
    await shot(page, "06-pix-manual-valor-unico");

    const publicId = new URL(page.url()).pathname.split("/").pop()!;
    manualPublicId = publicId;
    // O dono confere no painel: valor único em destaque, aviso do extrato e a liberação com dupla confirmação (P06, P07).
    await openOrder(owner, publicId, buyerEmail("manual"));
    await expect(owner.getByText("Confira no extrato do banco. Nunca libere por comprovante enviado pelo comprador.")).toBeVisible();
    await expect(owner.getByTestId("panel-unique-amount")).toHaveText((await amount.textContent())!.trim());
    await shot(owner, "p06-pedido-pix-manual-1280");
    await owner.getByRole("button", { name: "Liberar pedido" }).click();
    const release = owner.getByRole("dialog", { name: `Liberar o pedido #${codeOf(publicId)}?` });
    const confirmRelease = release.getByRole("button", { name: "Liberar e enviar acesso" });
    await expect(confirmRelease).toBeDisabled();
    await release.getByRole("checkbox", { name: /Vi um Pix de R\$ 27,\d\d no extrato/ }).check();
    await expect(confirmRelease).toBeDisabled(); // as duas confirmações são obrigatórias
    await release.getByRole("checkbox", { name: "Não estou liberando com base em comprovante enviado pelo comprador." }).check();
    await shot(owner, "p07-dialogo-liberar-1280");
    await confirmRelease.click();
    await expect(owner.getByText("Pedido liberado. O acesso vai para o e-mail do comprador agora.")).toBeVisible();
    await expect(owner.getByRole("button", { name: "Liberar pedido" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Enviamos o acesso para seu e-mail")).toBeVisible();
    await expect(page.getByText(buyerEmail("manual"))).toHaveCount(0);
    await shot(page, "07-obrigado-pix-manual");

    // Eventos do navegador só com moeda/valor/método: nada do formulário (nome, e-mail, celular).
    for (const t of await pixelTracks(page)) {
      for (const k of Object.keys(t.params ?? {})) expect(["currency", "value", "payment_type"]).toContain(k);
    }
    expect(JSON.stringify(await pixelQueue(page))).not.toMatch(/Maria|comprador\.|98765/);

    // Origem gravada no pedido: último toque utm_source=ig e indicação joao (vindos da página de vendas pelo t.js).
    const attribution = await asOwner<{ firstTouch: Record<string, string>; lastTouch: Record<string, string>; ref: string }>("/api/test-only/attribution", {
      json: { publicId },
    });
    expect(attribution.lastTouch).toEqual({ utm_source: "ig", utm_campaign: "stories" });
    expect(attribution.firstTouch).toEqual({ utm_source: "ig", utm_campaign: "stories", ref: "joao" });
    expect(attribution.ref).toBe("joao");

    // Purchase no navegador (uma vez) e na API de Conversões falsa, com o mesmo event id purchase:<publicId>; valor 27.
    await expect.poll(async () => (await pixelTracks(page)).filter((t) => t.event === "Purchase")).toEqual([
      { event: "Purchase", params: { currency: "BRL", value: 27 }, eventId: `purchase:${publicId}` },
    ]);
    await expect
      .poll(async () => (await metaEvents(request)).filter((e) => e.event.event_id === `purchase:${publicId}`).length, { timeout: 20_000 })
      .toBe(1);
    const server = await metaEvents(request);
    const purchase = server.find((e) => e.event.event_id === `purchase:${publicId}`)!;
    expect(purchase.pixelId).toBe(PIXEL_ID);
    expect(purchase.event.event_name).toBe("Purchase");
    expect(purchase.event.custom_data).toMatchObject({ currency: "BRL", value: 27 });
    const ic = server.filter((e) => e.event.event_id === initiate.eventId);
    expect(ic.map((e) => e.event.event_name)).toEqual(["InitiateCheckout"]);
  });

  // Task 12: o e-mail de entrega chega pelo SMTP da loja (Mailpit), o link serve o PDF carimbado como anexo, o 6º download
  // e o link de um pedido reembolsado mostram a página 410.
  test("entrega por e-mail: 2 links (com bump), GET/HEAD não contam, botão baixa o PDF, 6º download 410, reembolso revoga", async ({ page, request }) => {
    expect(manualPublicId).not.toBe("");
    const MAILPIT = "http://127.0.0.1:8025/api/v1";
    const to = buyerEmail("manual");
    type Found = { messages: { ID: string; Subject: string }[] };
    const search = async () =>
      ((await (await request.get(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as Found).messages;
    await expect.poll(async () => (await search()).length, { timeout: 30_000 }).toBeGreaterThan(0);
    const [found] = await search();
    expect(found!.Subject).toBe("Seu acesso: Maná bíblico · versão básica");
    const msg = (await (await request.get(`${MAILPIT}/message/${found!.ID}`)).json()) as { HTML: string; Text: string };
    const links = [...new Set([...msg.Text.matchAll(/https?:\/\/\S+\/d\/[A-Za-z0-9_-]{43}/g)].map((m) => m[0]))];
    expect(links).toHaveLength(2);
    expect(msg.HTML).toContain("Baixar PDF");
    await page.setViewportSize({ width: 640, height: 900 });
    await page.setContent(msg.HTML);
    await shot(page, "10-email-entrega-com-bump");

    // Abrir o link (GET) e HEAD não contam download (robôs de e-mail): a página mostra o botão.
    await page.setViewportSize({ width: 375, height: 812 });
    for (let i = 0; i < 3; i++) expect((await request.head(links[0]!)).status()).toBe(200);
    const ready = await page.goto(links[0]!);
    expect(ready?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Seu PDF está pronto" })).toBeVisible();
    expect(await page.evaluate(() => "fbq" in window)).toBe(false); // sem Pixel (nem terceiros) na página de download
    await expect(page.getByText("5 de 5")).toBeVisible();
    await shot(page, "11a-link-download-pdf-pronto");
    await page.reload();
    await expect(page.getByText("5 de 5")).toBeVisible();

    // O botão "Baixar PDF" faz o POST que conta: o navegador recebe o PDF carimbado como anexo.
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar PDF" }).click()]);
    expect(dl.suggestedFilename()).toBe("mana.pdf");
    const saved = readFileSync((await dl.path())!);
    expect(saved.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);

    const origin = new URL(links[0]!).origin;
    for (let i = 2; i <= 5; i++) {
      const res = await request.post(links[0]!, { headers: { origin } });
      expect(res.status(), `download ${i}`).toBe(200);
      expect(res.headers()["content-type"]).toBe("application/pdf");
      expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="mana\.pdf"/);
      expect(res.headers()["cache-control"]).toBe("private, no-store");
    }
    expect((await request.post(links[0]!, { headers: { origin } })).status()).toBe(410); // 6º download
    const sixth = await page.goto(links[0]!);
    expect(sixth?.status()).toBe(410);
    await expect(page.getByRole("heading", { name: "Este link de download expirou" })).toBeVisible();
    await shot(page, "11-link-download-expirado");

    // Pelo painel: reenviar o acesso e depois reembolsar (Pix manual: só marca; o link é revogado).
    await openOrder(owner, manualPublicId, to);
    await owner.getByRole("button", { name: "Reenviar acesso" }).click();
    await owner.getByRole("dialog", { name: "Reenviar o acesso?" }).getByRole("button", { name: "Reenviar acesso" }).click();
    await expect(owner.getByText("Acesso reenviado. O e-mail sai em instantes.")).toBeVisible();
    await expect.poll(async () => (await search()).length, { timeout: 30_000 }).toBeGreaterThan(1);
    await owner.getByRole("button", { name: "Reembolsar" }).click();
    const refund = owner.getByRole("dialog", { name: "Reembolsar R$ 27,00 para Maria Aparecida Souza?" });
    await expect(refund.getByText("devolva o valor ao comprador pelo seu banco", { exact: false })).toBeVisible();
    await shot(owner, "p08-dialogo-reembolsar-1280");
    await refund.getByRole("button", { name: "Reembolsar R$ 27,00" }).click();
    await expect(owner.getByText("Pedido marcado como reembolsado.", { exact: false })).toBeVisible();
    await expect.poll(async () => (await request.get(links[1]!)).status(), { timeout: 20_000 }).toBe(410);
    expect((await request.post(links[1]!, { headers: { origin } })).status()).toBe(410);
  });

  // Com CARD_ISOLATED=1 o app grava a chave do Asaas em `a1.` (ASAAS_SEAL_KEY, conferido no banco) e precisa abri-la para
  // gerar o Pix; os testes de cartão abaixo usam a mesma conexão pelo serviço de cartão, que não tem o SECRET.
  test("Pix do Asaas com o cartão isolado ligado: QR e copia e cola, pagamento no Asaas falso, vira obrigado", async ({ page, context, request }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const csp = (await request.get("/c/mana-auto")).headers()["content-security-policy"] ?? "";
    expect(csp).toContain(`frame-src ${CARD_ORIGIN}`); // checkout no modo isolado
    // A chave do Asaas que o painel salvou está selada com a ASAAS_SEAL_KEY (`a1.`), não com o SECRET (`v1.`).
    expect(OWNER_DB, "o verify passa E2E_OWNER_DATABASE_URL").not.toBe("");
    const sql = postgres(OWNER_DB, { max: 1 });
    try {
      const rows = await sql<{ secret: string | null }[]>`select secret from integration where kind = 'asaas'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.secret?.slice(0, 3)).toBe("a1.");
    } finally {
      await sql.end();
    }
    await page.goto("/c/mana-auto");
    await fillBuyer(page, "asaas");
    await page.getByLabel("CPF").fill("52998224725");
    await page.getByRole("button", { name: "Gerar Pix de R$ 9,90" }).click();

    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    await expect(page.getByText("Aguardando pagamento")).toBeVisible();
    const code = (await page.getByTestId("pix-code").textContent())!.trim();
    expect(code.startsWith("00020126")).toBe(true);
    await page.getByRole("button", { name: "Copiar código Pix" }).click();
    await expect(page.getByRole("button", { name: "Código copiado!" })).toBeVisible();
    await shot(page, "05-pix-asaas-aguardando-copiado");

    // O payload do falso termina no id da cobrança: paga pelo endpoint de controle (que manda o webhook ao app).
    const paymentId = code.replace(/^00020126fake/, "");
    const paid = await request.post(`${asaasBase}/__control/pay/${paymentId}`, { data: { callbackUrl: webhook.url, token: webhook.token } });
    expect(((await paid.json()) as { webhookStatus: number }).webhookStatus).toBe(200);
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible({ timeout: 15_000 });
    await shot(page, "07b-obrigado-pix-asaas");

    // Reembolso pelo painel: o estorno no Asaas é assíncrono; a tela mostra "estorno solicitado".
    asaasPublicId = new URL(page.url()).pathname.split("/").pop()!;
    await openOrder(owner, asaasPublicId, buyerEmail("asaas"));
    await expect(owner.getByText("CPF ***.982.247-**")).toBeVisible(); // CPF só mascarado
    await owner.getByRole("button", { name: "Reembolsar" }).click();
    await owner.getByRole("dialog", { name: "Reembolsar R$ 9,90 para Maria Aparecida Souza?" }).getByRole("button", { name: "Reembolsar R$ 9,90" }).click();
    await expect(owner.getByText("Estorno solicitado. O pedido muda para reembolsado assim que o Asaas confirmar.")).toBeVisible();
    await expect(owner.getByRole("button", { name: "Reembolsar" })).toHaveCount(0);
    await shot(owner, "p06c-pedido-estorno-solicitado-1280");
  });

  // ---- Cartão isolado (CARD_ISOLATED=1): os dados do cartão só existem no iframe do serviço (CARD_ORIGIN). ----
  // Cada teste usa um número próprio: o serviço limita 3 tentativas por cartão por hora (LIMITS.card) e 5 por e-mail.
  // Números e CVVs só desta lista: o verify confere que nenhum aparece no log do app nem no do serviço (E2E_CARDS e
  // E2E_CVVS em scripts/verify.sh).
  const CARDS = {
    vista: "4111 1111 1111 1111",
    parcelado: "5555 5555 5555 4444",
    recusado: "5184 0197 4037 3151", // DECLINED_CARDS do Asaas falso
    outro: "4444 4444 4444 4444",
    isolado: "4012 8888 8888 1881",
  };
  const FRAME = 'iframe[title="Dados do cartão"]';
  const cardFrame = (page: Page) => page.frameLocator(FRAME);

  async function fillCard(page: Page, c: { number: string; holder: string; expiry: string; cvv: string; installments?: number }) {
    const f = cardFrame(page);
    await f.getByLabel("Número do cartão").fill(c.number);
    await f.getByLabel("Nome impresso no cartão").fill(c.holder);
    await f.getByLabel("Validade").fill(c.expiry);
    await f.getByLabel("CVV").fill(c.cvv);
    await f.getByLabel("CEP").fill("01310100");
    await f.getByLabel("Número", { exact: true }).fill("100");
    if (c.installments) await f.getByLabel("Parcelas").selectOption(String(c.installments));
  }

  /** Altura aplicada ao iframe pelo app (mensagem `height`) e altura do conteúdo dentro dele. */
  async function frameHeights(page: Page) {
    const applied = await page.locator(FRAME).evaluate((el) => (el as HTMLIFrameElement).getBoundingClientRect().height);
    const frame = page.frames().find((f) => f.url().startsWith(`${CARD_ORIGIN}/form/`));
    const content = frame ? await frame.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height)) : -1;
    return { applied: Math.round(applied), content };
  }

  /** Inputs de cartão no documento do app (frame principal): devem ser zero com o cartão isolado. */
  const cardInputsInMainFrame = (page: Page) =>
    page.mainFrame().evaluate(
      () =>
        document.querySelectorAll(
          'input[autocomplete^="cc-"], #cardNumber, #holderName, #expiry, #cvv, #holderCpf, #cep, #addressNumber, #installments, [name*="card" i], [name*="cvv" i], [name*="ccv" i]',
        ).length,
    );

  test("cartão pelo iframe: erros de validação dos dois lados, depois à vista aprovado -> obrigado", async ({ page }) => {
    await page.goto("/c/mana-basica?metodo=cartao");
    await expect(cardFrame(page).getByLabel("Número do cartão")).toBeVisible();
    expect(await cardInputsInMainFrame(page)).toBe(0);
    await fillBuyer(page, "cartao");
    await page.getByLabel("CPF", { exact: true }).fill("12345678900");
    await fillCard(page, { number: CARDS.vista, holder: "MARIA A SOUZA", expiry: "08/24", cvv: "582" });
    await page.getByRole("button", { name: "Pagar R$ 9,90" }).click();
    // A contagem soma os dois lados: CPF no app e validade vencida no iframe (cada um marca os seus).
    await expect(page.getByText("Confira os 2 campos marcados para continuar.")).toBeVisible();
    await expect(page.getByText("CPF inválido. Confira os 11 números.")).toBeVisible();
    await expect(cardFrame(page).getByLabel("Validade")).toHaveAttribute("aria-invalid", "true");
    await expect(cardFrame(page).getByLabel("Número do cartão")).not.toHaveAttribute("aria-invalid", "true");
    await shot(page, "03-cartao-erros-de-validacao");

    await page.getByLabel("CPF", { exact: true }).fill("52998224725");
    await cardFrame(page).getByLabel("Validade").fill("12/34");
    await page.getByRole("button", { name: "Pagar R$ 9,90" }).click();
    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();
    await expect(page.getByText("Total pago com cartão")).toBeVisible();
    await shot(page, "07c-obrigado-cartao");
  });

  test("cartão pelo iframe: parcelado em 3x com o bump, parcelas com o total novo, aprovado", async ({ page, request }) => {
    await page.goto("/c/mana-basica?metodo=cartao");
    await fillBuyer(page, "parcelado");
    await page.getByLabel("CPF", { exact: true }).fill("52998224725");
    const parcelas = cardFrame(page).getByLabel("Parcelas");
    await expect(parcelas.locator("option")).toHaveText(["1x de R$ 9,90 sem juros", "2x (total R$ 9,90)", "3x (total R$ 9,90)"]);
    // Bump ligado depois de o iframe carregar: o seletor do iframe passa a mostrar o total novo.
    await page.getByText("Quero a versão completa").click();
    await expect(page.getByTestId("total")).toHaveText("R$ 27,00");
    await expect(parcelas.locator("option")).toHaveText(["1x de R$ 27,00 sem juros", "2x (total R$ 27,00)", "3x (total R$ 27,00)"]);
    await fillCard(page, { number: CARDS.parcelado, holder: "MARIA A SOUZA", expiry: "12/34", cvv: "604", installments: 3 });
    await shot(page, "03b-cartao-parcelado-3x");
    await page.getByRole("button", { name: "Pagar R$ 27,00" }).click();
    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();

    // No Asaas falso: um parcelamento de 3 cobranças de R$ 9,00 (R$ 27,00) no cartão.
    const { apiKey } = (await (await request.get(`${asaasBase}/__control/key`)).json()) as { apiKey: string };
    type P = { installment?: string; installmentNumber?: number; value: number; billingType: string };
    const list = (await (await request.get(`${asaasBase}/payments`, { headers: { access_token: apiKey } })).json()) as { data: P[] };
    const parcels = list.data.filter((p) => p.installment !== undefined && p.billingType === "CREDIT_CARD");
    expect(parcels.map((p) => [p.installmentNumber, p.value])).toEqual([
      [1, 9],
      [2, 9],
      [3, 9],
    ]);
  });

  test("cartão recusado pelo iframe: mensagem clara, nada cobrado, e 'Tentar outro cartão' paga o mesmo pedido", async ({ page }) => {
    // Corpo dos POST /api/card (do iframe ao serviço de cartão): o pedido de cada tentativa.
    const cardPosts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url() === `${CARD_ORIGIN}/api/card`) {
        cardPosts.push((JSON.parse(r.postData() ?? "{}") as { orderPublicId?: string }).orderPublicId ?? "");
      }
    });
    await page.goto("/c/mana-basica?metodo=cartao");
    await fillBuyer(page, "recusa");
    await page.getByLabel("CPF", { exact: true }).fill("52998224725");
    await fillCard(page, { number: CARDS.recusado, holder: "MARIA A SOUZA", expiry: "12/34", cvv: "739" });
    await page.getByRole("button", { name: "Pagar R$ 9,90" }).click();
    await expect(page.getByRole("heading", { name: "Pagamento não aprovado" })).toBeVisible();
    await expect(page.getByText("Nenhum valor foi cobrado.")).toBeVisible();
    await expect(page.getByText("3151")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pagar R$ 9,90 com Pix" })).toBeVisible();
    await shot(page, "08-cartao-recusado");
    expect(cardPosts).toHaveLength(1);

    await page.getByRole("button", { name: "Tentar outro cartão" }).click();
    // Iframe remontado: formulário limpo.
    await expect(cardFrame(page).getByLabel("Número do cartão")).toHaveValue("");
    await fillCard(page, { number: CARDS.outro, holder: "MARIA A SOUZA", expiry: "12/34", cvv: "321" });
    await page.getByRole("button", { name: "Pagar R$ 9,90" }).click();
    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();
    const paidId = new URL(page.url()).pathname.split("/").pop()!;
    expect(cardPosts).toEqual([paidId, paidId]); // o mesmo pedido, sem criar outro
  });

  test("o app principal não recebe o cartão: nada do número, CVV ou validade em URL, cabeçalho, corpo ou postMessage", async ({ page, baseURL }) => {
    const app = new URL(baseURL!).origin;
    const number = CARDS.isolado;
    const cvv = "737";
    const expiry = "07/33";
    // Mensagens que chegam ao documento do app (postMessage do iframe), gravadas desde o início da página.
    await page.addInitScript(() => {
      if (window.top !== window) return;
      const w = window as unknown as { __appMsgs: string[] };
      w.__appMsgs = [];
      window.addEventListener("message", (e) => w.__appMsgs.push(JSON.stringify(e.data)));
    });
    const toApp: Promise<{ url: string; headers: Record<string, string>; body: string }>[] = [];
    const toCard: string[] = [];
    page.on("request", (r) => {
      const origin = new URL(r.url()).origin;
      if (origin === app) toApp.push(r.allHeaders().then((headers) => ({ url: r.url(), headers, body: r.postData() ?? "" })));
      if (origin === CARD_ORIGIN && r.method() === "POST") toCard.push(r.postData() ?? "");
    });

    await page.goto("/c/mana-basica?metodo=cartao");
    await fillBuyer(page, "isolado");
    await page.getByLabel("CPF", { exact: true }).fill("52998224725");
    await fillCard(page, { number, holder: "JOANA T CARTAO", expiry, cvv });
    expect(await cardInputsInMainFrame(page)).toBe(0);
    await page.getByRole("button", { name: "Pagar R$ 9,90" }).click();
    await expect(page).toHaveURL(/\/o\/[\w-]+$/);
    await expect(page.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();
    expect(await cardInputsInMainFrame(page)).toBe(0);
    expect(toCard).toHaveLength(1); // o cartão foi, sim, ao serviço isolado

    const requests = await Promise.all(toApp);
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.some((r) => r.body.length > 0)).toBe(true); // houve server actions com corpo (pedido)
    const messages = (await page.evaluate(() => (window as unknown as { __appMsgs?: string[] }).__appMsgs ?? [])) as string[];
    const leaks = cardLeaks({ number, holder: "JOANA T CARTAO", expiry, cvv });
    // Controle positivo: no POST ao serviço de cartão o detector acha tudo (prova que a busca abaixo enxergaria).
    expect(leaks(toCard[0]!)).toEqual(["CVV", "nome impresso", "número", "validade"]);
    for (const r of requests) {
      expect(leaks(r.url), `URL ${r.url}`).toEqual([]);
      expect(leaks(JSON.stringify(r.headers)), `cabeçalhos de ${r.url}`).toEqual([]);
      expect(leaks(r.body), `corpo de ${r.url}`).toEqual([]);
    }
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) expect(leaks(m), `postMessage ${m}`).toEqual([]);
  });

  test("oferta que abre em Pix e troca para Cartão: iframe com altura certa e campos visíveis", async ({ page }) => {
    await page.goto("/c/mana-basica");
    await expect(page.getByRole("button", { name: "Gerar Pix de R$ 9,90" })).toBeVisible();
    await expect(page.locator(FRAME)).toBeHidden(); // carregado escondido (Pix selecionado)
    await page.getByText("Cartão", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Pagar R$ 9,90" })).toBeEnabled();
    const f = cardFrame(page);
    for (const label of ["Número do cartão", "Nome impresso no cartão", "Validade", "CVV", "CEP"]) await expect(f.getByLabel(label)).toBeVisible();
    await expect(f.getByLabel("Número", { exact: true })).toBeVisible();
    // Altura do iframe = altura do conteúdo (nada cortado nem sobrando) e maior que zero.
    await expect.poll(async () => (await frameHeights(page)).content).toBeGreaterThan(200);
    await expect.poll(async () => { const h = await frameHeights(page); return h.applied - h.content; }).toBe(0);
    // O último campo (CEP/Número) cabe na área visível do iframe.
    const frameBox = (await page.locator(FRAME).boundingBox())!;
    const cepBox = (await f.getByLabel("CEP").boundingBox())!;
    expect(cepBox.y + cepBox.height).toBeLessThanOrEqual(frameBox.y + frameBox.height);
    await shot(page, "03c-pix-para-cartao-iframe");
  });

  test("iframe indisponível: em até 10 s o aviso aparece, Pagar fica desabilitado e nenhum pedido é criado", async ({ page }) => {
    const NOTICE = "Pagamento com cartão indisponível agora. Tente de novo em instantes ou pague com Pix.";
    // Medido na própria página (performance.now em um MutationObserver): da criação do iframe ao aviso no DOM.
    await page.addInitScript((msg) => {
      if (window.top !== window) return;
      const w = window as unknown as { __frameAt?: number; __noticeAt?: number };
      new MutationObserver(() => {
        const now = performance.now();
        if (w.__frameAt === undefined && document.querySelector('iframe[title="Dados do cartão"]')) w.__frameAt = now;
        if (w.__noticeAt === undefined && document.body?.textContent?.includes(msg)) w.__noticeAt = now;
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, NOTICE);
    // Serviço de cartão inacessível para esta página: a carga do iframe falha na rede.
    let blocked = 0;
    await page.route(`${CARD_ORIGIN}/**`, (r) => {
      blocked++;
      return r.abort("connectionrefused");
    });
    await page.goto("/c/mana-basica?metodo=cartao");
    await fillBuyer(page, "indisponivel");
    await page.getByLabel("CPF", { exact: true }).fill("52998224725");
    const notice = page.getByText(NOTICE);
    await expect(notice).toBeVisible({ timeout: 15_000 });
    expect(blocked).toBeGreaterThan(0);
    const t = await page.evaluate(() => {
      const w = window as unknown as { __frameAt?: number; __noticeAt?: number };
      return { frameAt: w.__frameAt ?? -1, noticeAt: w.__noticeAt ?? -1 };
    });
    expect(t.frameAt).toBeGreaterThan(0);
    expect(t.noticeAt).toBeGreaterThan(t.frameAt);
    // 10 s do controlador (FRAME_READY_TIMEOUT_MS) mais a renderização do React.
    expect(t.noticeAt - t.frameAt).toBeLessThanOrEqual(10_500);
    await expect(page.locator(FRAME)).toBeHidden();
    const pay = page.getByRole("button", { name: "Pagar R$ 9,90" });
    await expect(pay).toBeDisabled();
    await shot(page, "08b-cartao-indisponivel");
    // Mesmo um envio forçado do formulário não cria pedido.
    await page.locator("form").first().evaluate((f) => (f as HTMLFormElement).requestSubmit());
    await expect(notice).toHaveCount(1);
    await expect(page).toHaveURL(/\/c\/mana-basica\?metodo=cartao$/);
    // O Pix continua disponível.
    await page.getByText("Pix", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Gerar Pix de R$ 9,90" })).toBeEnabled();
    await owner.goto(`/admin/orders?q=${encodeURIComponent(buyerEmail("indisponivel"))}`);
    await expect(owner.getByText("0 pedidos com estes filtros")).toBeVisible();
  });

  test("sem JavaScript: nenhum campo de cartão no app e enviar o formulário não põe dados na URL", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await page.goto("/c/mana-basica?metodo=cartao");
    // O iframe é criado pelo JavaScript do checkout: sem ele, não há iframe nem campo de cartão algum.
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(await cardInputsInMainFrame(page)).toBe(0);
    // Nenhum campo com `name` (só o rádio do método) e form POST: nem um envio nativo levaria dados.
    expect(await page.locator("form [name]:not([name=method])").count()).toBe(0);
    await expect(page.locator("form")).toHaveAttribute("method", "post");
    await page.getByLabel("CPF", { exact: true }).fill("52998224725");
    await expect(page.getByRole("button", { name: /Pagar/ })).toBeDisabled();
    await page.getByLabel("CPF", { exact: true }).press("Enter");
    await page.waitForLoadState();
    expect(page.url()).not.toMatch(/52998224725/);
    expect(new URL(page.url()).search).toBe("?metodo=cartao");
    await ctx.close();
  });

  test("checkout no desktop (1280) em duas colunas", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 870 });
    await page.goto("/c/mana-basica");
    await expect(page.getByRole("heading", { name: "Maná bíblico para crianças", level: 1 })).toBeVisible();
    await shot(page, "04-checkout-desktop-1280");
  });

  test("HTML real do checkout e do pedido: só scripts do inventário e todo inline com o nonce (o que o monitor semanal confere)", async ({ request }) => {
    for (const path of ["/c/mana-basica", `/o/${manualPublicId}`]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      const nonce = /'nonce-([^']+)'/.exec(res.headers()["content-security-policy"] ?? "")?.[1];
      expect(nonce, path).toBeTruthy();
      const tags = (await res.text()).match(/<script\b[^>]*>/gi) ?? [];
      expect(tags.length, path).toBeGreaterThan(0);
      for (const tag of tags) {
        const src = /\ssrc="([^"]*)"/.exec(tag)?.[1];
        const type = /\stype="([^"]*)"/.exec(tag)?.[1] ?? "";
        if (src !== undefined) {
          const u = new URL(src, "http://loja.local");
          expect(u.origin === "http://loja.local" ? u.pathname.startsWith("/_next/static/") : u.origin === "https://connect.facebook.net", `${path}: ${tag}`).toBe(true);
        } else if (!/json/.test(type)) {
          expect(/\snonce="([^"]*)"/.exec(tag)?.[1], `${path}: ${tag}`).toBe(nonce);
        }
      }
    }
  });

  test("painel: CSV sem CPF; membro support não vê Reembolsar, Liberar, conexões nem exportação", async ({ browser }) => {
    const res = await owner.evaluate(async () => {
      const r = await fetch("/admin/orders.csv");
      return { type: r.headers.get("content-type"), disposition: r.headers.get("content-disposition"), csv: await r.text() };
    });
    expect(res.type).toBe("text/csv; charset=utf-8");
    expect(res.disposition).toMatch(/^attachment; filename="pedidos-\d{4}-\d{2}-\d{2}\.csv"$/);
    const csv = res.csv;
    expect(csv.split("\r\n")[0]).toBe('"data";"status";"método";"produto(s)";"valor";"nome";"e-mail";"telefone";"utm_source";"utm_campaign";"ref"');
    expect(csv).toContain(buyerEmail("cartao"));
    expect(csv).not.toContain("52998224725");

    await asOwner("/api/test-only/member", { json: { ...SUPPORT, role: "support", name: "Ana Atendimento" } });
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const sp = await ctx.newPage();
    await sp.goto("/admin/login");
    await sp.getByLabel("E-mail").fill(SUPPORT.email);
    await sp.getByLabel("Senha").fill(SUPPORT.password);
    await sp.getByRole("button", { name: "Entrar" }).click();
    await expect(sp).toHaveURL(/\/admin\/orders$/); // sem métricas: cai em Pedidos
    await expect(sp.getByRole("link", { name: "Conexões" })).toHaveCount(0);
    await expect(sp.getByRole("link", { name: "Exportar CSV" })).toHaveCount(0);
    await sp.goto(`/admin/orders?q=${encodeURIComponent(buyerEmail("cartao"))}`);
    await sp.locator("table a").first().click();
    await expect(sp.getByRole("heading", { name: /^Pedido #/ })).toBeVisible();
    await expect(sp.getByRole("button", { name: "Reenviar acesso" })).toBeVisible();
    await expect(sp.getByRole("button", { name: "Reembolsar" })).toHaveCount(0);
    await expect(sp.getByRole("button", { name: "Liberar pedido" })).toHaveCount(0);
    await sp.setViewportSize(MOBILE);
    await shot(sp, "p10b-pedido-support-390");
    expect((await sp.request.get("/admin/orders.csv")).status()).toBe(403);

    // Trocar senha (exige a atual) e o dono encerra as sessões do membro.
    const NEW_SUPPORT_PASSWORD = "senha-suporte-nova-456";
    await sp.goto("/admin/senha");
    await sp.getByLabel("Senha atual").fill("senha-errada-000");
    await sp.getByLabel("Senha nova (mínimo 10 caracteres)").fill(NEW_SUPPORT_PASSWORD);
    await sp.getByLabel("Repita a senha nova").fill(NEW_SUPPORT_PASSWORD);
    await sp.getByRole("button", { name: "Trocar senha" }).click();
    await expect(sp.getByText("A senha atual não confere.")).toBeVisible();
    await sp.getByLabel("Senha atual").fill(SUPPORT.password);
    await sp.getByLabel("Senha nova (mínimo 10 caracteres)").fill(NEW_SUPPORT_PASSWORD);
    await sp.getByLabel("Repita a senha nova").fill(NEW_SUPPORT_PASSWORD);
    await sp.getByRole("button", { name: "Trocar senha" }).click();
    await expect(sp.getByText("Senha trocada.")).toBeVisible();
    await sp.goto("/admin/orders");
    await expect(sp).toHaveURL(/\/admin\/orders$/); // esta sessão foi renovada e segue valendo

    await owner.goto("/admin/settings");
    const team = owner.getByRole("region", { name: "Equipe" });
    const member = team.locator("div", { hasText: SUPPORT.email }).last();
    await expect(member.getByText("1 sessão ativa")).toBeVisible();
    await member.getByRole("button", { name: "Encerrar sessões" }).click();
    await owner.getByRole("dialog", { name: /Encerrar as sessões de/ }).getByRole("button", { name: "Encerrar sessões" }).click();
    await expect(team.getByText("1 sessão encerrada.")).toBeVisible();
    await sp.goto("/admin/orders");
    await expect(sp).toHaveURL(/\/admin\/login$/);
    await sp.getByLabel("E-mail").fill(SUPPORT.email);
    await sp.getByLabel("Senha").fill(NEW_SUPPORT_PASSWORD);
    await sp.getByRole("button", { name: "Entrar" }).click();
    await expect(sp).toHaveURL(/\/admin\/orders$/);
    await ctx.close();
  });

  test("painel: telas no desktop (1280) e no celular (390, tema escuro)", async ({ browser }) => {
    await owner.goto("/admin");
    await expect(owner.getByRole("heading", { name: "Visão geral" })).toBeVisible();
    await expect(owner.getByText("Por origem")).toBeVisible();
    await shot(owner, "p03-visao-geral-1280");
    await owner.goto("/admin?periodo=30d");
    await shot(owner, "p03b-visao-geral-30-dias-1280");
    await owner.goto("/admin/orders");
    await shot(owner, "p05-pedidos-1280");
    await openOrder(owner, manualPublicId, buyerEmail("manual"));
    await shot(owner, "p06b-pedido-reembolsado-1280");

    const state = await owner.context().storageState();
    const dark = await browser.newContext({ viewport: MOBILE, colorScheme: "dark", storageState: state });
    const m = await dark.newPage();
    await m.goto("/admin");
    await expect(m.getByRole("heading", { name: "Visão geral" })).toBeVisible();
    await shot(m, "p09-visao-geral-390-escuro");
    await m.goto("/admin/orders");
    await shot(m, "p05c-pedidos-390-escuro");
    await dark.close();
    const light = await browser.newContext({ viewport: MOBILE, storageState: state });
    const l = await light.newPage();
    await openOrder(l, asaasPublicId, buyerEmail("asaas"));
    await shot(l, "p10-pedido-390");
    // Todas as telas do painel a 390 px: fundo de uma cor só (sem a coluna da sidebar do desktop) e sem rolagem lateral.
    for (const [path, name] of [
      ["/admin", "p03c-visao-geral-390"],
      ["/admin/orders", "p05d-pedidos-390"],
      ["/admin/offers", "p11b-ofertas-390"],
      ["/admin/products", "p13b-produtos-390"],
      ["/admin/connections", "p14b-conexoes-390"],
      ["/admin/settings", "p15b-configuracoes-390"],
    ] as const) {
      await l.goto(path);
      const box = await l.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        width: window.innerWidth,
        bg: getComputedStyle(document.querySelector("main")!.parentElement!).backgroundImage,
      }));
      expect(box.scroll, path).toBeLessThanOrEqual(box.width);
      expect(box.bg, path).toBe("none");
      await shot(l, name);
    }
    await l.getByRole("link", { name: "Ofertas" }).first().click();
    await l.locator("a", { hasText: "Editar" }).first().click();
    await expect(l).toHaveURL(/\/admin\/offers\/[0-9a-f-]{36}$/);
    await expect(l.getByRole("heading", { name: "Maná bíblico para crianças", level: 1 })).toBeVisible();
    await shot(l, "p12c-oferta-editor-390");
    await l.getByRole("button", { name: "Mais" }).click();
    await expect(l.getByRole("link", { name: "Configurações" })).toBeVisible();
    await light.close();

    const anon = await browser.newContext({ viewport: DESKTOP });
    const a = await anon.newPage();
    await a.goto("/admin/login");
    await shot(a, "p01-login-1280");
    await anon.close();
  });
});
