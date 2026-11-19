import { afterEach, describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { storage } from "@/lib/storage";
import {
  FAILURE_QUARANTINE_MS,
  WatermarkFailedError,
  deleteWatermarks,
  ensureWatermarkedPdf,
  fileVersion,
  fitToFont,
  setWatermarkerForTests,
  watermarkPdf,
  watermarkText,
  type WatermarkRequest,
} from "@/lib/delivery/watermark";
import { PDF_CONCURRENCY, PDF_MAX_QUEUE, PDF_WORKER_HEAP_MB, PdfBusyError, inspectInSandbox, pdfLimiter, watermarkInSandbox } from "@/lib/pdf/sandbox";
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

describe("ensureWatermarkedPdf (cache em storage, fila e quarentena)", () => {
  const putProduct = async () => {
    const fileKey = `products/t/${crypto.randomUUID()}.pdf`;
    await storage.put(fileKey, await makeDoc(1));
    return fileKey;
  };
  const req = (fileKey: string, over: Partial<WatermarkRequest> = {}): WatermarkRequest => ({
    orderId: crypto.randomUUID(),
    productId: crypto.randomUUID(),
    fileKey,
    fileSha256: "a".repeat(64),
    text: "Licenciado para A — a@b.co",
    ...over,
  });

  test("padrão: carimba no Worker isolado e guarda em wm/<orderId>/<productId>/<versão>.pdf (lido em fluxo)", async () => {
    const r = req(await putProduct());
    const key = await ensureWatermarkedPdf(r);
    expect(key).toBe(`wm/${r.orderId}/${r.productId}/${fileVersion(r.fileKey, r.fileSha256)}.pdf`);
    const cached = await storage.get(key);
    expect((await pageTexts(cached!))[0]).toContain("Licenciado para A — a@b.co");
    const s = await storage.stream(key);
    expect(s!.size).toBe(cached!.length);
    expect(Buffer.from(await new Response(s!.body).arrayBuffer()).equals(Buffer.from(cached!))).toBe(true);
  });

  test("gera uma vez; chamadas simultâneas compartilham a geração; outra versão do arquivo = outra cópia", async () => {
    const fileKey = await putProduct();
    let calls = 0;
    setWatermarkerForTests(async (pdf, text) => {
      calls++;
      return watermarkPdf(pdf, text);
    });
    const r = req(fileKey);
    const [a, b] = await Promise.all([ensureWatermarkedPdf(r), ensureWatermarkedPdf(r)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    await ensureWatermarkedPdf(r);
    expect(calls).toBe(1);
    const other = await ensureWatermarkedPdf({ ...r, fileSha256: "b".repeat(64) });
    expect(other).not.toBe(a);
    expect(calls).toBe(2);
    await deleteWatermarks(r.orderId);
    expect(await storage.exists(a)).toBe(false);
    expect(await storage.exists(other)).toBe(false);
  });

  test(`uma geração por vez; até ${PDF_MAX_QUEUE} esperando; acima disso PdfBusyError na hora`, async () => {
    const fileKey = await putProduct();
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
    const total = 1 + PDF_MAX_QUEUE;
    const all = Array.from({ length: total }, () => ensureWatermarkedPdf(req(fileKey)));
    await until(() => gates.length === PDF_CONCURRENCY && pdfLimiter.queued === PDF_MAX_QUEUE);
    await expect(ensureWatermarkedPdf(req(fileKey))).rejects.toBeInstanceOf(PdfBusyError);
    expect(running).toBe(PDF_CONCURRENCY);
    for (let released = 0; released < total; released++) {
      await until(() => gates.length > 0);
      gates.shift()!();
    }
    await Promise.all(all);
    expect(peak).toBe(PDF_CONCURRENCY);
  });

  // Teto do container (compose.yaml, 768 MB): um único Worker de PDF por vez no processo, seja carimbo ou inspeção do
  // upload; com dois limitadores separados, um upload grande e um carimbo somavam 2 Workers e podiam matar o container.
  test("fila única: a inspeção do upload espera o carimbo em andamento; Worker com teto de 192 MB", async () => {
    expect(PDF_WORKER_HEAP_MB).toBe(192);
    expect(PDF_CONCURRENCY).toBe(1);
    const fileKey = await putProduct();
    const gates: Array<() => void> = [];
    setWatermarkerForTests(async (pdf) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return pdf;
    });
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const until = async (cond: () => boolean) => {
      while (!cond()) await tick();
    };
    const wm = ensureWatermarkedPdf(req(fileKey));
    await until(() => gates.length === 1);
    let inspected = false;
    const insp = inspectInSandbox(await makeDoc(1)).then((r) => {
      inspected = true;
      return r;
    });
    await until(() => pdfLimiter.queued === 1);
    expect(inspected).toBe(false);
    gates.shift()!();
    await wm;
    expect(await insp).toEqual({ pages: 1 });
  });

  test("falha de geração fica em quarentena por 10 min por item (não tenta de novo antes)", async () => {
    const fileKey = await putProduct();
    let now = 1_000_000;
    let calls = 0;
    setWatermarkerForTests(async () => {
      calls++;
      throw new Error("PDF: tempo-limite de 60000 ms estourado");
    }, () => now);
    const r = req(fileKey);
    await expect(ensureWatermarkedPdf(r)).rejects.toBeInstanceOf(WatermarkFailedError);
    await expect(ensureWatermarkedPdf(r)).rejects.toThrow("falhou há pouco");
    expect(calls).toBe(1);
    now += FAILURE_QUARANTINE_MS + 1;
    await expect(ensureWatermarkedPdf(r)).rejects.toBeInstanceOf(WatermarkFailedError);
    expect(calls).toBe(2);
    // outro item não é afetado pela quarentena
    await expect(ensureWatermarkedPdf(req(fileKey))).rejects.toBeInstanceOf(WatermarkFailedError);
    expect(calls).toBe(3);
  });

  test("arquivo do produto sumido: erro claro", async () => {
    await expect(ensureWatermarkedPdf(req("products/x/nao-existe.pdf"))).rejects.toThrow("Arquivo do produto não encontrado");
  });
});

describe("Worker isolado (worker_threads)", () => {
  test("carimba e inspeciona no Worker; PDF corrompido/criptografado viram códigos", async () => {
    const out = await watermarkInSandbox(await makeDoc(2), "Licenciado para João Ñúñez 😀 — j@x.co");
    expect((await pageTexts(out))[1]).toContain("Licenciado para João Ñúñez — j@x.co");
    expect(await inspectInSandbox(await makeDoc(3))).toEqual({ pages: 3 });
    expect(await inspectInSandbox(Buffer.from("%PDF-1.4\nlixo"))).toEqual({ error: "corrupt" });
  });

  test("tempo-limite: o Worker é encerrado e a tarefa falha", async () => {
    await expect(watermarkInSandbox(await makeDoc(1), "x", { timeoutMs: 1 })).rejects.toThrow("tempo-limite");
  });

  test("o buffer do chamador não é transferido (continua utilizável), inclusive Buffer do Node", async () => {
    const src = await makeDoc(1);
    const len = src.length;
    await watermarkInSandbox(src, "x");
    expect(src.length).toBe(len);
    expect((await PDFDocument.load(src)).getPageCount()).toBe(1);
    const buf = Buffer.concat([Buffer.from(src)]);
    await inspectInSandbox(buf);
    expect(buf.length).toBe(len);
  });
});
