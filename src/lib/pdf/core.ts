// Núcleo do processamento de PDF (carimbo do rodapé e inspeção do upload).
//
// ATENÇÃO: `pdfCore` é AUTOSSUFICIENTE. Ela é serializada com `toString()` e executada dentro de um Worker
// (src/lib/pdf/sandbox.ts), onde só existem os globais do Node e o `pdf-lib` recebido como argumento. Não use dentro
// dela nada importado ou declarado fora (constantes, helpers, outros módulos); só tipos (apagados na compilação).
import type * as PdfLib from "pdf-lib";
import type { PDFFont } from "pdf-lib";

export type PdfInspection = { pages: number } | { error: "encrypted" | "corrupt" };

export function pdfCore(lib: typeof PdfLib) {
  const { PDFDocument, StandardFonts, degrees, rgb } = lib;
  const SIZE = 7;
  const MARGIN = 12;
  /** Quebras e tabulações viram espaço; os demais de controle (Cc) e de formatação (Cf: bidi, ZWJ, BOM...) somem. */
  const BREAKS = /[\t\n\v\f\r\x85\p{Zl}\p{Zp}]/gu;
  const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
  /** Emoji, seletores de variação, tons de pele e bandeiras: a fonte padrão não tem. */
  const PICTOGRAPHIC = /[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu;

  /**
   * Ajusta o texto ao que a fonte padrão (WinAnsi) codifica: emoji saem; letra sem glifo vira a letra base sem acento
   * (NFD) se a fonte tiver a base, senão "?". Nunca lança (`font.encodeText` lança em caractere não suportado).
   */
  function fitToFont(font: PDFFont, text: string): string {
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

  /**
   * Rodapé em todas as páginas: Helvetica 7 pt, cinza 50%, centralizado a 12 pt da borda inferior VISUAL (respeita
   * `/Rotate` e o CropBox). PDF inválido lança.
   */
  async function watermarkPdf(pdf: Uint8Array, text: string): Promise<Uint8Array> {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const safe = fitToFont(font, text);
    for (const page of doc.getPages()) {
      const box = page.getCropBox();
      const rotation = ((page.getRotation().angle % 360) + 360) % 360;
      const sideways = rotation === 90 || rotation === 270;
      const visibleWidth = sideways ? box.height : box.width;
      const line = fitWidth(font, safe, SIZE, Math.max(visibleWidth - 2 * MARGIN, 10));
      const w = font.widthOfTextAtSize(line, SIZE);
      const m = MARGIN;
      const pos =
        rotation === 90
          ? { x: box.x + box.width - m, y: box.y + (box.height - w) / 2, angle: 90 }
          : rotation === 180
            ? { x: box.x + (box.width + w) / 2, y: box.y + box.height - m, angle: 180 }
            : rotation === 270
              ? { x: box.x + m, y: box.y + (box.height + w) / 2, angle: 270 }
              : { x: box.x + (box.width - w) / 2, y: box.y + m, angle: 0 };
      page.drawText(line, { x: pos.x, y: pos.y, size: SIZE, font, color: rgb(0.5, 0.5, 0.5), rotate: degrees(pos.angle) });
    }
    return doc.save({ useObjectStreams: false });
  }

  /** Abre o PDF e conta as páginas; criptografado e corrompido viram códigos (a mensagem fica com quem chama). */
  async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
    try {
      // getPageCount também lança em PDF sem árvore de páginas.
      return { pages: (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount() };
    } catch (e) {
      const err = e as { message?: unknown } | null;
      if (e instanceof lib.EncryptedPDFError || /encrypted/i.test(String(err?.message ?? ""))) return { error: "encrypted" };
      return { error: "corrupt" };
    }
  }

  return { fitToFont, watermarkPdf, inspectPdf };
}
