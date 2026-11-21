"use client";

// pdf.js no painel: desenha páginas de PDF num <canvas> (miniaturas, visualizador e prévia do envio). Carregado só quando
// alguma dessas telas aparece, com o worker servido pelo próprio app (nenhuma requisição a terceiros).
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");
let loader: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  loader ??= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  });
  return loader;
}

export type PdfDoc = PDFDocumentProxy;

/** Abre um PDF a partir da URL do painel ou dos bytes do arquivo escolhido. Senha ou estrutura inválida rejeitam. */
export async function openPdf(source: string | ArrayBuffer): Promise<PdfDoc> {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument(typeof source === "string" ? { url: source } : { data: new Uint8Array(source) }).promise;
}

/**
 * Começa a desenhar a página `n` (1 em diante) no canvas com a largura pedida (em px CSS), nítida em telas de alta
 * densidade. `cancel` interrompe (ex.: o tamanho mudou antes de terminar); a promessa então rejeita.
 */
export function startRender(doc: PdfDoc, n: number, canvas: HTMLCanvasElement, width: number): { promise: Promise<void>; cancel: () => void } {
  let task: { cancel: () => void } | null = null;
  let cancelled = false;
  const promise = doc.getPage(n).then(async (page) => {
    if (cancelled) throw new Error("cancelado");
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
    const t = page.render({ canvas, viewport });
    task = t;
    await t.promise;
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

/** Desenha a página `n` inteira (prévia do envio). */
export const renderPage = (doc: PdfDoc, n: number, canvas: HTMLCanvasElement, width: number) => startRender(doc, n, canvas, width).promise;

/** Largura ÷ altura da página `n` (para caber na tela sem rolar). */
export async function pageAspect(doc: PdfDoc, n: number): Promise<number> {
  const v = (await doc.getPage(n)).getViewport({ scale: 1 });
  return v.width / v.height;
}

/** PDF com senha (o servidor também recusa; aqui só para avisar antes de enviar). */
export const isPasswordError = (e: unknown) => (e as { name?: string } | null)?.name === "PasswordException";

/** URL do PDF de um produto salvo (rota do painel, sessão + products.read). */
export const productPdfUrl = (id: string) => `/admin/api/products/${id}/file`;
