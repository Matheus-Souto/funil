// Preenche product.page_count dos produtos enviados antes da coluna (migração 0035). Roda como job
// (backfill_page_count, agendado em src/lib/jobs/worker.ts a cada subida do app), em rodadas: cada rodada conta até
// BATCH produtos (ou até estourar o orçamento de tempo) e, se sobrar, agenda a próxima. Para no meio se o tempo-limite
// do job abortar o `signal`. Produto excluído fica de fora.
// Só o defeito do arquivo é definitivo: PDF ausente, criptografado ou inválido recebe PAGE_COUNT_UNKNOWN e não é relido
// nas próximas subidas (as leituras devolvem nulo para ele; o painel mostra "—"). Tempo-limite ou queda do Worker podem
// ser só a carga da subida: o produto fica nulo, é pulado até o fim deste processo e volta na próxima subida.
// O backfill nunca disputa a vaga do Worker de PDF com o carimbo do comprador: se ela está ocupada (ou há fila), a rodada
// para e tenta de novo mais tarde. Sem pendências, cada subida faz só uma consulta por loja. Conta as páginas no mesmo
// Worker isolado da validação do envio (src/lib/pdf/sandbox.ts).
import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import { scheduleOnce, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { db, withStore } from "@/lib/db/client";
import { product, store } from "@/lib/db/schema";
import { inspectInSandbox, PdfBusyError, pdfLimiter, type SandboxOptions } from "@/lib/pdf/sandbox";
import { storage } from "@/lib/storage";

/**
 * Produtos contados por rodada. Cada PDF pode levar até PDF_TASK_TIMEOUT_MS (60 s) no Worker; junto com
 * ROUND_BUDGET_MS, a rodada termina dentro dos 120 s do job mesmo com PDFs lentos.
 */
export const PAGE_COUNT_BATCH = 5;
/** Depois deste tempo a rodada não começa outro PDF (50 s + um PDF de até 60 s < 120 s do job). */
export const ROUND_BUDGET_MS = 50_000;
/** Marca de "não deu para contar": todo PDF tem ao menos 1 página, então 0 nunca é um valor real. */
export const PAGE_COUNT_UNKNOWN = 0;
/** Intervalo até a próxima rodada quando o lote não terminou. */
export const NEXT_ROUND_MS = 5_000;
/** Vaga do Worker de PDF ocupada (ex.: carimbo de um comprador): espera mais antes de tentar de novo. */
export const BUSY_WAIT_MS = 60_000;

/** Motivos fixos (o texto do erro do pdf-lib não vai para o log). */
export type BackfillFailure = "arquivo não encontrado no storage" | "PDF criptografado" | "PDF inválido";

/** Produtos que deram tempo-limite ou derrubaram o Worker neste processo: pulados até a próxima subida do app. */
const deferredUntilBoot = new Set<string>();

export interface BackfillResult {
  updated: number;
  /** Marcados com PAGE_COUNT_UNKNOWN: não são relidos. */
  failed: Array<{ storeId: string; productId: string; reason: BackfillFailure }>;
  /** Tempo-limite ou queda do Worker: ficam nulos e voltam na próxima subida do app. */
  deferred: Array<{ storeId: string; productId: string }>;
  /** Ficaram produtos para a próxima rodada (lote cheio, orçamento de tempo, `signal` abortado ou Worker ocupado). */
  more: boolean;
  /** A rodada parou porque o Worker de PDF estava ocupado: nada foi marcado, tenta de novo mais tarde. */
  busy: boolean;
}

export interface BackfillOptions {
  storeId?: string;
  limit?: number;
  signal?: AbortSignal;
  /** Orçamento de tempo da rodada (padrão ROUND_BUDGET_MS). */
  budgetMs?: number;
  /** Repassado ao Worker (os testes forçam um tempo-limite curto). */
  sandbox?: Pick<SandboxOptions, "timeoutMs">;
  /** Ids pulados neste processo (padrão: o conjunto do módulo; os testes passam um próprio). */
  skip?: Set<string>;
  now?: () => number;
}

/** Conta as páginas de até `limit` produtos sem page_count (todas as lojas, ou só `storeId`). */
export async function backfillPageCounts(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const limit = opts.limit ?? PAGE_COUNT_BATCH;
  const skip = opts.skip ?? deferredUntilBoot;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? ROUND_BUDGET_MS);
  // A tabela `store` não tem RLS; `product` tem (FORCE), então cada loja é lida e gravada dentro de withStore.
  const stores = opts.storeId ? [{ id: opts.storeId }] : await db.select({ id: store.id }).from(store).orderBy(asc(store.id));
  const out: BackfillResult = { updated: 0, failed: [], deferred: [], more: false, busy: false };
  let done = 0;
  const stop = () => opts.signal?.aborted || done >= limit || now() >= deadline;
  stores: for (const st of stores) {
    if (stop()) {
      out.more = true;
      break;
    }
    const skipped = [...skip];
    // Um a mais que o necessário: se vier, sobra trabalho para a próxima rodada.
    const rows = await withStore(st.id, (tx) =>
      tx
        .select({ id: product.id, fileKey: product.fileKey })
        .from(product)
        .where(and(isNull(product.pageCount), isNull(product.deletedAt), skipped.length > 0 ? notInArray(product.id, skipped) : undefined))
        .orderBy(asc(product.createdAt))
        .limit(limit - done + 1),
    );
    for (const r of rows) {
      if (stop()) {
        out.more = true;
        break;
      }
      const pages = await countPages(r.fileKey, opts.sandbox);
      // Worker ocupado é passageiro: não marca o produto (ele seria dado como "não abre" para sempre); para e tenta depois.
      if (pages === "busy") {
        out.more = true;
        out.busy = true;
        break stores;
      }
      done++;
      if (pages === "defer") {
        skip.add(r.id);
        out.deferred.push({ storeId: st.id, productId: r.id });
        continue;
      }
      await withStore(st.id, (tx) =>
        tx
          .update(product)
          .set({ pageCount: typeof pages === "number" ? pages : PAGE_COUNT_UNKNOWN })
          .where(and(eq(product.id, r.id), isNull(product.pageCount))),
      );
      if (typeof pages === "number") out.updated++;
      else out.failed.push({ storeId: st.id, productId: r.id, reason: pages });
    }
  }
  return out;
}

async function countPages(fileKey: string, sandbox: BackfillOptions["sandbox"]): Promise<number | BackfillFailure | "busy" | "defer"> {
  // Cede a vaga: com o Worker ocupado ou alguém na fila (carimbo de comprador), o backfill não entra na frente.
  if (pdfLimiter.active > 0 || pdfLimiter.queued > 0) return "busy";
  const bytes = await storage.get(fileKey);
  if (!bytes) return "arquivo não encontrado no storage";
  try {
    const res = await inspectInSandbox(bytes, { ...sandbox, transferInput: true });
    if ("error" in res) return res.error === "encrypted" ? "PDF criptografado" : "PDF inválido";
    return res.pages;
  } catch (e) {
    if (e instanceof PdfBusyError) return "busy";
    // Tempo-limite ou Worker que caiu: pode ser só a carga do momento (o mesmo PDF passou na validação do envio).
    return "defer";
  }
}

/** Agenda a próxima rodada se sobrou trabalho e o tempo do job não estourou (se estourou, a nova tentativa continua). */
export async function scheduleNextRound(r: Pick<BackfillResult, "more" | "busy">, signal: AbortSignal, now: number = Date.now()): Promise<void> {
  if (!r.more || signal.aborted) return;
  await scheduleOnce("backfill_page_count", new Date(now + (r.busy ? BUSY_WAIT_MS : NEXT_ROUND_MS)));
}

/** Job: uma rodada e, se sobrou, a próxima. */
export const backfillPageCountJob: JobHandler = async (_job, signal) => {
  const r = await backfillPageCounts({ signal });
  if (r.updated > 0) log.info("número de páginas dos produtos antigos preenchido", { count: r.updated });
  for (const f of r.failed) log.warn("não foi possível contar as páginas de um produto", f);
  for (const d of r.deferred) log.warn("contagem de páginas adiada para a próxima subida (tempo-limite ou falha do Worker)", d);
  await scheduleNextRound(r, signal);
};
