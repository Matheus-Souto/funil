// Smoke de deploy: o fluxo mínimo de uma instalação nova, pela imagem Docker atrás do Caddy (HTTPS), como o dono e um
// comprador fariam: setup -> conexões (Pix manual, SMTP) -> produto com upload de um PDF de ~48 MB (perto do teto de
// 50 MB; validação no Worker de PDF) -> oferta -> checkout Pix manual -> dono libera -> e-mail -> download do PDF
// carimbado (Worker de PDF de novo). O tests/smoke.sh mede o pico de memória do container depois deste fluxo.
// Depois, o cartão isolado (COMPOSE_PROFILES=card): Asaas falso conectado pelo painel e compra com cartão pelo iframe
// servido pelo container `card` em CARD_ORIGIN (https://pagar.localhost:<porta>), tudo através do Caddy.
// Orquestrado por tests/smoke.sh (BASE_URL do Caddy, CARD_ORIGIN, MAILPIT_URL do Mailpit do smoke, SMOKE_OUT da execução).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, PDFName, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { cardLeaks, headersText } from "../../e2e/card-leaks";

// O teste do cartão usa a loja, o produto e o dono criados pelo primeiro: em série (o segundo não roda se o primeiro falhar).
test.describe.configure({ mode: "serial" });

const MAILPIT = `${process.env.MAILPIT_URL}/api/v1`;
const CARD_ORIGIN = process.env.CARD_ORIGIN ?? "";
const OUT = process.env.SMOKE_OUT ?? ".";
const OWNER = { email: "dono@exemplo.com", password: "senha-longa-123" };
const BUYER = `comprador.${Date.now()}@exemplo.com`;
const codeOf = (publicId: string) => publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
const MAX_PDF_BYTES = 52_428_800; // teto do upload (src/lib/catalog/products.ts)
const BIG_PAGES = 140;

/** PDF de e-book ilustrado: uma imagem por página (gradiente com ruído, comprime como ilustração). ~0,34 MB/página. */
async function illustratedPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const w = 900;
  const h = 1200;
  for (let p = 0; p < pages; p++) {
    const px = new Uint8Array(w * h * 3);
    let seed = p * 7919 + 1;
    for (let i = 0; i < w * h; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = seed % 64;
      px[i * 3] = ((i % w) / 4 + n) & 255;
      px[i * 3 + 1] = (Math.floor(i / w) / 5 + n) & 255;
      px[i * 3 + 2] = (p * 9 + n) & 255;
    }
    const img = doc.context.stream(deflateSync(px), {
      Type: "XObject",
      Subtype: "Image",
      Width: w,
      Height: h,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "FlateDecode",
    });
    const page = doc.addPage([595, 842]);
    const name = page.node.newXObject("Im", doc.context.register(img));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(495, 0, 0, 660, 50, 120), drawObject(PDFName.of(name.asString().slice(1))), popGraphicsState());
  }
  return doc.save();
}

test("instalação nova: setup, produto, oferta, Pix manual liberado e download do PDF carimbado", async ({ browser, request, baseURL }) => {
  const owner: Page = await browser.newPage();

  // Setup do modo single (primeiro acesso).
  await owner.goto("/admin");
  await expect(owner).toHaveURL(/\/admin\/setup$/);
  // Código impresso pelo entrypoint no log do container (tests/smoke.sh o repassa).
  await owner.getByLabel("Código de configuração").fill(process.env.SETUP_TOKEN ?? "");
  await owner.getByLabel("Nome da loja").fill("Loja Deploy");
  await owner.getByLabel("Seu nome").fill("Dono");
  await owner.getByLabel("E-mail").fill(OWNER.email);
  await owner.getByLabel("Senha (mínimo 10 caracteres)").fill(OWNER.password);
  await owner.getByRole("button", { name: "Criar loja" }).click();
  await expect(owner).toHaveURL(/\/admin$/);
  await expect(owner.getByRole("heading", { name: "Boas-vindas, Loja Deploy" })).toBeVisible();

  // Conexões: chave Pix manual e SMTP (Mailpit do smoke, na rede do compose).
  await owner.goto("/admin/connections");
  const pix = owner.locator("#pix-manual-card");
  await pix.getByLabel("Chave Pix").fill("contato@lojadeploy.com.br");
  await pix.getByLabel("Nome do recebedor").fill("Loja Deploy");
  await pix.getByLabel("Cidade").fill("Sao Paulo");
  await pix.getByRole("button", { name: "Salvar chave Pix" }).click();
  await owner.getByRole("dialog", { name: "Salvar esta chave Pix?" }).getByRole("button", { name: "Salvar chave" }).click();
  await expect(pix.getByText("Chave Pix salva.")).toBeVisible();
  const smtp = owner.locator("#smtp");
  await smtp.getByLabel("Servidor").fill("mailpit");
  await smtp.getByLabel("Porta", { exact: true }).fill("1025");
  await smtp.getByLabel("Remetente (e-mail)").fill("contato@lojadeploy.com.br");
  await smtp.getByRole("button", { name: "Testar e salvar" }).click();
  await owner.getByRole("dialog", { name: "Salvar o SMTP da loja?" }).getByRole("button", { name: "Testar e salvar" }).click();
  await expect(smtp.getByText("SMTP testado e salvo.")).toBeVisible();

  // Produto: PDF de ~48 MB (perto do teto) enviado pela rota de upload e validado no Worker de PDF (pdf-lib resolvido
  // dentro da imagem; heap do Worker limitado a 192 MB).
  const big = await illustratedPdf(BIG_PAGES);
  expect(big.byteLength).toBeGreaterThan(40 * 1024 * 1024);
  expect(big.byteLength).toBeLessThan(MAX_PDF_BYTES);
  const bigPath = join(OUT, "guia-grande.pdf");
  writeFileSync(bigPath, big);
  await owner.goto("/admin/products");
  await owner.getByLabel("Nome do produto").fill("Guia do deploy");
  await owner.getByLabel("Arquivo PDF do produto").setInputFiles(bigPath);
  await owner.getByRole("button", { name: "Criar produto" }).click();
  await expect(owner.getByText("Produto “Guia do deploy” criado.")).toBeVisible({ timeout: 60_000 });

  // Oferta com Pix manual (padrão do editor).
  await owner.goto("/admin/offers/nova");
  await owner.getByLabel("Nome da oferta").fill("Guia do deploy");
  await owner.getByLabel("Preço", { exact: true }).fill("9,90");
  await owner.getByLabel("Produto entregue").selectOption({ label: "Guia do deploy" });
  await owner.getByLabel("Endereço (slug)").fill("guia-deploy");
  await owner.getByRole("button", { name: "Criar oferta" }).click();
  await expect(owner.getByText("Oferta criada.")).toBeVisible();

  // Comprador: checkout Pix manual no celular.
  const buyer = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await buyer.goto("/c/guia-deploy");
  await buyer.getByLabel("Nome completo").fill("Maria Aparecida Souza");
  await buyer.getByLabel("E-mail", { exact: true }).fill(BUYER);
  await buyer.getByLabel("WhatsApp").fill("11987654321");
  await buyer.getByRole("button", { name: "Gerar Pix de R$ 9,90" }).click();
  await expect(buyer).toHaveURL(/\/o\/[\w-]+$/);
  await expect(buyer.getByTestId("unique-amount")).toHaveText(/^R\$ 9,\d\d$/);
  const publicId = new URL(buyer.url()).pathname.split("/").pop()!;

  // Dono libera pelo painel (duas confirmações).
  await owner.goto(`/admin/orders?q=${encodeURIComponent(BUYER)}`);
  await owner.getByRole("link", { name: `#${codeOf(publicId)}` }).click();
  await owner.getByRole("button", { name: "Liberar pedido" }).click();
  const release = owner.getByRole("dialog", { name: `Liberar o pedido #${codeOf(publicId)}?` });
  await release.getByRole("checkbox", { name: /Vi um Pix de R\$ 9,\d\d no extrato/ }).check();
  await release.getByRole("checkbox", { name: "Não estou liberando com base em comprovante enviado pelo comprador." }).check();
  await release.getByRole("button", { name: "Liberar e enviar acesso" }).click();
  await expect(owner.getByText("Pedido liberado. O acesso vai para o e-mail do comprador agora.")).toBeVisible();
  await expect(buyer.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible({ timeout: 15_000 });

  // E-mail de entrega (fila de jobs do app -> SMTP da loja) com o link de download na URL pública (BASE_URL).
  type Found = { messages: { ID: string }[] };
  const search = async () =>
    ((await (await request.get(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${BUYER}"`)}`)).json()) as Found).messages;
  await expect.poll(async () => (await search()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const [found] = await search();
  const msg = (await (await request.get(`${MAILPIT}/message/${found!.ID}`)).json()) as { Text: string };
  const link = /https:\/\/\S+\/d\/[A-Za-z0-9_-]{43}/.exec(msg.Text)?.[0];
  expect(link?.startsWith(`${baseURL}/d/`), `link no e-mail: ${link}`).toBe(true);

  // Download pelo botão (POST que conta): PDF carimbado no Worker de PDF dentro do container.
  await buyer.goto(link!);
  await expect(buyer.getByRole("heading", { name: "Seu PDF está pronto" })).toBeVisible();
  const [dl] = await Promise.all([buyer.waitForEvent("download", { timeout: 60_000 }), buyer.getByRole("button", { name: "Baixar PDF" }).click()]);
  const saved = readFileSync((await dl.path())!);
  expect(saved.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect((await PDFDocument.load(saved, { updateMetadata: false })).getPageCount()).toBe(BIG_PAGES);
  expect(saved.byteLength).toBeGreaterThan(big.byteLength); // carimbo acrescenta conteúdo

  // O smoke baixa de novo depois de recriar o container (volume /data e migração repetida).
  writeFileSync(join(OUT, "download-link.txt"), link!);
  await buyer.close();
  await owner.close();
});

test("cartão isolado pelo Caddy: Asaas (falso) conectado e compra com cartão pelo iframe do pagar.", async ({ browser, baseURL }) => {
  expect(CARD_ORIGIN).toMatch(/^https:\/\/pagar\.localhost:\d+$/);
  const owner: Page = await browser.newPage();
  await owner.goto("/admin/login");
  await owner.getByLabel("E-mail").fill(OWNER.email);
  await owner.getByLabel("Senha").fill(OWNER.password);
  await owner.getByRole("button", { name: "Entrar" }).click();
  await expect(owner).toHaveURL(/\/admin$/);

  // Asaas falso do smoke (127.0.0.1:4010 dentro do app e do card; tests/smoke.compose.yaml), conectado pelo painel.
  await owner.goto("/admin/connections");
  const asaas = owner.locator("#asaas");
  await asaas.getByLabel("Chave de API").fill("fake-asaas-key");
  await asaas.getByRole("button", { name: "Conectar Asaas" }).click();
  await owner.getByRole("dialog", { name: /^Conectar o Asaas em/ }).getByRole("button", { name: "Testar e salvar" }).click();
  await expect(asaas.getByText("Asaas conectado.")).toBeVisible();

  await owner.goto("/admin/offers/nova");
  await owner.getByLabel("Nome da oferta").fill("Guia do deploy no cartão");
  await owner.getByLabel("Preço", { exact: true }).fill("9,90");
  await owner.getByLabel("Produto entregue").selectOption({ label: "Guia do deploy" });
  await owner.getByLabel("Endereço (slug)").fill("guia-cartao");
  await owner.getByLabel("Cartão de crédito").check();
  await owner.getByRole("button", { name: "Criar oferta" }).click();
  await expect(owner.getByText("Oferta criada.")).toBeVisible();
  await owner.close();

  // Comprador no celular: o cartão vai só ao pagar. (nada com o número chega à origem do app).
  const buyer = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const app = new URL(baseURL!).origin;
  const testCard = { number: "4111 1111 1111 1111", holder: "MARIA A SOUZA", expiry: "09/31", cvv: "582" };
  const toApp: Promise<{ url: string; headers: Record<string, string>; body: string }>[] = [];
  const toCard: string[] = [];
  buyer.on("request", (r) => {
    const origin = new URL(r.url()).origin;
    if (origin === app) toApp.push(r.allHeaders().then((headers) => ({ url: r.url(), headers, body: r.postData() ?? "" })));
    if (origin === CARD_ORIGIN && r.method() === "POST") toCard.push(r.postData() ?? "");
  });
  await buyer.goto("/c/guia-cartao?metodo=cartao");
  const iframe = buyer.locator('iframe[title="Dados do cartão"]');
  await expect(iframe).toHaveAttribute("src", new RegExp(`^${CARD_ORIGIN.replace(/\./g, "\\.")}/form/[0-9a-f-]{36}$`));
  await buyer.getByLabel("Nome completo").fill("Maria Aparecida Souza");
  await buyer.getByLabel("E-mail", { exact: true }).fill(`cartao.${BUYER}`);
  await buyer.getByLabel("WhatsApp").fill("11987654321");
  await buyer.getByLabel("CPF", { exact: true }).fill("52998224725");
  const f = buyer.frameLocator('iframe[title="Dados do cartão"]');
  await f.getByLabel("Número do cartão").fill(testCard.number);
  await f.getByLabel("Nome impresso no cartão").fill(testCard.holder);
  await f.getByLabel("Validade").fill(testCard.expiry);
  await f.getByLabel("CVV").fill(testCard.cvv);
  await f.getByLabel("CEP").fill("01310100");
  await f.getByLabel("Número", { exact: true }).fill("100");
  await buyer.getByRole("button", { name: "Pagar R$ 9,90" }).click();
  await expect(buyer).toHaveURL(/\/o\/[\w-]+$/);
  await expect(buyer.getByRole("heading", { name: "Pagamento confirmado!" })).toBeVisible();
  await expect(buyer.getByText("Total pago com cartão")).toBeVisible();
  // Nada do cartão em URL, cabeçalhos (todos, allHeaders) ou corpo das requisições à origem do app. Controle positivo:
  // o mesmo detector acha os quatro itens no POST ao pagar.
  const leaks = cardLeaks(testCard);
  expect(toCard).toHaveLength(1);
  expect(leaks(toCard[0]!)).toEqual(["CVV", "nome impresso", "número", "validade"]);
  const requests = await Promise.all(toApp);
  expect(requests.length).toBeGreaterThan(5);
  for (const r of requests) {
    expect(leaks(r.url), `URL ${r.url}`).toEqual([]);
    expect(leaks(headersText(r.headers)), `cabeçalhos de ${r.url}`).toEqual([]);
    expect(leaks(r.body), `corpo de ${r.url}`).toEqual([]);
  }
  await buyer.close();
});
