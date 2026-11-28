// Várias lojas (MODE=multi) numa instalação só: cada loja no seu host (<slug>.PLATFORM_DOMAIN ou domínio próprio), com
// isolamento total no painel (pedidos, ofertas, produtos, compradores), no checkout e por URL direta.
// A instância multi é própria deste arquivo (e2e/support/multi-app.ts): o app do smoke segue em MODE=single.
import { test, expect, type Page } from "@playwright/test";
import { hostResolverArgs, startMultiApp, type MultiApp } from "./support/multi-app";
import { DESKTOP, codeOf, firstLogin, panelFetch, seedAction, submitPasswordForm, uploadProduct } from "./support/panel";

/** Domínio próprio da loja beta (store:domain). O Chromium o leva ao loopback; o app escolhe a loja pelo Host. */
const CUSTOM_DOMAIN = "checkout.loja-beta.test";
test.use({ launchOptions: { args: hostResolverArgs([CUSTOM_DOMAIN]) } });

type Key = "alfa" | "beta";
const stamp = Date.now();
const STORES: Record<Key, { name: string; slug: string; email: string; password: string; offer: string; shared: string; product: string; priceCents: number; price: string; buyer: string }> = {
  alfa: {
    name: "Loja Alfa",
    slug: "alfa",
    email: `dono.alfa.${stamp}@exemplo.com`,
    password: "senha-da-alfa-123",
    offer: "Curso Alfa completo",
    shared: "Oferta da Loja Alfa",
    product: "Apostila Alfa",
    priceCents: 1990,
    price: "R$ 19,90",
    buyer: `comprador.alfa.${stamp}@exemplo.com`,
  },
  beta: {
    name: "Loja Beta",
    slug: "beta",
    email: `dono.beta.${stamp}@exemplo.com`,
    password: "senha-da-beta-123",
    offer: "Curso Beta completo",
    shared: "Oferta da Loja Beta",
    product: "Apostila Beta",
    priceCents: 2990,
    price: "R$ 29,90",
    buyer: `comprador.beta.${stamp}@exemplo.com`,
  },
};
const OTHER: Record<Key, Key> = { alfa: "beta", beta: "alfa" };
/** Mesmo endereço de oferta nas duas lojas: o slug é único por loja, não na instalação. */
const SHARED_SLUG = "mesmo-endereco";

let multi: MultiApp;
const owner = {} as Record<Key, Page>;
const ids = {
  alfa: { productId: "", offerId: "", publicId: "", orderId: "" },
  beta: { productId: "", offerId: "", publicId: "", orderId: "" },
};

test.describe("várias lojas (MODE=multi)", () => {
  // Hooks e testes de 3 min: o beforeAll cria e migra um banco e sobe um `next start`; as compras passam por fila e avisos.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    multi = await startMultiApp("lojas");
  });

  test.afterAll(async () => {
    for (const p of Object.values(owner)) await p.close();
    await multi?.stop();
  });

  test("store:create cria as lojas; cada dono troca a senha temporária no host da sua loja e não entra na outra", async ({ browser }) => {
    for (const key of ["alfa", "beta"] as const) {
      const s = STORES[key];
      const created = await multi.createStore({ name: s.name, slug: s.slug, ownerEmail: s.email });
      owner[key] = await browser.newPage({ viewport: DESKTOP, reducedMotion: "reduce" });
      await firstLogin(owner[key], multi.storeOrigin(s.slug), { email: s.email, temporaryPassword: created.temporaryPassword, password: s.password, storeName: s.name });
    }
    // Slug repetido e slug reservado (o serviço de cartão vive em pagar.<domínio>) são recusados.
    const dup = await multi.cli("store:create", ["--name", "Outra", "--slug", "alfa", "--owner-email", `outro.${stamp}@exemplo.com`]);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("Slug ou domínio já em uso");
    const reserved = await multi.cli("store:create", ["--name", "Pagar", "--slug", "pagar", "--owner-email", `outro.${stamp}@exemplo.com`]);
    expect(reserved.code).toBe(1);
    expect(reserved.stderr).toContain("slug reservado");

    // O dono da alfa não tem vínculo com a beta: o login no host da beta falha com o erro genérico.
    const intruder = await browser.newPage({ viewport: DESKTOP });
    await intruder.goto(`${multi.storeOrigin("beta")}/admin/login`);
    await intruder.getByLabel("E-mail").fill(STORES.alfa.email);
    await intruder.getByLabel("Senha").fill(STORES.alfa.password);
    await submitPasswordForm(intruder, "Entrar", "/admin/login");
    await expect(intruder.getByText("E-mail ou senha inválidos.")).toBeVisible();
    await intruder.close();

    // A sessão é do host: o cookie da alfa não vale no host da beta.
    await owner.alfa.goto(`${multi.storeOrigin("beta")}/admin`);
    await expect(owner.alfa).toHaveURL(`${multi.storeOrigin("beta")}/admin/login`);
    await owner.alfa.goto(`${multi.storeOrigin("alfa")}/admin`);
    await expect(owner.alfa.getByRole("heading", { name: `Boas-vindas, ${STORES.alfa.name}` })).toBeVisible();

    // Host sem loja (slug inexistente): nada de checkout.
    expect((await multi.hostRequest("gama.localhost", `/c/${SHARED_SLUG}`)).status).toBe(404);
  });

  test("cada loja configura Pix manual, produto e ofertas pelo próprio painel (o mesmo endereço nas duas)", async () => {
    for (const key of ["alfa", "beta"] as const) {
      const s = STORES[key];
      const page = owner[key];
      await seedAction(page, "connections.savePixManual", { key: `pix@${s.slug}.com.br`, name: s.name, city: "Sao Paulo" });
      ids[key].productId = await uploadProduct(page, s.product);
      const base = { productIds: [ids[key].productId], priceCents: s.priceCents, methods: ["pix"], pixMode: "manual" };
      const offer = await seedAction<{ id: string }>(page, "offers.create", { ...base, slug: `oferta-${s.slug}`, name: s.offer });
      ids[key].offerId = offer.id;
      await seedAction(page, "offers.create", { ...base, slug: SHARED_SLUG, name: s.shared });
    }
  });

  async function fillBuyer(page: Page, email: string) {
    await page.getByLabel("Nome completo").fill("Maria Aparecida Souza");
    await page.getByLabel("E-mail", { exact: true }).fill(email);
    await page.getByLabel("WhatsApp").fill("11987654321");
  }

  test("checkout de cada loja no seu host: o mesmo endereço abre a oferta da própria loja; a oferta e o pedido da outra não abrem", async ({ page }) => {
    for (const key of ["alfa", "beta"] as const) {
      const s = STORES[key];
      const other = STORES[OTHER[key]];
      const origin = multi.storeOrigin(s.slug);
      await page.goto(`${origin}/c/${SHARED_SLUG}`);
      await expect(page.getByRole("region", { name: "Produto" })).toContainText(s.shared);
      await expect(page.getByRole("region", { name: "Produto" })).toContainText(s.price);
      await expect(page.getByText(other.shared)).toHaveCount(0);
      expect((await page.goto(`${origin}/c/oferta-${other.slug}`))?.status()).toBe(404);

      // Compra pelo checkout do host da loja: o pedido nasce na loja do host.
      await page.goto(`${origin}/c/oferta-${s.slug}`);
      await expect(page.getByRole("region", { name: "Produto" })).toContainText(s.offer);
      await fillBuyer(page, s.buyer);
      await page.getByRole("button", { name: `Gerar Pix de ${s.price}` }).click();
      await expect(page).toHaveURL(new RegExp(`^${origin.replace(/\./g, "\\.")}/o/[\\w-]+$`));
      ids[key].publicId = new URL(page.url()).pathname.split("/").pop()!;
    }
    // A página do pedido só abre no host da loja dona do pedido.
    for (const key of ["alfa", "beta"] as const) {
      const mine = multi.storeOrigin(STORES[key].slug);
      const theirs = multi.storeOrigin(STORES[OTHER[key]].slug);
      expect((await page.goto(`${mine}/o/${ids[key].publicId}`))?.status()).toBe(200);
      expect((await page.goto(`${theirs}/o/${ids[key].publicId}`))?.status()).toBe(404);
    }
  });

  test("painel: cada loja vê só os próprios pedidos, compradores, ofertas e produtos; id da outra loja na URL não abre nada", async () => {
    // Cada dono acha o próprio pedido e guarda o id interno (para tentar abri-lo pelo painel da outra loja).
    for (const key of ["alfa", "beta"] as const) {
      const page = owner[key];
      const s = STORES[key];
      await page.goto(`${multi.storeOrigin(s.slug)}/admin/orders`);
      await expect(page.getByRole("link", { name: `#${codeOf(ids[key].publicId)}` })).toBeVisible();
      await expect(page.getByRole("link", { name: `#${codeOf(ids[OTHER[key]].publicId)}` })).toHaveCount(0);
      await page.getByRole("link", { name: `#${codeOf(ids[key].publicId)}` }).click();
      await expect(page.getByRole("heading", { name: `Pedido #${codeOf(ids[key].publicId)}` })).toBeVisible();
      ids[key].orderId = new URL(page.url()).pathname.split("/").pop()!;
      expect(ids[key].orderId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(page.getByText(s.buyer)).toBeVisible();
    }

    for (const key of ["alfa", "beta"] as const) {
      const page = owner[key];
      const origin = multi.storeOrigin(STORES[key].slug);
      const other = STORES[OTHER[key]];
      const theirs = ids[OTHER[key]];

      // Comprador da outra loja: a busca não acha nada e a exportação não o traz.
      await page.goto(`${origin}/admin/orders?q=${encodeURIComponent(other.buyer)}`);
      await expect(page.getByRole("link", { name: `#${codeOf(theirs.publicId)}` })).toHaveCount(0);
      await expect(page.getByText(other.buyer)).toHaveCount(0);
      const csv = await panelFetch(page, "/admin/orders.csv");
      expect(csv.status).toBe(200);
      expect(String(csv.body)).toContain(STORES[key].buyer);
      expect(String(csv.body)).not.toContain(other.buyer);

      // Ofertas e produtos: só os da própria loja.
      await page.goto(`${origin}/admin/offers`);
      await expect(page.getByText(STORES[key].offer).first()).toBeVisible();
      await expect(page.getByText(other.offer)).toHaveCount(0);
      await expect(page.getByText(other.shared)).toHaveCount(0);
      await page.goto(`${origin}/admin/products`);
      await expect(page.getByText(STORES[key].product).first()).toBeVisible();
      await expect(page.getByText(other.product)).toHaveCount(0);

      // URL direta com o id da outra loja: pedido e oferta não abrem, o PDF não sai e nenhuma ação a alcança.
      await page.goto(`${origin}/admin/orders/${theirs.orderId}`);
      await expect(page.getByRole("heading", { name: `Pedido #${codeOf(theirs.publicId)}` })).toHaveCount(0);
      await expect(page.getByText(other.buyer)).toHaveCount(0);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await page.goto(`${origin}/admin/offers/${theirs.offerId}`);
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await expect(page.getByText(other.offer)).toHaveCount(0);
      expect((await panelFetch(page, `/admin/api/products/${theirs.productId}/file`)).status).toBe(404);
      const release = await panelFetch(page, "/api/test-only/release", { json: { publicId: theirs.publicId } });
      expect(release.status).toBe(404);
    }

    // A tentativa de liberar o pedido da outra loja não mexeu nele: segue aguardando pagamento.
    await owner.beta.goto(`${multi.storeOrigin("beta")}/o/${ids.beta.publicId}`);
    await expect(owner.beta.getByTestId("unique-amount")).toBeVisible();
  });

  test("domínio próprio pelo store:domain: o checkout da beta abre no domínio dela e só lá; ao tirar, o domínio para de abrir", async ({ page }) => {
    const set = await multi.cli("store:domain", ["--slug", "beta", "--domain", CUSTOM_DOMAIN]);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain(`Domínio da loja beta: (nenhum) -> ${CUSTOM_DOMAIN}`);
    // O mesmo domínio em outra loja e um subdomínio da plataforma (pertence aos slugs) são recusados.
    const taken = await multi.cli("store:domain", ["--slug", "alfa", "--domain", CUSTOM_DOMAIN]);
    expect(taken.code).toBe(1);
    expect(taken.stderr).toContain("Domínio já em uso por outra loja");
    const sub = await multi.cli("store:domain", ["--slug", "alfa", "--domain", "beta.localhost"]);
    expect(sub.code).toBe(1);
    expect(sub.stderr).toContain("pertencem aos slugs das lojas");

    const custom = multi.hostOrigin(CUSTOM_DOMAIN);
    await page.goto(`${custom}/c/oferta-beta`);
    await expect(page.getByRole("region", { name: "Produto" })).toContainText(STORES.beta.offer);
    await page.goto(`${custom}/c/${SHARED_SLUG}`);
    await expect(page.getByRole("region", { name: "Produto" })).toContainText(STORES.beta.shared);
    expect((await page.goto(`${custom}/c/oferta-alfa`))?.status()).toBe(404);
    expect((await page.goto(`${custom}/o/${ids.beta.publicId}`))?.status()).toBe(200);
    expect((await page.goto(`${custom}/o/${ids.alfa.publicId}`))?.status()).toBe(404);
    // O subdomínio da plataforma continua valendo para a beta.
    await page.goto(`${multi.storeOrigin("beta")}/c/oferta-beta`);
    await expect(page.getByRole("region", { name: "Produto" })).toContainText(STORES.beta.offer);

    const cleared = await multi.cli("store:domain", ["--slug", "beta", "--clear"]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain(`Domínio da loja beta: ${CUSTOM_DOMAIN} -> (nenhum)`);
    expect((await page.goto(`${custom}/c/oferta-beta`))?.status()).toBe(404);
  });
});
