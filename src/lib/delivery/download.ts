// Link pessoal de download /d/[token]. A rota só faz o parse HTTP e chama `runAction`.
// - GET: confere o link SEM contar download e mostra "Seu PDF está pronto" com um formulário POST (botão "Baixar PDF").
//   Robôs que abrem links de e-mail (Safe Links, antivírus) só fazem GET/HEAD: nunca gastam downloads. Aproveita para
//   pré-gerar o PDF carimbado em segundo plano.
// - HEAD: 200 sem consultar nada (nem conta, nem gera).
// - POST (mesma origem): conta o download. `prepare` confere o link e garante o PDF no cache (fora da transação, Worker
//   isolado); `run` faz o UPDATE atômico (`downloads < max_downloads ... RETURNING`); o PDF sai em fluxo do storage.
//   Fila de geração cheia: 503 "tente em instantes" sem contar.
// - Loja pelo host e token pelo sha256 com RLS da loja: token de outra loja não é encontrado.
// - Inválido, vencido, revogado, esgotado ou de outra loja: a MESMA página 410 (não revela qual foi o caso).
// - Tentativas inválidas contam por IP (60/h) e, passado o limite, 429. Downloads válidos não contam. Sem proxy
//   confiável o IP é desconhecido e esse limite é pulado (como no resto do app).
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction } from "@/lib/actions/core";
import { brandVars } from "@/lib/brand";
import { sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { customer, downloadLink, downloadToken, orders, product } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { dateTimeSP } from "@/lib/format";
import { log } from "@/lib/log";
import { clientIpFrom, UNKNOWN_IP } from "@/lib/client-ip";
import { hitRateLimit, ipRateKey, peekRateLimit } from "@/lib/payments/ratelimit";
import { PdfBusyError } from "@/lib/pdf/sandbox";
import { storage } from "@/lib/storage";
import { resolveStore as defaultResolveStore, getStoreBrandColor, type ResolvedStore } from "@/lib/stores";
import { LINK_TTL_MS, MAX_DOWNLOADS, TOKEN_RE } from "./links";
import { esc } from "./templates";
import { ensureWatermarkedPdf, watermarkText, type WatermarkRequest } from "./watermark";

export const BAD_TOKEN_LIMIT = { perIpPerHour: 60 } as const;
const HOUR = 3600;
const GONE = "link_indisponivel";
const BUSY = "fila_ocupada";

const badKey = (ip: string) => `download:bad:ip:${ipRateKey(ip)}`;
const input = z.object({ token: z.string().max(200), clientIp: z.string().min(1).max(64) });

/** Confere limite de tentativas, formato e o link (sem contar). Inválido conta como tentativa ruim do IP. */
async function resolveLink(storeId: string, token: string, clientIp: string) {
  const known = clientIp !== UNKNOWN_IP;
  if (known && !(await peekRateLimit(badKey(clientIp), BAD_TOKEN_LIMIT.perIpPerHour, HOUR))) {
    throw new ActionError("rate_limited", "Muitas tentativas");
  }
  const gone = async () => {
    if (known) await hitRateLimit(badKey(clientIp), HOUR);
    return new ActionError("not_found", GONE);
  };
  if (!TOKEN_RE.test(token)) throw await gone();
  const [row] = await withStore(storeId, (tx) =>
    tx
      .select({
        tokenId: downloadToken.id,
        tokenRevokedAt: downloadToken.revokedAt,
        linkId: downloadLink.id,
        orderId: downloadLink.orderId,
        productId: downloadLink.productId,
        expiresAt: downloadLink.expiresAt,
        revokedAt: downloadLink.revokedAt,
        downloads: downloadLink.downloads,
        maxDownloads: downloadLink.maxDownloads,
        status: orders.status,
        buyerName: orders.buyerName,
        customerName: customer.name,
        email: customer.email,
        productName: product.name,
        fileKey: product.fileKey,
        fileSha256: product.fileSha256,
        fileName: product.fileName,
      })
      .from(downloadToken)
      .innerJoin(downloadLink, eq(downloadLink.id, downloadToken.linkId))
      .innerJoin(orders, eq(orders.id, downloadLink.orderId))
      .innerJoin(customer, eq(customer.id, orders.customerId))
      .innerJoin(product, eq(product.id, downloadLink.productId))
      .where(eq(downloadToken.tokenHash, sha256(token))),
  );
  const usable =
    row &&
    row.status === "paid" &&
    !row.revokedAt &&
    !row.tokenRevokedAt &&
    row.expiresAt.getTime() > Date.now() &&
    row.downloads < row.maxDownloads;
  if (!usable) throw await gone();
  const watermark: WatermarkRequest = {
    orderId: row.orderId,
    productId: row.productId,
    fileKey: row.fileKey,
    fileSha256: row.fileSha256,
    text: watermarkText(row.buyerName ?? row.customerName, row.email),
  };
  return { row, watermark };
}

/** GET: só confere e descreve o link (nada é contado). */
export const viewDownload = defineAction({
  name: "downloads.view",
  description: "Confere um link pessoal de download sem contar download (página com o botão Baixar PDF).",
  input,
  permission: "public",
  audit: false,
  prepare: (call, { token, clientIp }) => resolveLink(call.storeId, token, clientIp),
  async run(_ctx, _input, { row, watermark }) {
    return {
      productName: row.productName,
      downloadsLeft: row.maxDownloads - row.downloads,
      maxDownloads: row.maxDownloads,
      expiresAt: row.expiresAt,
      watermark,
    };
  },
});

/** POST: conta um download (atômico) e devolve a chave do PDF carimbado no storage. */
export const downloadFile = defineAction({
  name: "downloads.get",
  description: "Baixa o PDF carimbado de um link pessoal de download (conta um download).",
  input,
  permission: "public",
  audit: false,
  async prepare(call, { token, clientIp }) {
    const { row, watermark } = await resolveLink(call.storeId, token, clientIp);
    let fileKey: string;
    try {
      fileKey = await ensureWatermarkedPdf(watermark);
    } catch (e) {
      if (e instanceof PdfBusyError) throw new ActionError("rate_limited", BUSY);
      log.error("falha ao preparar o PDF carimbado", { storeId: call.storeId, orderId: row.orderId, productId: row.productId, error: e });
      throw new ActionError("provider_error", "Não foi possível preparar o arquivo");
    }
    return { linkId: row.linkId, tokenId: row.tokenId, fileKey, fileName: row.fileName };
  },
  async run(ctx, _input, prepared) {
    // De novo, atômico: outra requisição pode ter usado o último download, ou o pedido/token pode ter sido revogado.
    const [hit] = await ctx.tx
      .update(downloadLink)
      .set({ downloads: sql`${downloadLink.downloads} + 1`, lastDownloadAt: sql`now()` })
      .where(
        and(
          eq(downloadLink.id, prepared.linkId),
          lt(downloadLink.downloads, downloadLink.maxDownloads),
          isNull(downloadLink.revokedAt),
          gt(downloadLink.expiresAt, sql`now()`),
          sql`exists (select 1 from ${orders} where ${orders.id} = ${downloadLink.orderId} and ${orders.status} = 'paid')`,
          sql`exists (select 1 from ${downloadToken} where ${downloadToken.id} = ${prepared.tokenId} and ${downloadToken.revokedAt} is null)`,
        ),
      )
      .returning({ downloads: downloadLink.downloads });
    if (!hit) throw new ActionError("not_found", GONE);
    return { fileKey: prepared.fileKey, fileName: prepared.fileName, downloads: hit.downloads };
  },
});

// ---- HTTP ------------------------------------------------------------------------------------------------------

/** Nome de arquivo seguro: sem controle, barras ou aspas; termina em .pdf; fallback ASCII + `filename*` (RFC 5987). */
export function contentDisposition(fileName: string): string {
  let name = fileName
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[\\/"]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  name = name.replace(/\.pdf$/i, "").slice(0, 120).trim() || "arquivo";
  name = `${name}.pdf`;
  const ascii = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, "_");
  const star = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

const SAFE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
};
const PAGE_HEADERS = {
  ...SAFE_HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// Tokens do sistema visual (src/app/(design)/tokens.css). A rota não carrega o CSS do Next; os valores usados aqui
// são conferidos contra tokens.css em tests/delivery-page.test.ts.
export const PAGE_TOKENS = {
  "--color-bg": "#f5f6f3",
  "--color-surface": "#ffffff",
  "--color-border": "#dde1db",
  "--color-text": "#15201b",
  "--color-text-muted": "#56615b",
  "--color-warning": "#8a5a00",
  "--color-warning-soft": "#fbf0d9",
  "--color-danger": "#b42318",
  "--color-danger-soft": "#fdecea",
  "--color-info": "#1d5fa8",
  "--color-info-soft": "#e6effa",
  "--color-success": "#157347",
  "--color-success-soft": "#e4f3ea",
  "--radius-md": "10px",
  "--radius-lg": "14px",
} as const;

const ICONS = {
  // Lucide link-2-off, clock, info, file-check, download, mail-x e circle-check (lucide-static 0.460.0, ISC).
  "link-off": '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" x2="12" y1="12" y2="12"/><line x1="2" x2="22" y1="2" y2="22"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "file-check": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  "mail-x": '<path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h9"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><path d="m17 17 4 4"/><path d="m21 17-4 4"/>',
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
};
const svg = (name: keyof typeof ICONS, size: number) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

type Tone = "warning" | "danger" | "success";
interface PageCopy {
  title: string;
  text: string;
  note: string;
  tone: Tone;
  icon: keyof typeof ICONS;
}

const COPY: Record<"gone" | "limited" | "busy" | "error", PageCopy> = {
  gone: {
    title: "Este link de download expirou",
    text: `Por segurança, cada link vale por ${Math.round(LINK_TTL_MS / 86_400_000)} dias e até ${MAX_DOWNLOADS} downloads. A sua compra continua garantida.`,
    note: "Link expirado? Para baixar de novo, peça um novo ao vendedor respondendo o e-mail em que você recebeu o acesso.",
    tone: "warning",
    icon: "link-off",
  },
  limited: {
    title: "Muitas tentativas",
    text: "Recebemos muitas tentativas deste aparelho. Aguarde um pouco e abra de novo o link do seu e-mail.",
    note: "Se o problema continuar, peça um novo link ao vendedor respondendo o e-mail em que você recebeu o acesso.",
    tone: "warning",
    icon: "clock",
  },
  busy: {
    title: "Estamos preparando muitos arquivos agora",
    text: "Tente de novo em instantes. Esta tentativa não contou como download.",
    note: "O seu link continua valendo. Se o problema continuar, fale com o vendedor respondendo o e-mail do acesso.",
    tone: "warning",
    icon: "clock",
  },
  error: {
    title: "Não foi possível preparar o seu arquivo",
    text: "Tente de novo em alguns minutos. O seu link continua valendo e esta tentativa não contou como download.",
    note: "Se o problema continuar, fale com o vendedor respondendo o e-mail em que você recebeu o acesso.",
    tone: "danger",
    icon: "info",
  },
};

type StoreLook = { name: string; brandColor: string | null } | null;

function frame(title: string, s: StoreLook, main: string): string {
  const t = PAGE_TOKENS;
  const b = brandVars(s?.brandColor ?? null);
  const header = s ? `<header><div class="in"><span class="store">${esc(s.name)}</span></div></header>` : "";
  const footer = s ? `<footer><p>Vendido por <b>${esc(s.name)}</b></p><p>Checkout processado pelo Funil</p></footer>` : "";
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:${t["--color-text"]};background:${t["--color-bg"]};line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
header{background:${t["--color-surface"]};border-bottom:1px solid ${t["--color-border"]}}
header .in{display:flex;align-items:center;height:56px;padding:0 20px;max-width:1080px;margin:0 auto}
.store{font-weight:700;font-size:19px;letter-spacing:-0.02em;color:${b["--color-brand-strong"]};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{width:100%;max-width:440px;margin:0 auto;padding:28px 16px 32px;display:flex;flex-direction:column;gap:16px;flex:1}
.hero{text-align:center;padding:4px 8px 8px}
.icon{width:64px;height:64px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center}
.icon[data-tone=warning]{background:${t["--color-warning-soft"]};color:${t["--color-warning"]}}
.icon[data-tone=danger]{background:${t["--color-danger-soft"]};color:${t["--color-danger"]}}
.icon[data-tone=success]{background:${t["--color-success-soft"]};color:${t["--color-success"]}}
h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-0.02em;line-height:1.2}
.hero p{margin:8px 0 0;font-size:16px;color:${t["--color-text-muted"]}}
.card{padding:20px 16px;background:${t["--color-surface"]};border:1px solid ${t["--color-border"]};border-radius:${t["--radius-lg"]}}
.row{display:flex;justify-content:space-between;gap:12px;font-size:14px;padding:8px 0;border-top:1px solid ${t["--color-border"]}}
.row:first-child{border-top:0;padding-top:0}
.row span{color:${t["--color-text-muted"]}}.row b{font-weight:500}
form{margin:14px 0 0}
button{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;height:56px;padding:0 24px;border:0;border-radius:12px;background:${b["--color-brand"]};color:${b["--color-on-brand"]};font:inherit;font-size:17px;font-weight:600;cursor:pointer}
button:hover{background:${b["--color-brand-hover"]}}
button:focus-visible{outline:3px solid ${b["--color-brand-soft"]};outline-offset:2px}
.note{display:flex;gap:10px;align-items:flex-start;padding:14px 16px;border-radius:${t["--radius-lg"]};background:${t["--color-info-soft"]};color:${t["--color-info"]};font-size:14px;line-height:1.45;margin:0}
.note svg{flex:none;margin-top:1px}
footer{padding:18px 16px 28px;border-top:1px solid ${t["--color-border"]};text-align:center;font-size:12.5px;color:${t["--color-text-muted"]};line-height:1.6}
footer p{margin:0}footer b{font-weight:600;color:${t["--color-text"]}}
</style></head>
<body>${header}
<main>${main}</main>
${footer}</body></html>`;
}

/** Páginas de erro do link (frame 11 do canvas Doop): autossuficientes, CSS inline, sem script nem recurso externo. */
export function downloadPage(kind: keyof typeof COPY, s: StoreLook): string {
  const c = COPY[kind];
  return frame(
    c.title,
    s,
    `<div class="hero"><div class="icon" data-tone="${c.tone}">${svg(c.icon, 30)}</div><h1>${esc(c.title)}</h1><p>${esc(c.text)}</p></div>
<p class="note">${svg("info", 18)}<span>${esc(c.note)}</span></p>`,
  );
}

/** "Seu PDF está pronto": o botão envia um POST para a mesma URL (é ele que conta o download). */
export function readyPage(d: { productName: string; downloadsLeft: number; maxDownloads: number; expiresAt: Date }, s: StoreLook): string {
  const until = dateTimeSP(d.expiresAt).split(" às ")[0]!;
  return frame(
    "Seu PDF está pronto",
    s,
    `<div class="hero"><div class="icon" data-tone="success">${svg("file-check", 30)}</div><h1>Seu PDF está pronto</h1><p>${esc(d.productName)}</p></div>
<section class="card">
<div class="row"><span>Downloads restantes</span><b>${d.downloadsLeft} de ${d.maxDownloads}</b></div>
<div class="row"><span>Link válido até</span><b>${until}</b></div>
<form method="post"><button type="submit">${svg("download", 20)}Baixar PDF</button></form>
</section>
<p class="note">${svg("info", 18)}<span>Cada PDF leva o seu nome e e-mail no rodapé. É um material pessoal: por favor, não compartilhe.</span></p>`,
  );
}

export interface DownloadHttpOptions {
  resolveStore?: (host: string) => Promise<ResolvedStore | null>;
  trustProxy?: number;
}

const call = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });

async function lookOf(s: ResolvedStore | null): Promise<StoreLook> {
  return s ? { name: s.name, brandColor: await getStoreBrandColor(s.id).catch(() => null) } : null;
}
const html = async (status: number, body: (look: StoreLook) => string, s: ResolvedStore | null) =>
  new Response(body(await lookOf(s)), { status, headers: PAGE_HEADERS });

function errorPage(e: unknown, s: ResolvedStore): Promise<Response> {
  if (e instanceof ActionError) {
    if (e.code === "rate_limited") return e.message === BUSY ? html(503, (l) => downloadPage("busy", l), s) : html(429, (l) => downloadPage("limited", l), s);
    if (e.code === "provider_error") return html(503, (l) => downloadPage("error", l), s);
    return html(410, (l) => downloadPage("gone", l), s);
  }
  log.error("falha inesperada no link de download", { storeId: s.id, error: e });
  return html(500, (l) => downloadPage("error", l), s);
}

/** GET /d/[token]: confere sem contar e mostra o botão; pré-gera o PDF em segundo plano. */
export async function handleDownloadPage(req: Request, token: string, opts: DownloadHttpOptions = {}): Promise<Response> {
  const s = await (opts.resolveStore ?? defaultResolveStore)(req.headers.get("host") ?? "");
  if (!s) return html(410, (l) => downloadPage("gone", l), null);
  const clientIp = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
  try {
    const v = await runAction(viewDownload, call(s.id), { token: token.slice(0, 200), clientIp });
    // Melhor esforço: com o PDF no cache, o clique em "Baixar PDF" responde na hora.
    ensureWatermarkedPdf(v.watermark).catch((e: unknown) => log.info("pré-geração do PDF adiada", { storeId: s.id, error: e }));
    return html(200, (l) => readyPage(v, l), s);
  } catch (e) {
    return errorPage(e, s);
  }
}

/**
 * POST de outro site? `Sec-Fetch-Site` (navegadores atuais) decide quando vem: só `same-origin` (ou `none`) passa.
 * Sem ele, vale o `Origin`: diferente do host ou `null` é recusado. Atenção: a página do link usa
 * `Referrer-Policy: no-referrer`, e com ela o navegador manda `Origin: null` no POST do próprio formulário; por isso
 * `Sec-Fetch-Site` vem antes. Clientes sem nenhum dos dois (ex.: curl com o link na mão) passam: o token já é a
 * credencial.
 */
function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host !== (req.headers.get("host") ?? "");
  } catch {
    return true;
  }
}

/** POST /d/[token]: o download contado. */
export async function handleDownloadPost(req: Request, token: string, opts: DownloadHttpOptions = {}): Promise<Response> {
  const s = await (opts.resolveStore ?? defaultResolveStore)(req.headers.get("host") ?? "");
  if (!s) return html(410, (l) => downloadPage("gone", l), null);
  // De outro site: volta para a página do link (o comprador clica no botão de lá); nada é contado.
  if (crossSite(req)) return new Response(null, { status: 303, headers: { ...SAFE_HEADERS, location: new URL(req.url).pathname } });
  const clientIp = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
  try {
    const out = await runAction(downloadFile, call(s.id), { token: token.slice(0, 200), clientIp });
    // Em fluxo direto do disco: um PDF de 50 MB não ocupa 50 MB de memória por download.
    const file = await storage.stream(out.fileKey);
    if (!file) {
      log.error("PDF carimbado sumiu do cache entre a preparação e o envio", { storeId: s.id });
      return html(503, (l) => downloadPage("error", l), s);
    }
    return new Response(file.body, {
      status: 200,
      headers: {
        ...SAFE_HEADERS,
        "content-type": "application/pdf",
        "content-length": String(file.size),
        "content-disposition": contentDisposition(out.fileName),
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    return errorPage(e, s);
  }
}

// Moldura, ícones e cabeçalhos reaproveitados pela página de descadastro (src/lib/recovery/unsubscribe.ts).
export { frame as storePageFrame, svg as pageIcon, lookOf as storeLookOf, PAGE_HEADERS as STORE_PAGE_HEADERS };
export type { StoreLook };

/** HEAD /d/[token]: 200 sem tocar em nada (robôs de e-mail). */
export function handleDownloadHead(): Response {
  return new Response(null, { status: 200, headers: { ...SAFE_HEADERS, "content-type": "text/html; charset=utf-8" } });
}
