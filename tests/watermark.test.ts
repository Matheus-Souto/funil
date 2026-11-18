import { afterEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { storage } from "@/lib/storage";
import {
  WATERMARK_CONCURRENCY,
  fitToFont,
  ensureWatermarkedPdf,
  setWatermarkerForTests,
  watermarkPdf,
  watermarkText,
} from "@/lib/delivery/watermark";
import { pageOperators, pageTexts } from "./pdf-text";

async function makeDoc(pages: number, opts: { rotate?: number; size?: [number, number] } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage(opts.size ?? [595, 842]);
    p.drawText(`Página ${i + 1}`, { x: 50, y: 700, size: 24, font });
    if (opts.rotate) p.setRotation(degrees(opts.rotate));
  }
  return doc.save();
}

afterEach(() => setWatermarkerForTests());

describe("watermarkText", () => {
  test("formato do brief: Licenciado para <nome> — <email>", () => {
    expect(watermarkText("Maria Souza", "maria@exemplo.com")).toBe("Licenciado para Maria Souza — maria@exemplo.com");
  });

  test("remove caracteres de controle e de formatação (inclusive inversão bidi) e junta espaços", () => {
    expect(watermarkText("Ma\u0000ria\r\n  ‮Souza\t", "a@b.co")).toBe("Licenciado para Maria Souza — a@b.co");
  });
});

describe("fitToFont (Helvetica padrão não codifica todo Unicode)", () => {
  test("acentos do Latin-1 ficam; emoji sai; letra sem glifo vira a base sem acento ou '?'", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(fitToFont(font, "João Ñúñez 😀")).toBe("João Ñúñez");
    expect(fitToFont(font, "Đỗ Ŧhị")).toBe("?o ?hi"); // ỗ e ị -> letra base; Đ e Ŧ não se decompõem -> "?"
    expect(fitToFont(font, "王小明")).toBe("???");
    expect(() => font.encodeText(fitToFont(font, "João Ñúñez 😀 👩‍👩‍👧 王"))).not.toThrow();
  });
});

describe("watermarkPdf", () => {
  test("mesmo número de páginas e o rodapé é texto extraível em todas", async () => {
    const src = await makeDoc(3);
    const text = watermarkText("João Ñúñez 😀", "joao@exemplo.com");
    const out = await watermarkPdf(src, text);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(3);
    const texts = await pageTexts(out);
    for (const page of texts) expect(page).toContain("Licenciado para João Ñúñez — joao@exemplo.com");
  });

  test("Helvetica 7 pt, cinza 50%, centralizado a 12 pt da borda inferior", async () => {
    const src = await makeDoc(1, { size: [400, 600] });
    const text = "Licenciado para Ana — ana@x.co";
    const out = await watermarkPdf(src, text);
    const ops = (await pageOperators(out))[0]!;
    expect(ops).toMatch(/0\.5 0\.5 0\.5 rg/);
    expect(ops).toMatch(/\/Helvetica[-\w]* 7 Tf/);
    const doc = await PDFDocument.create();
    const width = (await doc.embedFont(StandardFonts.Helvetica)).widthOfTextAtSize(text, 7);
    const m = [...ops.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].at(-1); // o último texto desenhado é o rodapé
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo((400 - width) / 2, 2);
    expect(Number(m![2])).toBeCloseTo(12, 2);
  });

  test("página girada (90°) e texto longo demais: não quebra e o texto cabe na página", async () => {
    const src = await makeDoc(2, { rotate: 90, size: [200, 300] });
    const out = await watermarkPdf(src, watermarkText("N".repeat(300), "x@y.co"));
    const texts = await pageTexts(out);
    expect(texts[0]!.some((s) => s.startsWith("Licenciado para NNN") && s.endsWith("…"))).toBe(true);
  });

  test("PDF corrompido lança (quem chama decide o que fazer)", async () => {
    await expect(watermarkPdf(Buffer.from("%PDF-1.4\nlixo"), "x")).rejects.toThrow();
  });
});

describe("ensureWatermarkedPdf (cache em storage e concorrência limitada)", () => {
  test("gera uma vez e guarda em wm/<orderId>/<productId>.pdf; chamadas simultâneas compartilham a geração", async () => {
    const fileKey = `products/t/${crypto.randomUUID()}.pdf`;
    await storage.put(fileKey, await makeDoc(1));
    const orderId = crypto.randomUUID();
    const productId = crypto.randomUUID();
    let calls = 0;
    setWatermarkerForTests(async (pdf, text) => {
      calls++;
      return watermarkPdf(pdf, text);
    });
    const job = { orderId, productId, fileKey, text: "Licenciado para A — a@b.co" };
    const [a, b] = await Promise.all([ensureWatermarkedPdf(job), ensureWatermarkedPdf(job)]);
    expect(calls).toBe(1);
    expect([a, b]).toEqual([`wm/${orderId}/${productId}.pdf`, `wm/${orderId}/${productId}.pdf`]);
    const cached = await storage.get(a);
    expect((await pageTexts(cached!))[0]).toContain("Licenciado para A — a@b.co");
    const s = await storage.stream(a);
    expect(s!.size).toBe(cached!.length);
    expect(Buffer.from(await new Response(s!.body).arrayBuffer()).equals(Buffer.from(cached!))).toBe(true);
    await ensureWatermarkedPdf(job);
    expect(calls).toBe(1);
  });

  test(`no máximo ${WATERMARK_CONCURRENCY} gerações ao mesmo tempo por processo`, async () => {
    const fileKey = `products/t/${crypto.randomUUID()}.pdf`;
    await storage.put(fileKey, await makeDoc(1));
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    setWatermarkerForTests(async (pdf) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return pdf;
    });
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const until = async (cond: () => boolean) => {
      while (!cond()) await tick();
    };
    const all = Array.from({ length: 5 }, () =>
      ensureWatermarkedPdf({ orderId: crypto.randomUUID(), productId: crypto.randomUUID(), fileKey, text: "x" }),
    );
    await until(() => gates.length === WATERMARK_CONCURRENCY);
    for (let i = 0; i < 20; i++) await tick();
    expect(running).toBe(WATERMARK_CONCURRENCY); // as outras 3 esperam a vez
    for (let released = 0; released < 5; released++) {
      await until(() => gates.length > 0);
      gates.shift()!();
    }
    await Promise.all(all);
    expect(peak).toBe(WATERMARK_CONCURRENCY);
  });

  test("arquivo do produto sumido: erro claro", async () => {
    await expect(
      ensureWatermarkedPdf({ orderId: crypto.randomUUID(), productId: crypto.randomUUID(), fileKey: "products/x/nao-existe.pdf", text: "x" }),
    ).rejects.toThrow("Arquivo do produto não encontrado");
  });
});
