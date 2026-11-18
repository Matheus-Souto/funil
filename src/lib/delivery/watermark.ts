// PDF personalizado: rodapé "Licenciado para <nome> — <email>" em todas as páginas (o carimbo em si está em
// src/lib/pdf/core.ts e roda isolado num Worker, src/lib/pdf/sandbox.ts). O resultado fica em cache no storage em
// `wm/<orderId>/<productId>/<versão do arquivo>.pdf`: trocar o arquivo do produto gera cópias novas. A geração é feita
// pelo job de entrega (depois do e-mail), pela página do link e, se faltar, no download. Uma geração por vez no
// processo, até 20 esperando (acima disso `PdfBusyError`); falha de geração fica em quarentena por 10 min por item.
import * as PdfLib from "pdf-lib";
import { sha256 } from "@/lib/crypto";
import { pdfCore } from "@/lib/pdf/core";
import { PdfBusyError, watermarkInSandbox, watermarkLimiter } from "@/lib/pdf/sandbox";
import { storage } from "@/lib/storage";

export const WATERMARK_FONT_SIZE = 7;
export const WATERMARK_MARGIN = 12;
export const WATERMARK_CONCURRENCY = 1;
export const WATERMARK_MAX_QUEUE = 20;
export const FAILURE_QUARANTINE_MS = 10 * 60 * 1000;
const NAME_MAX = 80;
const EMAIL_MAX = 254;

// Mesmo código que roda no Worker, aqui no processo (testes e ferramentas; o app usa o Worker).
const core = pdfCore(PdfLib);
export const fitToFont = core.fitToFont;
/** Carimba NO PROCESSO atual. O app usa `ensureWatermarkedPdf` (Worker isolado); esta é para testes e o benchmark. */
export const watermarkPdf = core.watermarkPdf;

const BREAKS = /[\t\n\v\f\r\x85\p{Zl}\p{Zp}]/gu;
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

function clean(s: string, max: number): string {
  return s.replace(BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Texto do rodapé: `Licenciado para <nome> — <email>`, sem caracteres de controle e com tamanho limitado. */
export function watermarkText(name: string, email: string): string {
  return `Licenciado para ${clean(name, NAME_MAX)} — ${clean(email, EMAIL_MAX)}`;
}

// ---- Cache, fila e quarentena ----------------------------------------------------------------------------------

type Watermarker = (pdf: Uint8Array, text: string) => Promise<Uint8Array>;
// O original lido do storage não é usado depois: vai para o Worker sem cópia.
const defaultWatermarker: Watermarker = (pdf, text) => watermarkInSandbox(pdf, text, { transferInput: true });
let watermarker: Watermarker = defaultWatermarker;
let clock: () => number = () => Date.now();

/** Só para testes: troca a função que carimba e o relógio (sem argumento, volta ao padrão). */
export function setWatermarkerForTests(fn?: Watermarker, now?: () => number): void {
  watermarker = fn ?? defaultWatermarker;
  clock = now ?? (() => Date.now());
  failures.clear();
}

/** Versão do arquivo do produto: muda quando `file_key` ou o conteúdo (`file_sha256`) muda. */
export const fileVersion = (fileKey: string, fileSha256: string | null) => sha256(`${fileKey}:${fileSha256 ?? ""}`).slice(0, 16);

export const watermarkDir = (orderId: string, productId?: string) => (productId ? `wm/${orderId}/${productId}` : `wm/${orderId}`);
export const watermarkKey = (orderId: string, productId: string, version: string) => `${watermarkDir(orderId, productId)}/${version}.pdf`;

/** Apaga as cópias carimbadas do pedido (ou de um item). */
export async function deleteWatermarks(orderId: string, productId?: string): Promise<void> {
  await storage.deletePrefix(watermarkDir(orderId, productId));
}

export interface WatermarkRequest {
  orderId: string;
  productId: string;
  /** Arquivo original do produto no storage. */
  fileKey: string;
  fileSha256: string | null;
  text: string;
}

export class WatermarkFailedError extends Error {
  constructor(cause: string) {
    super(`Não foi possível gerar o PDF carimbado: ${cause}`);
    this.name = "WatermarkFailedError";
  }
}

const failures = new Map<string, number>();
const inflight = new Map<string, Promise<string>>();

/**
 * Garante o PDF carimbado do item no cache e devolve a chave no storage (quem serve lê em fluxo). Gera se faltar.
 * Lança `PdfBusyError` com a fila cheia (não entra em quarentena) e `WatermarkFailedError` se a geração falhou agora
 * ou nos últimos 10 min.
 */
export async function ensureWatermarkedPdf(req: WatermarkRequest): Promise<string> {
  const key = watermarkKey(req.orderId, req.productId, fileVersion(req.fileKey, req.fileSha256));
  if (await storage.exists(key)) return key;
  const item = `${req.orderId}/${req.productId}`;
  const until = failures.get(item);
  if (until !== undefined && until > clock()) throw new WatermarkFailedError("falhou há pouco; nova tentativa em alguns minutos");
  const running = inflight.get(key);
  if (running) return running;
  const p = watermarkLimiter
    .run(async () => {
      if (await storage.exists(key)) return key;
      const original = await storage.get(req.fileKey);
      if (!original) throw new Error("Arquivo do produto não encontrado");
      await storage.put(key, await watermarker(original, req.text));
      return key;
    })
    .then(
      (k) => {
        failures.delete(item);
        return k;
      },
      (e: unknown) => {
        if (e instanceof PdfBusyError) throw e;
        failures.set(item, clock() + FAILURE_QUARANTINE_MS);
        throw new WatermarkFailedError(e instanceof Error ? e.message : String(e));
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
