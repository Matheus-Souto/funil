// Extração simples do texto desenhado com fonte padrão (WinAnsi) pelo pdf-lib: lê os fluxos de conteúdo de cada página
// e decodifica as strings hexadecimais dos operadores `Tj`. Basta para provar que o rodapé é texto (selecionável),
// não imagem. Só para testes.
import { PDFArray, PDFDocument, PDFRawStream, PDFRef, decodePDFRawStream, type PDFPage } from "pdf-lib";

// WinAnsi 0x80–0x9F (o resto coincide com Latin-1).
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function decodeHex(hex: string): string {
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    out += WIN_ANSI_HIGH[b] ?? String.fromCharCode(b);
  }
  return out;
}

function streamsOf(doc: PDFDocument, page: PDFPage): string[] {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs.map((r) => {
    const s = r instanceof PDFRef ? doc.context.lookup(r) : r;
    if (!(s instanceof PDFRawStream)) return "";
    return Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  });
}

/** Conteúdo bruto (operadores) de cada página, já descomprimido. */
export async function pageOperators(pdf: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((p) => streamsOf(doc, p).join("\n"));
}

/** Textos (`<hex> Tj`) de cada página. */
export async function pageTexts(pdf: Uint8Array): Promise<string[][]> {
  return (await pageOperators(pdf)).map((ops) => [...ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => decodeHex(m[1]!)));
}
