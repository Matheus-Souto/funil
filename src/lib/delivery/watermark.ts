// PDF personalizado: rodapé "Licenciado para <nome> — <email>" em todas as páginas (Helvetica 7 pt, cinza 50%,
// centralizado a 12 pt da borda inferior, respeitando a rotação da página). O resultado fica em cache no storage
// (`wm/<orderId>/<productId>.pdf`): é gerado pelo job de entrega logo depois do e-mail e, se faltar, na primeira
// abertura do link. A geração é limitada a WATERMARK_CONCURRENCY por processo (servidor de 1 GB) e chamadas
// simultâneas do mesmo arquivo compartilham a mesma geração.
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from "pdf-lib";
import { storage } from "@/lib/storage";

export const WATERMARK_FONT_SIZE = 7;
export const WATERMARK_MARGIN = 12;
export const WATERMARK_CONCURRENCY = 2;
const NAME_MAX = 80;
const EMAIL_MAX = 254;

/** Quebras e tabulações viram espaço; os demais de controle (Cc) e de formatação (Cf: bidi, ZWJ, BOM...) somem. */
const BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
/** Emoji e seletores de variação: a fonte padrão não tem, e um "?" no lugar só polui o rodapé. */
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

function clean(s: string, max: number): string {
  return s.replace(BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Texto do rodapé: `Licenciado para <nome> — <email>`, sem caracteres de controle e com tamanho limitado. */
export function watermarkText(name: string, email: string): string {
  return `Licenciado para ${clean(name, NAME_MAX)} — ${clean(email, EMAIL_MAX)}`;
}

/**
 * Ajusta o texto ao que a fonte padrão (WinAnsi) codifica: emoji saem; letra sem glifo vira a letra base sem acento
 * (NFD) se a fonte tiver a base, senão "?". Nunca lança (`font.encodeText` lança em caractere não suportado).
 */
export function fitToFont(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  const has = (ch: string) => [...ch].every((c) => supported.has(c.codePointAt(0)!));
  let out = "";
  for (const ch of text.replace(BREAKS, " ").replace(PICTOGRAPHIC, "").replace(INVISIBLE, "")) {
    if (has(ch)) out += ch;
    else {
      const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
      out += base && has(base) ? base : "?";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Corta o texto (com reticências) até caber em `maxWidth`. */
function fitWidth(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(`${text.slice(0, mid).trimEnd()}…`, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Carimba o rodapé em todas as páginas. PDF inválido lança. */
export async function watermarkPdf(pdf: Uint8Array, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = WATERMARK_FONT_SIZE;
  const safe = fitToFont(font, text);
  for (const page of doc.getPages()) {
    const box = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const sideways = rotation === 90 || rotation === 270;
    // Largura visível da borda inferior (na página girada, é a altura do box).
    const visibleWidth = sideways ? box.height : box.width;
    const line = fitWidth(font, safe, size, Math.max(visibleWidth - 2 * WATERMARK_MARGIN, 10));
    const w = font.widthOfTextAtSize(line, size);
    const m = WATERMARK_MARGIN;
    // Ponto inicial e ângulo para que o texto fique na borda inferior VISUAL, lido da esquerda para a direita.
    const pos =
      rotation === 90
        ? { x: box.x + box.width - m, y: box.y + (box.height - w) / 2, angle: 90 }
        : rotation === 180
          ? { x: box.x + (box.width + w) / 2, y: box.y + box.height - m, angle: 180 }
          : rotation === 270
            ? { x: box.x + m, y: box.y + (box.height + w) / 2, angle: 270 }
            : { x: box.x + (box.width - w) / 2, y: box.y + m, angle: 0 };
    page.drawText(line, { x: pos.x, y: pos.y, size, font, color: rgb(0.5, 0.5, 0.5), rotate: degrees(pos.angle) });
  }
  return doc.save({ useObjectStreams: false });
}

// ---- Cache e concorrência ------------------------------------------------------------------------------------

type Watermarker = (pdf: Uint8Array, text: string) => Promise<Uint8Array>;
let watermarker: Watermarker = watermarkPdf;

/** Só para testes: troca a função que carimba (sem argumento, volta ao padrão). */
export function setWatermarkerForTests(fn?: Watermarker): void {
  watermarker = fn ?? watermarkPdf;
}

let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= WATERMARK_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await fn();
  } finally {
    // Passa a vaga direto para o próximo da fila (sem soltar e disputar de novo).
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

const inflight = new Map<string, Promise<string>>();

export const watermarkKey = (orderId: string, productId: string) => `wm/${orderId}/${productId}.pdf`;

export interface WatermarkRequest {
  orderId: string;
  productId: string;
  /** Arquivo original do produto no storage. */
  fileKey: string;
  text: string;
}

/**
 * Garante o PDF carimbado do item no cache e devolve a chave dele no storage (quem serve lê em fluxo, sem carregar o
 * arquivo na memória). Gera com vaga limitada se faltar; chamadas simultâneas do mesmo item compartilham a geração.
 */
export async function ensureWatermarkedPdf(req: WatermarkRequest): Promise<string> {
  const key = watermarkKey(req.orderId, req.productId);
  if (await storage.exists(key)) return key;
  const running = inflight.get(key);
  if (running) return running;
  const p = withSlot(async () => {
    if (await storage.exists(key)) return key;
    const original = await storage.get(req.fileKey);
    if (!original) throw new Error("Arquivo do produto não encontrado");
    await storage.put(key, await watermarker(original, req.text));
    return key;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
