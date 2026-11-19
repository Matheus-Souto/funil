// Monitor semanal das páginas de pagamento (PCI DSS 4.0 11.6.1): confere o cabeçalho CSP e o inventário de scripts de
// /c e /o no próprio domínio e avisa o vendedor quando muda. Fetch falso, sem rede.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getHandlers } from "@/lib/jobs/handlers";
import { job, offer, orders, pageCheck, storeAlert } from "@/lib/db/schema";
import { buyerCsp } from "@/proxy";
import { createPciPageMonitorHandler, inspectBuyerPage, PCI_MONITOR_EVERY_MS } from "@/lib/security/page-monitor";
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
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.pathname);
    const key = Object.keys(pages).find((k) => url.pathname.startsWith(k));
    const p = key ? pages[key]! : { html: "não encontrado", csp: null, status: 404 };
    return new Response(p.html, { status: p.status ?? 200, headers: { "content-type": "text/html", ...(p.csp ? { "content-security-policy": p.csp } : {}) } });
  }) as typeof fetch;
  return { fetchFn, calls };
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
});
