// Mede tempo e memória do carimbo do PDF (Task 12, passo 5).
// Uso: bun scripts/watermark-bench.ts [arquivo.pdf]   (BENCH_PAGES=N muda o tamanho do PDF gerado)
// Sem arquivo, gera um PDF de 30 páginas A4 com uma imagem por página (~10 MB), parecido com um e-book ilustrado.
// Referência aceitável: < 2 s e < 200 MB por geração (servidor de 1 GB, no máximo 2 gerações simultâneas).
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, StandardFonts, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { watermarkPdf, watermarkText } from "@/lib/delivery/watermark";

async function samplePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const w = 900;
  const h = 1200;
  for (let p = 0; p < pages; p++) {
    // Gradiente com ruído: comprime como uma ilustração (não como ruído puro nem como cor chapada).
    const px = new Uint8Array(w * h * 3);
    let seed = p * 7919 + 1;
    for (let i = 0; i < w * h; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = seed % 64;
      px[i * 3] = ((i % w) / 4 + n) & 255;
      px[i * 3 + 1] = (Math.floor(i / w) / 5 + n) & 255;
      px[i * 3 + 2] = (p * 9 + n) & 255;
    }
    const img = doc.context.stream(deflateSync(px), {
      Type: "XObject",
      Subtype: "Image",
      Width: w,
      Height: h,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "FlateDecode",
    });
    const ref = doc.context.register(img);
    const page = doc.addPage([595, 842]);
    const name = page.node.newXObject("Im", ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(495, 0, 0, 660, 50, 120), drawObject(PDFName.of(name.asString().slice(1))), popGraphicsState());
    page.drawText(`Página ${p + 1}: história ilustrada`, { x: 50, y: 800, size: 18, font });
  }
  return doc.save();
}

const file = process.argv[2];
const genPages = Number(process.env.BENCH_PAGES ?? 30);
const input = file ? new Uint8Array(readFileSync(file)) : await samplePdf(genPages);
const pages = (await PDFDocument.load(input, { updateMetadata: false })).getPageCount();
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

const rss0 = process.memoryUsage().rss;
let peak = rss0;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 5);
const t0 = performance.now();
const out = await watermarkPdf(input, watermarkText("João Ñúñez 😀", "joao.nunez@exemplo.com"));
const ms = performance.now() - t0;
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().rss);

console.log(
  JSON.stringify({
    runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
    input: file ?? `gerado (${genPages} páginas com imagem)`,
    pages,
    inMB: mb(input.length),
    outMB: mb(out.length),
    ms: Math.round(ms),
    rssBeforeMB: mb(rss0),
    rssPeakMB: mb(peak),
    rssDeltaMB: mb(peak - rss0),
  }),
);
