// GET /d/[token]: download do PDF carimbado. A rota só faz o parse HTTP e chama `runAction(downloadFile)`.
// - Loja pelo host (`resolveStore`) e token pelo sha256 com RLS da loja: token de outra loja não é encontrado.
// - Validade, revogação, limite e pedido pago conferidos no `prepare` (leitura) e de novo no UPDATE atômico do `run`
//   (`downloads < max_downloads ... RETURNING`): requisições simultâneas nunca passam do limite.
// - O PDF carimbado vem do cache ou é gerado no `prepare` (fora da transação, com vaga limitada por processo) e é
//   servido em fluxo a partir do storage.
// - Tentativas inválidas contam por IP (60/h): a partir daí, 429 (dificulta adivinhar tokens). Downloads válidos não
//   contam (o limite de 5 por link já os segura). Sem proxy confiável o IP é desconhecido e esse limite é pulado.
// - Inválido, vencido, revogado, esgotado ou de outra loja: a MESMA página 410 (não revela qual foi o caso).
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction } from "@/lib/actions/core";
import { brandVars } from "@/lib/brand";
import { sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { customer, downloadLink, orders, product } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { UNKNOWN_IP } from "@/lib/payments/asaas/card";
import { clientIpFrom } from "@/lib/payments/asaas/card-http";
import { hitRateLimit, ipRateKey, peekRateLimit } from "@/lib/payments/ratelimit";
import { storage } from "@/lib/storage";
import { resolveStore as defaultResolveStore, getStoreBrandColor, type ResolvedStore } from "@/lib/stores";
import { LINK_TTL_MS, MAX_DOWNLOADS, TOKEN_RE } from "./links";
import { esc } from "./templates";
import { ensureWatermarkedPdf, watermarkText } from "./watermark";

export const BAD_TOKEN_LIMIT = { perIpPerHour: 60 } as const;
const HOUR = 3600;
const GONE = "link_indisponivel";

const badKey = (ip: string) => `download:bad:ip:${ipRateKey(ip)}`;

export const downloadFile = defineAction({
  name: "downloads.get",
  description: "Baixa o PDF carimbado de um link pessoal de download (conta um download).",
  input: z.object({ token: z.string().max(200), clientIp: z.string().min(1).max(64) }),
  permission: "public",
  audit: false,
  async prepare(call, { token, clientIp }) {
    const known = clientIp !== UNKNOWN_IP;
    if (known && !(await peekRateLimit(badKey(clientIp), BAD_TOKEN_LIMIT.perIpPerHour, HOUR))) {
      throw new ActionError("rate_limited", "Muitas tentativas");
    }
    const gone = async () => {
      if (known) await hitRateLimit(badKey(clientIp), HOUR);
      return new ActionError("not_found", GONE);
    };
    if (!TOKEN_RE.test(token)) throw await gone();
    const row = await withStore(call.storeId, async (tx) => {
      const [r] = await tx
        .select({
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
          fileKey: product.fileKey,
          fileName: product.fileName,
        })
        .from(downloadLink)
        .innerJoin(orders, eq(orders.id, downloadLink.orderId))
        .innerJoin(customer, eq(customer.id, orders.customerId))
        .innerJoin(product, eq(product.id, downloadLink.productId))
        .where(eq(downloadLink.tokenHash, sha256(token)));
      return r;
    });
    const usable = row && row.status === "paid" && !row.revokedAt && row.expiresAt.getTime() > Date.now() && row.downloads < row.maxDownloads;
    if (!usable) throw await gone();
    let fileKey: string;
    try {
      fileKey = await ensureWatermarkedPdf({
        orderId: row.orderId,
        productId: row.productId,
        fileKey: row.fileKey,
        text: watermarkText(row.buyerName ?? row.customerName, row.email),
      });
    } catch (e) {
      log.error("falha ao preparar o PDF carimbado", { storeId: call.storeId, orderId: row.orderId, productId: row.productId, error: e });
      throw new ActionError("provider_error", "Não foi possível preparar o arquivo");
    }
    return { linkId: row.linkId, fileKey, fileName: row.fileName };
  },
  async run(ctx, _input, prepared) {
    // De novo, atômico: outra requisição pode ter usado o último download, ou o pedido pode ter sido reembolsado.
    const [hit] = await ctx.tx
      .update(downloadLink)
      .set({ downloads: sql`${downloadLink.downloads} + 1` })
      .where(
        and(
          eq(downloadLink.id, prepared.linkId),
          lt(downloadLink.downloads, downloadLink.maxDownloads),
          isNull(downloadLink.revokedAt),
          gt(downloadLink.expiresAt, sql`now()`),
          sql`exists (select 1 from ${orders} where ${orders.id} = ${downloadLink.orderId} and ${orders.status} = 'paid')`,
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

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
  "--radius-lg": "14px",
} as const;

const ICONS = {
  // Lucide link-2-off e clock (lucide-static 0.460.0, ISC).
  "link-off": '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" x2="12" y1="12" y2="12"/><line x1="2" x2="22" y1="2" y2="22"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const svg = (name: keyof typeof ICONS, size: number) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

interface PageCopy {
  title: string;
  text: string;
  note: string;
  tone: "warning" | "danger";
  icon: keyof typeof ICONS;
}

const COPY: Record<"gone" | "limited" | "error", PageCopy> = {
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
  error: {
    title: "Não foi possível preparar o seu arquivo",
    text: "Tente de novo em alguns minutos. O seu link continua valendo e esta tentativa não contou como download.",
    note: "Se o problema continuar, fale com o vendedor respondendo o e-mail em que você recebeu o acesso.",
    tone: "danger",
    icon: "info",
  },
};

/** Página do comprador (frame 11 do canvas Doop) autossuficiente: CSS inline, sem script nem recurso externo. */
export function downloadPage(kind: keyof typeof COPY, s: { name: string; brandColor: string | null } | null): string {
  const c = COPY[kind];
  const t = PAGE_TOKENS;
  const brand = brandVars(s?.brandColor ?? null)["--color-brand-strong"];
  const soft = c.tone === "warning" ? t["--color-warning-soft"] : t["--color-danger-soft"];
  const fg = c.tone === "warning" ? t["--color-warning"] : t["--color-danger"];
  const header = s ? `<header><div class="in"><span class="store">${esc(s.name)}</span></div></header>` : "";
  const footer = s ? `<footer><p>Vendido por <b>${esc(s.name)}</b></p><p>Checkout processado pelo Funil</p></footer>` : "";
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(c.title)}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:${t["--color-text"]};background:${t["--color-bg"]};line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
header{background:${t["--color-surface"]};border-bottom:1px solid ${t["--color-border"]}}
header .in{display:flex;align-items:center;height:56px;padding:0 20px;max-width:1080px;margin:0 auto}
.store{font-weight:700;font-size:19px;letter-spacing:-0.02em;color:${brand};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{width:100%;max-width:440px;margin:0 auto;padding:28px 16px 32px;display:flex;flex-direction:column;gap:16px;flex:1}
.hero{text-align:center;padding:4px 8px 8px}
.icon{width:64px;height:64px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;background:${soft};color:${fg}}
h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-0.02em;line-height:1.2}
.hero p{margin:8px 0 0;font-size:16px;color:${t["--color-text-muted"]}}
.note{display:flex;gap:10px;align-items:flex-start;padding:14px 16px;border-radius:${t["--radius-lg"]};background:${t["--color-info-soft"]};color:${t["--color-info"]};font-size:14px;line-height:1.45;margin:0}
.note svg{flex:none;margin-top:1px}
footer{padding:18px 16px 28px;border-top:1px solid ${t["--color-border"]};text-align:center;font-size:12.5px;color:${t["--color-text-muted"]};line-height:1.6}
footer p{margin:0}footer b{font-weight:600;color:${t["--color-text"]}}
</style></head>
<body>${header}
<main><div class="hero"><div class="icon">${svg(c.icon, 30)}</div><h1>${esc(c.title)}</h1><p>${esc(c.text)}</p></div>
<p class="note">${svg("info", 18)}<span>${esc(c.note)}</span></p></main>
${footer}</body></html>`;
}

export interface DownloadHttpOptions {
  resolveStore?: (host: string) => Promise<ResolvedStore | null>;
  trustProxy?: number;
}

export async function handleDownload(req: Request, token: string, opts: DownloadHttpOptions = {}): Promise<Response> {
  const page = async (status: number, kind: keyof typeof COPY, s: ResolvedStore | null) =>
    new Response(downloadPage(kind, s ? { name: s.name, brandColor: await getStoreBrandColor(s.id).catch(() => null) } : null), { status, headers: PAGE_HEADERS });
  const s = await (opts.resolveStore ?? defaultResolveStore)(req.headers.get("host") ?? "");
  if (!s) return page(410, "gone", null);
  const clientIp = clientIpFrom(req.headers, opts.trustProxy ?? env.TRUST_PROXY);
  try {
    const out = await runAction(downloadFile, { storeId: s.id, actor: { kind: "public" }, origin: "public" }, { token: token.slice(0, 200), clientIp });
    // Servido em fluxo direto do disco: um PDF de 50 MB não ocupa 50 MB de memória por download.
    const file = await storage.stream(out.fileKey);
    if (!file) {
      log.error("PDF carimbado sumiu do cache entre a preparação e o envio", { storeId: s.id });
      return page(503, "error", s);
    }
    return new Response(file.body, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(file.size),
        "content-disposition": contentDisposition(out.fileName),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
      },
    });
  } catch (e) {
    if (e instanceof ActionError) {
      if (e.code === "rate_limited") return page(429, "limited", s);
      if (e.code === "provider_error") return page(503, "error", s);
      return page(410, "gone", s);
    }
    log.error("falha inesperada no download", { storeId: s.id, error: e });
    return page(500, "error", s);
  }
}
