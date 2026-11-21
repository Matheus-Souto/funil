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

/** Desenha a página `n` (1 em diante) no canvas com a largura pedida (em px CSS), nítida em telas de alta densidade. */
export async function renderPage(doc: PdfDoc, n: number, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: (width / base.width) * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
  await page.render({ canvas, viewport }).promise;
}

/** PDF com senha (o servidor também recusa; aqui só para avisar antes de enviar). */
export const isPasswordError = (e: unknown) => (e as { name?: string } | null)?.name === "PasswordException";

/** URL do PDF de um produto salvo (rota do painel, sessão + products.read). */
export const productPdfUrl = (id: string) => `/admin/api/products/${id}/file`;
