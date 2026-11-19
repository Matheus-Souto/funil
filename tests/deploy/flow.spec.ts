// Smoke de deploy: o fluxo mínimo de uma instalação nova, pela imagem Docker atrás do Caddy (HTTPS), como o dono e um
// comprador fariam: setup -> conexões (Pix manual, SMTP) -> produto com upload do PDF (validação no Worker de PDF)
// -> oferta -> checkout Pix manual -> dono libera -> e-mail -> download do PDF carimbado (Worker de PDF de novo).
// Orquestrado por tests/smoke.sh (BASE_URL do Caddy, MAILPIT_URL do Mailpit do smoke, SMOKE_OUT da execução).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const MAILPIT = `${process.env.MAILPIT_URL}/api/v1`;
const OUT = process.env.SMOKE_OUT ?? ".";
const OWNER = { email: "dono@exemplo.com", password: "senha-longa-123" };
const BUYER = `comprador.${Date.now()}@exemplo.com`;
const codeOf = (publicId: string) => publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);

test("instalação nova: setup, produto, oferta, Pix manual liberado e download do PDF carimbado", async ({ browser, request, baseURL }) => {
  const owner: Page = await browser.newPage();

  // Setup do modo single (primeiro acesso).
  await owner.goto("/admin");
  await expect(owner).toHaveURL(/\/admin\/setup$/);
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

  // Produto: PDF enviado pela rota de upload e validado no Worker de PDF (pdf-lib resolvido dentro da imagem).
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  await owner.goto("/admin/products");
  await owner.getByLabel("Nome do produto").fill("Guia do deploy");
  await owner.getByLabel("Arquivo PDF do produto").setInputFiles({ name: "guia.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) });
  await owner.getByRole("button", { name: "Criar produto" }).click();
  await expect(owner.getByText("Produto “Guia do deploy” criado.")).toBeVisible();

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
  const [dl] = await Promise.all([buyer.waitForEvent("download"), buyer.getByRole("button", { name: "Baixar PDF" }).click()]);
  const saved = readFileSync((await dl.path())!);
  expect(saved.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
  expect(saved.byteLength).toBeGreaterThan(Buffer.from(await doc.save()).byteLength); // carimbo acrescenta conteúdo

  // O smoke baixa de novo depois de recriar o container (volume /data e migração repetida).
  writeFileSync(join(OUT, "download-link.txt"), link!);
  await buyer.close();
  await owner.close();
});
