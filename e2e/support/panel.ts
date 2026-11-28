// Ajudantes do painel para os E2E da instância multi (e2e/support/multi-app.ts).
import { expect, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

export const DESKTOP = { width: 1280, height: 800 };

/** Código curto do pedido no painel (#XXXXXXXX): 8 primeiros caracteres alfanuméricos do id público, em maiúsculas. */
export const codeOf = (publicId: string) => publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);

/**
 * Clica no botão de um formulário do painel que confere senha (server action com hash de senha) e espera a resposta do
 * POST. Na instância multi recém-subida e com a máquina carregada, esse POST levou ~10 s numa rodada do verify (trace):
 * a asserção de URL logo depois (5 s) vencia antes da resposta. Esperar a resposta é esperar o evento, não um tempo.
 */
export async function submitPasswordForm(page: Page, button: string, path: string) {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === path, { timeout: 60_000 }),
    page.getByRole("button", { name: button }).click(),
  ]);
}

/**
 * Primeiro acesso de um dono criado pelo `store:create`: entra com a senha temporária no host da loja, o painel exige a
 * troca e a nova senha leva ao painel da loja certa.
 */
export async function firstLogin(page: Page, origin: string, o: { email: string; temporaryPassword: string; password: string; storeName: string }) {
  await page.goto(`${origin}/admin/login`);
  await page.getByLabel("E-mail").fill(o.email);
  await page.getByLabel("Senha").fill(o.temporaryPassword);
  await submitPasswordForm(page, "Entrar", "/admin/login");
  await expect(page).toHaveURL(`${origin}/admin/senha`);
  await expect(page.getByText("Você entrou com uma senha temporária. Escolha uma senha sua para continuar.")).toBeVisible();
  await expect(page.getByText(`${o.email} · ${o.storeName}`)).toBeVisible();
  await page.getByLabel("Senha temporária").fill(o.temporaryPassword);
  await page.getByLabel("Senha nova (mínimo 10 caracteres)").fill(o.password);
  await page.getByLabel("Repita a senha nova").fill(o.password);
  await submitPasswordForm(page, "Trocar senha", "/admin/senha");
  await expect(page.getByText("Senha trocada.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Ir para o painel" }).click();
  await expect(page).toHaveURL(`${origin}/admin`);
  await expect(page.getByRole("heading", { name: `Boas-vindas, ${o.storeName}` })).toBeVisible();
}

/** fetch de dentro do navegador do dono (cookie de sessão do painel, mesma origem). Devolve status e corpo. */
export async function panelFetch(page: Page, path: string, init: { json?: unknown; pdf?: Buffer } = {}): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ path, json, pdf }) => {
      let body: BodyInit | undefined;
      const headers: Record<string, string> = {};
      if (json !== undefined) {
        body = JSON.stringify(json);
        headers["content-type"] = "application/json";
      } else if (pdf !== undefined) {
        body = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
        headers["content-type"] = "application/pdf";
      }
      const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* corpo não JSON: devolve o texto */
      }
      return { status: res.status, body: parsed };
    },
    { path, json: init.json, pdf: init.pdf?.toString("base64") },
  );
}

/** Ação do painel pela rota só do smoke (/api/test-only/action): mesmas permissões e auditoria do painel. */
export async function seedAction<T>(page: Page, action: string, input: unknown): Promise<T> {
  const r = await panelFetch(page, "/api/test-only/action", { json: { action, input } });
  expect(r.status, `${action}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body as T;
}

/** Envia um PDF de 1 página como produto da loja do dono logado (mesma rota do upload do painel). */
export async function uploadProduct(page: Page, name: string): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const pdf = Buffer.from(await doc.save());
  const r = await panelFetch(page, `/admin/api/products/upload?name=${encodeURIComponent(name)}&fileName=produto.pdf`, { pdf });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const id = (r.body as { id?: string }).id;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id!;
}
