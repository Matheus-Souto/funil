// Preenche product.page_count dos produtos enviados antes da coluna (migração 0035). Roda como job
// (backfill_page_count, agendado em src/lib/jobs/worker.ts a cada subida do app), em lotes: cada rodada conta até
// BATCH produtos e, se sobrar, agenda a próxima. Para no meio se o tempo-limite do job abortar o `signal`. Produto
// excluído fica de fora. PDF que não dá para contar (arquivo ausente, criptografado, inválido) recebe PAGE_COUNT_UNKNOWN
// e não é relido nas próximas subidas; as leituras devolvem nulo para ele (o painel mostra "—").
// Sem pendências, cada subida faz só uma consulta por loja. Conta as páginas no mesmo Worker isolado da validação do
// envio (src/lib/pdf/sandbox.ts).
import { and, asc, eq, isNull } from "drizzle-orm";
import { scheduleOnce, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { db, withStore } from "@/lib/db/client";
import { product, store } from "@/lib/db/schema";
import { inspectInSandbox } from "@/lib/pdf/sandbox";
import { storage } from "@/lib/storage";

/** Produtos contados por rodada do job (cada PDF vai ao Worker isolado; o lote cabe folgado nos 120 s do job). */
export const PAGE_COUNT_BATCH = 20;
/** Marca de "não deu para contar": todo PDF tem ao menos 1 página, então 0 nunca é um valor real. */
export const PAGE_COUNT_UNKNOWN = 0;
/** Intervalo até a próxima rodada quando o lote não terminou. */
const NEXT_ROUND_MS = 5_000;

/** Motivos fixos (o texto do erro do pdf-lib não vai para o log). */
export type BackfillFailure = "arquivo não encontrado no storage" | "PDF criptografado" | "PDF inválido" | "falha ao abrir o PDF";

export interface BackfillResult {
  updated: number;
  /** Marcados com PAGE_COUNT_UNKNOWN: não são relidos. */
  failed: Array<{ storeId: string; productId: string; reason: BackfillFailure }>;
  /** Ficaram produtos para a próxima rodada (lote cheio ou `signal` abortado). */
  more: boolean;
}

/** Conta as páginas de até `limit` produtos sem page_count (todas as lojas, ou só `storeId`). */
export async function backfillPageCounts(opts: { storeId?: string; limit?: number; signal?: AbortSignal } = {}): Promise<BackfillResult> {
  const limit = opts.limit ?? PAGE_COUNT_BATCH;
  // A tabela `store` não tem RLS; `product` tem (FORCE), então cada loja é lida e gravada dentro de withStore.
  const stores = opts.storeId ? [{ id: opts.storeId }] : await db.select({ id: store.id }).from(store).orderBy(asc(store.id));
  const out: BackfillResult = { updated: 0, failed: [], more: false };
  let done = 0;
  for (const st of stores) {
    if (opts.signal?.aborted || done >= limit) {
      out.more = true;
      break;
    }
    // Um a mais que o necessário: se vier, sobra trabalho para a próxima rodada.
    const rows = await withStore(st.id, (tx) =>
      tx
        .select({ id: product.id, fileKey: product.fileKey })
        .from(product)
        .where(and(isNull(product.pageCount), isNull(product.deletedAt)))
        .orderBy(asc(product.createdAt))
        .limit(limit - done + 1),
    );
    for (const r of rows) {
      if (opts.signal?.aborted || done >= limit) {
        out.more = true;
        break;
      }
      done++;
      const pages = await countPages(r.fileKey);
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

async function countPages(fileKey: string): Promise<number | BackfillFailure> {
  const bytes = await storage.get(fileKey);
  if (!bytes) return "arquivo não encontrado no storage";
  try {
    const res = await inspectInSandbox(bytes);
    if ("error" in res) return res.error === "encrypted" ? "PDF criptografado" : "PDF inválido";
    return res.pages;
  } catch {
    return "falha ao abrir o PDF";
  }
}

/** Job: uma rodada; se sobrou e o tempo não estourou, agenda a próxima (se estourou, a nova tentativa do job continua). */
export const backfillPageCountJob: JobHandler = async (_job, signal) => {
  const r = await backfillPageCounts({ signal });
  if (r.updated > 0) log.info("número de páginas dos produtos antigos preenchido", { count: r.updated });
  for (const f of r.failed) log.warn("não foi possível contar as páginas de um produto", f);
  if (r.more && !signal.aborted) await scheduleOnce("backfill_page_count", new Date(Date.now() + NEXT_ROUND_MS));
};
