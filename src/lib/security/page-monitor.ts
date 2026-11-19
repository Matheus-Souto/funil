// Monitor das páginas de pagamento em produção (PCI DSS 4.0 11.6.1: detectar, no mínimo semanalmente, mudança não
// autorizada nos cabeçalhos de segurança e nos scripts das páginas onde se digita o cartão). Job global semanal
// `pci_page_monitor`: para cada loja, busca no PRÓPRIO domínio da loja o checkout de uma oferta ativa (/c/<slug>) e a
// página do pedido mais recente (/o/<publicId>), confere o cabeçalho Content-Security-Policy contra a política que o app
// gera (src/proxy.ts) e o inventário de scripts do HTML (só origens autorizadas; inline só com o nonce da resposta), e
// avisa o vendedor (store_alert + e-mail) quando o resultado muda. Com o cartão isolado (CARD_ISOLATED=1), confere
// também a página do iframe no domínio do cartão (CARD_ORIGIN/form/<loja>, page "/form") contra `cardFormCsp` e o
// inventário do serviço (só /form.js e, se a loja usa, o Turnstile), com o sha256 do conteúdo do /form.js (troca do
// conteúdo no mesmo caminho também avisa). HTTP fora de transação; sem dados de comprador.
import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { alertSeller } from "@/lib/alerts";
import { db, withStore } from "@/lib/db/client";
import { offer, orders, pageCheck, store } from "@/lib/db/schema";
import { storeBaseUrl } from "@/lib/delivery/links";
import { env } from "@/lib/env";
import type { JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { storeCheckoutOrigins } from "@/lib/stores";
import { buyerCsp } from "@/proxy";
import { cardFormCsp } from "@/card-service/page";

export const PCI_MONITOR_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML = 2 * 1024 * 1024;
const NONCE_PLACEHOLDER = "nonce-*";
const TURNSTILE = "https://challenges.cloudflare.com";

/** Origens de script autorizadas nas páginas do comprador (inventário em docs/seguranca-pagamento.md). */
function authorizedScript(url: URL, pageOrigin: string, turnstile: boolean): boolean {
  if (url.origin === pageOrigin) return url.pathname.startsWith("/_next/static/");
  if (url.origin === "https://connect.facebook.net") return true;
  return turnstile && url.origin === TURNSTILE;
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

type ScriptTag = { kind: "src"; url: URL | null } | { kind: "inline"; tag: string };

/** Os `<script>` do HTML. JSON embutido (dados: `application/json`, `application/ld+json`) não executa e fica de fora. */
function scriptsOf(html: string, pageUrl: URL): ScriptTag[] {
  const out: ScriptTag[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, "src");
    if (src !== null) {
      let url: URL | null = null;
      try {
        url = new URL(src, pageUrl);
      } catch {
        /* URL inválida: script não autorizado */
      }
      out.push({ kind: "src", url });
      continue;
    }
    const type = (attr(tag, "type") ?? "").toLowerCase();
    if (type === "application/json" || type === "application/ld+json") continue;
    out.push({ kind: "inline", tag });
  }
  return out;
}

const resultHash = (csp: string | null, inventory: string[]) =>
  createHash("sha256").update(JSON.stringify({ csp, inventory })).digest("hex").slice(0, 32);

/**
 * Confere uma página do comprador já baixada. Inventário normalizado (nomes com hash do build viram
 * `self:/_next/static/*`; nonce não entra): o hash só muda quando muda a política ou o conjunto de origens de script.
 */
export function inspectBuyerPage(
  html: string,
  cspHeader: string | null,
  opts: { turnstile: boolean; pageUrl?: string; cardOrigin?: string },
): { problems: string[]; inventory: string[]; hash: string; csp: string | null } {
  const problems = new Set<string>();
  const pageUrl = new URL(opts.pageUrl ?? "https://loja.invalid/c/x");
  const nonce = /'nonce-([^']+)'/.exec(cspHeader ?? "")?.[1] ?? null;
  const csp = cspHeader ? cspHeader.replace(/'nonce-[^']+'/g, `'${NONCE_PLACEHOLDER}'`).trim() : null;
  // Com o cartão isolado, o checkout embute o iframe: frame-src do domínio do cartão (como em src/proxy.ts).
  const expected = buyerCsp("*", { dev: false, turnstile: opts.turnstile, cardOrigin: opts.cardOrigin });
  if (!csp) problems.add("csp_ausente");
  else if (csp !== expected) problems.add("csp_diferente");

  const inventory = new Set<string>();
  for (const s of scriptsOf(html, pageUrl)) {
    if (s.kind === "inline") {
      // Inline executável precisa do nonce desta resposta.
      inventory.add("inline:nonce");
      if (!nonce || attr(s.tag, "nonce") !== nonce) problems.add("script_sem_nonce");
      continue;
    }
    const url = s.url;
    if (url === null) {
      problems.add("script_nao_autorizado");
      continue;
    }
    const same = url.origin === pageUrl.origin;
    inventory.add(same && url.pathname.startsWith("/_next/static/") ? "self:/_next/static/*" : same ? `self:${url.pathname}` : `${url.origin}${url.pathname}`);
    if (!authorizedScript(url, pageUrl.origin, opts.turnstile)) problems.add("script_nao_autorizado");
  }
  const list = [...inventory].sort();
  return { problems: [...problems].sort(), inventory: list, hash: resultHash(csp, list), csp };
}

/**
 * Confere a página do iframe do cartão (`CARD_ORIGIN/form/<loja>`, src/card-service/page.ts). CSP exata de
 * `cardFormCsp(origens da loja)`; scripts: só `/form.js` do próprio domínio e, se a loja usa, o Turnstile; nenhum
 * inline executável (a configuração vai em `application/json`). O hash guarda a política com as origens da loja
 * trocadas por um marcador quando ela confere: mudar o domínio da loja não vira aviso. `formJsSha256` (sha256 do
 * conteúdo baixado do /form.js) entra no inventário: conteúdo trocado no mesmo caminho muda o hash e avisa.
 */
export function inspectCardFormPage(
  html: string,
  cspHeader: string | null,
  opts: { origins: string[]; turnstile: boolean; pageUrl: string; formJsSha256?: string },
): { problems: string[]; inventory: string[]; hash: string; csp: string | null } {
  const problems = new Set<string>();
  const pageUrl = new URL(opts.pageUrl);
  const csp = cspHeader ? cspHeader.trim() : null;
  const expected = cardFormCsp(opts.origins, { turnstile: opts.turnstile });
  if (!csp) problems.add("csp_ausente");
  else if (csp !== expected) problems.add("csp_diferente");

  const inventory = new Set<string>();
  for (const s of scriptsOf(html, pageUrl)) {
    if (s.kind === "inline") {
      inventory.add("inline");
      problems.add("script_inline");
      continue;
    }
    const url = s.url;
    if (url === null) {
      problems.add("script_nao_autorizado");
      continue;
    }
    const same = url.origin === pageUrl.origin;
    const formJs = same && url.pathname === "/form.js" && !url.search;
    const entry = same ? `self:${url.pathname}` : `${url.origin}${url.pathname}`;
    inventory.add(formJs && opts.formJsSha256 ? `${entry} sha256:${opts.formJsSha256}` : entry);
    if (!(formJs || (opts.turnstile && url.origin === TURNSTILE))) problems.add("script_nao_autorizado");
  }
  const list = [...inventory].sort();
  const hashed = csp === expected ? cardFormCsp(["<loja>"], { turnstile: opts.turnstile }) : csp;
  return { problems: [...problems].sort(), inventory: list, hash: resultHash(hashed, list), csp };
}

type Page = "/c" | "/o" | "/form";

async function fetchPage(doFetch: typeof fetch, page: Page, url: string, signal: AbortSignal): Promise<{ html: string; csp: string | null } | null> {
  try {
    const res = await doFetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "funil-pci-monitor", Accept: "text/html" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (res.status !== 200) {
      log.warn("monitor da página de pagamento: resposta inesperada; sem conferência desta vez", { page, status: res.status });
      return null;
    }
    const html = (await res.text()).slice(0, MAX_HTML);
    return { html, csp: res.headers.get("content-security-policy") };
  } catch {
    log.warn("monitor da página de pagamento: página indisponível; sem conferência desta vez", { page });
    return null;
  }
}

/** Grava o resultado e avisa o vendedor quando ele muda (1ª conferência: só se já vier com problema). */
async function record(storeId: string, page: Page, r: { problems: string[]; inventory: string[]; hash: string }): Promise<void> {
  await withStore(storeId, async (tx) => {
    const [prev] = await tx.select().from(pageCheck).where(eq(pageCheck.page, page)).for("update");
    const ok = r.problems.length === 0;
    const changed = prev ? prev.hash !== r.hash || prev.ok !== ok : !ok;
    const values = { hash: r.hash, ok, problems: r.problems, inventory: r.inventory, checkedAt: new Date() };
    if (prev) await tx.update(pageCheck).set(values).where(eq(pageCheck.id, prev.id));
    else await tx.insert(pageCheck).values({ storeId, page, ...values });
    if (changed) await alertSeller(tx, storeId, "monitor_pagina_pagamento", { page, code: r.problems[0] ?? "inventario_mudou" });
  });
  if (r.problems.length > 0) log.warn("monitor da página de pagamento: problema encontrado", { storeId, page, problems: r.problems });
}

/**
 * Handler do job global `pci_page_monitor`. `fetch` e `storeIds` (só estas lojas) existem para os testes; `card`
 * (origem do serviço de cartão; `null` = não conferir o iframe) vem do ambiente (CARD_ISOLATED=1 e CARD_ORIGIN). Falha
 * de rede ou resposta não 200 não avisam (não é mudança de página) e não mudam o estado guardado; o job segue para as
 * demais lojas e falha no fim se alguma loja deu erro inesperado (o worker re-tenta).
 */
export function createPciPageMonitorHandler(deps: { fetch?: typeof fetch; storeIds?: string[]; card?: { origin: string } | null } = {}): JobHandler {
  return async (_j, signal) => {
    const doFetch = deps.fetch ?? fetch;
    const turnstile = Boolean(env.TURNSTILE_SITE_KEY);
    const card = deps.card !== undefined ? deps.card : env.CARD_ISOLATED && env.CARD_ORIGIN ? { origin: env.CARD_ORIGIN } : null;
    const stores = await db.select({ id: store.id, slug: store.slug, domain: store.domain }).from(store);
    let failed = 0;
    for (const s of stores) {
      if (deps.storeIds && !deps.storeIds.includes(s.id)) continue;
      if (signal.aborted) break;
      try {
        const targets = await withStore(s.id, async (tx) => {
          const [o] = await tx
            .select({ slug: offer.slug })
            .from(offer)
            .where(eq(offer.active, true))
            .orderBy(sql`('card' = any(${offer.methods})) desc`, desc(offer.createdAt))
            .limit(1);
          const [last] = await tx.select({ publicId: orders.publicId }).from(orders).orderBy(desc(orders.createdAt)).limit(1);
          return [
            ...(o ? [{ page: "/c" as const, path: `/c/${encodeURIComponent(o.slug)}` }] : []),
            ...(last ? [{ page: "/o" as const, path: `/o/${encodeURIComponent(last.publicId)}` }] : []),
          ];
        });
        const base = storeBaseUrl(s);
        for (const t of targets) {
          const url = `${base}${t.path}`;
          const got = await fetchPage(doFetch, t.page, url, signal);
          if (!got) continue;
          await record(s.id, t.page, inspectBuyerPage(got.html, got.csp, { turnstile, pageUrl: url, cardOrigin: card?.origin }));
        }
        if (card) {
          const url = `${card.origin}/form/${s.id}`;
          const got = await fetchPage(doFetch, "/form", url, signal);
          // Conteúdo do script do formulário: sem ele, nada é conferido desta vez (não muda o estado guardado).
          const js = got && (await fetchPage(doFetch, "/form", `${card.origin}/form.js`, signal));
          if (got && js) {
            const origins = await storeCheckoutOrigins(s.id);
            const formJsSha256 = createHash("sha256").update(js.html).digest("hex");
            await record(s.id, "/form", inspectCardFormPage(got.html, got.csp, { origins, turnstile, pageUrl: url, formJsSha256 }));
          }
        }
      } catch (e) {
        failed++;
        log.error("monitor da página de pagamento falhou na loja", { storeId: s.id, error: e });
      }
    }
    if (failed > 0) throw new Error(`pci_page_monitor falhou em ${failed} loja(s)`);
  };
}

export const pciPageMonitorJob: JobHandler = createPciPageMonitorHandler();
