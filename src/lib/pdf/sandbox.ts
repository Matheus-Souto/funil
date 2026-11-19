// Processamento de PDF isolado em `worker_threads` (servidor de 1 GB): cada tarefa roda num Worker próprio com teto de
// heap (`resourceLimits.maxOldGenerationSizeMb`) e tempo-limite (o Worker é encerrado ao estourar). Um PDF malicioso ou
// gigante derruba só o Worker, nunca o processo do app.
//
// Como o Worker é carregado: o código vem de `pdfCore.toString()` (src/lib/pdf/core.ts, autossuficiente) e roda com
// `eval: true`, recebendo `require("pdf-lib")`. Assim não há arquivo de Worker separado para o bundler do Next copiar:
// funciona igual no `next start` (Node), no `output: "standalone"` (o pdf-lib já é rastreado porque o app o importa) e
// nos testes (Bun). O `require` do Worker resolve a partir do diretório de trabalho do processo (onde fica node_modules).
//
// Concorrência por tipo de tarefa (fila limitada; fila cheia = `PdfBusyError`, "tente em instantes").
import { Worker } from "node:worker_threads";
import { pdfCore, type PdfInspection } from "./core";

// Orçamento de memória (container do app com 768 MB, ver docs/instalacao.md): processo do Next + UM Worker por vez
// (heap até 192 MB) + os buffers do PDF (até 50 MB de entrada e a saída) fora do heap do Worker.
export const PDF_WORKER_HEAP_MB = 192;
/** Um Worker de PDF por vez no processo inteiro (carimbo e inspeção do upload dividem a mesma vaga). */
export const PDF_CONCURRENCY = 1;
export const PDF_MAX_QUEUE = 20;
export const PDF_TASK_TIMEOUT_MS = 60_000;

export class PdfBusyError extends Error {
  constructor() {
    super("Processamento de PDF ocupado; tente em instantes");
    this.name = "PdfBusyError";
  }
}

/** Fila com `concurrency` vagas e no máximo `maxQueue` esperando; acima disso, `PdfBusyError` na hora. */
export function createLimiter(concurrency: number, maxQueue: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= concurrency) {
        if (waiting.length >= maxQueue) throw new PdfBusyError();
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else active++;
      try {
        return await fn();
      } finally {
        // Passa a vaga direto para o próximo (sem soltar e disputar de novo).
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const core = (${pdfCore.toString()})(require("pdf-lib"));
parentPort.once("message", async (m) => {
  try {
    if (m.op === "watermark") {
      const out = await core.watermarkPdf(m.pdf, m.text);
      const whole = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength;
      parentPort.postMessage({ ok: true, pdf: out }, whole ? [out.buffer] : []);
    } else if (m.op === "inspect") {
      parentPort.postMessage({ ok: true, result: await core.inspectPdf(m.pdf) });
    } else {
      parentPort.postMessage({ ok: false, error: "operação desconhecida" });
    }
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
});
`;

export interface SandboxOptions {
  timeoutMs?: number;
  heapMb?: number;
  /**
   * Entrega o buffer de entrada ao Worker sem copiar (o chamador NÃO pode usá-lo depois). Poupa uma cópia do PDF
   * (até 50 MB) na memória. Só vale para um Uint8Array que ocupa o ArrayBuffer inteiro; senão, copia.
   */
  transferInput?: boolean;
}

type Reply = { ok: true; pdf?: Uint8Array; result?: unknown } | { ok: false; error: string };

/** Roda uma tarefa num Worker novo; encerra o Worker ao terminar, ao estourar o tempo ou em erro. */
function runInWorker(msg: { op: string; pdf: Uint8Array; text?: string }, opts: SandboxOptions = {}): Promise<Reply & { ok: true }> {
  const timeoutMs = opts.timeoutMs ?? PDF_TASK_TIMEOUT_MS;
  const whole = msg.pdf.byteOffset === 0 && msg.pdf.byteLength === msg.pdf.buffer.byteLength && msg.pdf.buffer instanceof ArrayBuffer;
  // Sem `transferInput`: cópia própria (transferida ao Worker) e o chamador continua com o seu buffer. Não usar
  // `.slice()`: num Buffer do Node ele devolve uma VISTA do mesmo ArrayBuffer, e transferir a vista o esvaziaria.
  let pdf = msg.pdf;
  if (!(opts.transferInput && whole)) {
    pdf = new Uint8Array(msg.pdf.byteLength);
    pdf.set(msg.pdf);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: opts.heapMb ?? PDF_WORKER_HEAP_MB } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`PDF: tempo-limite de ${timeoutMs} ms estourado`))), timeoutMs);
    timer.unref?.();
    worker.once("message", (r: Reply) => finish(() => (r.ok ? resolve(r) : reject(new Error(`PDF: ${r.error}`)))));
    worker.once("error", (e) => finish(() => reject(new Error(`PDF: o processamento falhou (${e.message})`))));
    worker.once("exit", (code) => finish(() => reject(new Error(`PDF: o processamento terminou sem resposta (código ${code})`))));
    worker.postMessage({ ...msg, pdf }, [pdf.buffer as ArrayBuffer]);
  });
}

/**
 * Fila ÚNICA de todo processamento de PDF (carimbo e inspeção do upload): 1 Worker por vez, até 20 esperando (acima
 * disso `PdfBusyError` na hora). Dois limitadores separados permitiam 2 Workers simultâneos, o que estoura o teto de
 * memória do container e derruba todas as lojas de uma vez.
 */
export const pdfLimiter = createLimiter(PDF_CONCURRENCY, PDF_MAX_QUEUE);

export async function watermarkInSandbox(pdf: Uint8Array, text: string, opts: SandboxOptions = {}): Promise<Uint8Array> {
  const r = await runInWorker({ op: "watermark", pdf, text }, opts);
  return new Uint8Array(r.pdf!);
}

export async function inspectInSandbox(pdf: Uint8Array, opts: SandboxOptions = {}): Promise<PdfInspection> {
  return pdfLimiter.run(async () => (await runInWorker({ op: "inspect", pdf }, opts)).result as PdfInspection);
}
