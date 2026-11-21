// Preenche product.page_count dos produtos enviados antes da coluna (migração 0035). Roda como job uma vez a cada subida
// do app (backfill_page_count, agendado em src/lib/jobs/worker.ts); é idempotente: só toca produtos com page_count nulo,
// então depois da primeira vez só faz uma leitura por loja. Conta as páginas no mesmo Worker isolado da validação do envio
// (src/lib/pdf/sandbox.ts).
import { and, asc, eq, isNull } from "drizzle-orm";
import type { JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { db, withStore } from "@/lib/db/client";
import { product, store } from "@/lib/db/schema";
import { inspectInSandbox } from "@/lib/pdf/sandbox";
import { storage } from "@/lib/storage";

export interface BackfillResult {
  updated: number;
  /** Arquivo ausente no storage ou PDF que não abre: continua nulo (o painel mostra "—"). */
  failed: Array<{ storeId: string; productId: string; reason: string }>;
}

/** Varre as lojas (ou só `storeId`) e grava o número de páginas de cada produto que ainda não tem. */
export async function backfillPageCounts(opts: { storeId?: string } = {}): Promise<BackfillResult> {
  // A tabela `store` não tem RLS; `product` tem (FORCE), então cada loja é lida e gravada dentro de withStore.
  const stores = opts.storeId
    ? [{ id: opts.storeId }]
    : await db.select({ id: store.id }).from(store).orderBy(asc(store.id));
  const out: BackfillResult = { updated: 0, failed: [] };
  for (const st of stores) {
    const rows = await withStore(st.id, (tx) =>
      tx.select({ id: product.id, fileKey: product.fileKey }).from(product).where(isNull(product.pageCount)).orderBy(asc(product.createdAt)),
    );
    for (const r of rows) {
      const bytes = await storage.get(r.fileKey);
      if (!bytes) {
        out.failed.push({ storeId: st.id, productId: r.id, reason: "arquivo não encontrado no storage" });
        continue;
      }
      let pages: number;
      try {
        const res = await inspectInSandbox(bytes);
        if ("error" in res) {
          out.failed.push({ storeId: st.id, productId: r.id, reason: res.error === "encrypted" ? "PDF criptografado" : "PDF inválido" });
          continue;
        }
        pages = res.pages;
      } catch (e) {
        out.failed.push({ storeId: st.id, productId: r.id, reason: e instanceof Error ? e.message : "falha ao abrir o PDF" });
        continue;
      }
      await withStore(st.id, (tx) =>
        tx
          .update(product)
          .set({ pageCount: pages })
          .where(and(eq(product.id, r.id), isNull(product.pageCount))),
      );
      out.updated++;
    }
  }
  return out;
}

/** Job da subida: preenche e registra o que não deu para contar (esses ficam com "—" no painel; o job não repete). */
export const backfillPageCountJob: JobHandler = async () => {
  const r = await backfillPageCounts();
  if (r.updated > 0) log.info("número de páginas dos produtos antigos preenchido", { count: r.updated });
  for (const f of r.failed) log.warn("não foi possível contar as páginas de um produto", f);
};
