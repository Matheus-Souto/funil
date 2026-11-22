import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { offer, offerProduct, product } from "@/lib/db/schema";
import { sha256Bytes } from "@/lib/crypto";
import type { PdfInspection } from "@/lib/pdf/core";
import { PdfBusyError, inspectInSandbox } from "@/lib/pdf/sandbox";
import { storage } from "@/lib/storage";

export const MAX_PDF_BYTES = 52_428_800;
/**
 * Teto de páginas do PDF de produto. O carimbo (nome e e-mail do comprador) passa por todas as páginas: medido em
 * 21/11/2026 com o Almanaque Bíblico Kids real (551 páginas, 5,3 MB), a inspeção levou ~0,8 s e o carimbo ~2 s no Worker
 * (teto de 192 MB e 60 s, src/lib/pdf/sandbox.ts). PDFs pesados continuam barrados pelos 50 MB e pelo tempo-limite.
 */
export const MAX_PDF_PAGES = 1000;

/**
 * Única regra de validação do PDF (a rota de upload e a ação chamam o mesmo caminho).
 * Devolve a mensagem de erro para o usuário, ou o número de páginas se o arquivo serve. A abertura do PDF roda isolada num Worker
 * (teto de memória e tempo, src/lib/pdf/sandbox.ts); fila cheia lança `PdfBusyError`.
 */
async function inspectProductPdf(bytes: Uint8Array): Promise<{ problem: string } | { pages: number }> {
  if (bytes.length === 0 || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    return { problem: "Envie um arquivo PDF válido." };
  }
  if (bytes.length > MAX_PDF_BYTES) return { problem: "O PDF passa de 50 MB." };
  let r: PdfInspection;
  try {
    r = await inspectInSandbox(bytes);
  } catch (e) {
    if (e instanceof PdfBusyError) throw e;
    // Tempo-limite, falta de memória no Worker etc.
    return { problem: "Não conseguimos processar este PDF (grande ou complexo demais). Gere o arquivo de novo, de preferência otimizado, e envie outra vez." };
  }
  if ("error" in r) {
    return {
      problem:
        r.error === "encrypted"
          ? "O PDF está protegido por senha ou criptografado. Envie uma versão sem proteção."
          : "O PDF está corrompido ou tem estrutura inválida. Gere o arquivo de novo e envie outra vez.",
    };
  }
  if (r.pages < 1) return { problem: "O PDF não tem páginas." };
  if (r.pages > MAX_PDF_PAGES) return { problem: `O PDF tem ${r.pages} páginas; o máximo é ${MAX_PDF_PAGES}.` };
  return { pages: r.pages };
}

/** A mesma validação, só com a mensagem de erro (`null` se o arquivo serve). */
export async function checkPdfBytes(bytes: Uint8Array): Promise<string | null> {
  const r = await inspectProductPdf(bytes);
  return "problem" in r ? r.problem : null;
}

export const pdfBytes = z.instanceof(Uint8Array);

const fileKeyFor = (storeId: string, productId: string) => `products/${storeId}/${productId}.pdf`;

const name = z.string().trim().min(1).max(200);
const fileName = z.string().trim().min(1).max(200);
/** Regras do nome do produto e do nome do arquivo (o link de upload do MCP valida igual a `products.create`). */
export { name as productName, fileName as productFileName };
const id = z.uuid();

const view = {
  id: product.id,
  name: product.name,
  fileName: product.fileName,
  fileSize: product.fileSize,
  // 0 marca o PDF que o backfill não conseguiu contar (src/lib/catalog/page-count.ts): para quem lê, é desconhecido.
  pageCount: sql<number | null>`nullif(${product.pageCount}, 0)`,
  createdAt: product.createdAt,
};

/**
 * Validação do PDF de um produto novo, no `prepare` da ação (CPU, antes de abrir a transação): problema no arquivo vira
 * `invalid_input` com a mensagem de `checkPdfBytes`; fila do Worker cheia vira `rate_limited`. Devolve o número de páginas,
 * que fica gravado no produto.
 */
export async function assertProductPdf(bytes: Uint8Array): Promise<{ pages: number }> {
  let r: Awaited<ReturnType<typeof inspectProductPdf>>;
  try {
    r = await inspectProductPdf(bytes);
  } catch (e) {
    if (e instanceof PdfBusyError) throw new ActionError("rate_limited", "Outro PDF está sendo processado agora. Tente de novo em instantes.");
    throw e;
  }
  if ("problem" in r) throw new ActionError("invalid_input", r.problem);
  return r;
}

/** Linha do produto novo (na transação da ação). O arquivo vai depois, com `putProductFile`, como último passo. */
export async function insertProductRow(ctx: Ctx, p: { name: string; fileName: string; bytes: Uint8Array; pages: number }) {
  const productId = randomUUID();
  const [row] = await ctx.tx
    .insert(product)
    .values({
      id: productId,
      storeId: ctx.storeId,
      name: p.name,
      fileKey: fileKeyFor(ctx.storeId, productId),
      fileName: p.fileName,
      fileSize: p.bytes.length,
      fileSha256: sha256Bytes(p.bytes),
      pageCount: p.pages,
    })
    .returning(view);
  return row!;
}

/** Grava o PDF do produto. Último passo de `run`: se a gravação falhar, a exceção desfaz a transação. */
export const putProductFile = (storeId: string, productId: string, bytes: Uint8Array) => storage.put(fileKeyFor(storeId, productId), bytes);

/** Remove o PDF órfão (compensação: falha depois do put, na auditoria ou no commit). */
export const removeProductFile = (storeId: string, productId: string) => storage.delete(fileKeyFor(storeId, productId));

export const createProduct = defineAction({
  name: "products.create",
  description: "Cria um produto digital a partir de um PDF (bytes; chega pela rota de upload autenticada).",
  input: z.object({ name, fileName, file: pdfBytes }),
  permission: "products.write",
  // O arquivo nunca vai para a auditoria: só nome, nome do arquivo e tamanho.
  auditInput: (i) => ({ name: i.name, fileName: i.fileName, fileSize: i.file.length }),
  // Validação do PDF (CPU) antes de abrir a transação.
  prepare: (_call, input) => assertProductPdf(input.file),
  async run(ctx, input, pdf) {
    const row = await insertProductRow(ctx, { name: input.name, fileName: input.fileName, bytes: input.file, pages: pdf.pages });
    await putProductFile(ctx.storeId, row.id, input.file);
    return row;
  },
  compensate: (call, _input, out) => removeProductFile(call.storeId, out.id),
});

export const updateProduct = defineAction({
  name: "products.update",
  description: "Renomeia um produto.",
  input: z.strictObject({ id, name: name.optional(), fileName: fileName.optional() }),
  permission: "products.write",
  async run(ctx, input) {
    const set = { ...(input.name !== undefined && { name: input.name }), ...(input.fileName !== undefined && { fileName: input.fileName }) };
    const where = and(eq(product.id, input.id), isNull(product.deletedAt));
    const [row] = Object.keys(set).length
      ? await ctx.tx.update(product).set(set).where(where).returning(view)
      : await ctx.tx.select(view).from(product).where(where);
    if (!row) throw new ActionError("not_found", "Produto não encontrado");
    return row;
  },
});

export const listProducts = defineAction({
  name: "products.list",
  description: "Lista os produtos da loja (sem excluídos).",
  input: z.object({}),
  permission: "products.read",
  audit: false,
  run: (ctx) => ctx.tx.select(view).from(product).where(isNull(product.deletedAt)).orderBy(desc(product.createdAt)),
});

/** PDF de um produto da loja, para o painel mostrar a miniatura e o visualizador ("Ver PDF"). Fora do MCP. */
export const readProductFile = defineAction({
  name: "products.file",
  description: "PDF original de um produto, sem carimbo (só o painel: visualizador \"Ver PDF\").",
  input: z.object({ id }),
  // O arquivo sem carimbo é o que a pirataria quer: só quem pode alterar o catálogo (dono e admin) baixa, e cada
  // download fica na auditoria (só o id do produto, nunca os bytes).
  permission: "products.write",
  auditInput: (i) => ({ productId: i.id }),
  async run(ctx, input) {
    const [row] = await ctx.tx
      .select({ id: product.id, fileName: product.fileName })
      .from(product)
      .where(and(eq(product.id, input.id), isNull(product.deletedAt)));
    if (!row) throw new ActionError("not_found", "Produto não encontrado");
    const bytes = await storage.get(fileKeyFor(ctx.storeId, row.id));
    if (!bytes) throw new ActionError("not_found", "Arquivo do produto não encontrado");
    return { fileName: row.fileName, bytes };
  },
});

export const deleteProduct = defineAction({
  name: "products.delete",
  description: "Exclui um produto (soft delete; o arquivo é mantido para pedidos antigos).",
  input: z.object({ id }),
  permission: "products.write",
  sensitive: true,
  async run(ctx, input) {
    const [found] = await ctx.tx.select({ id: product.id }).from(product).where(and(eq(product.id, input.id), isNull(product.deletedAt)));
    if (!found) throw new ActionError("not_found", "Produto não encontrado");
    // Em qualquer posição da oferta (principal ou bump).
    const [inUse] = await ctx.tx
      .select({ id: offer.id })
      .from(offerProduct)
      .innerJoin(offer, eq(offer.id, offerProduct.offerId))
      .where(and(eq(offer.active, true), eq(offerProduct.productId, input.id)))
      .limit(1);
    if (inUse) throw new ActionError("conflict", "Produto usado por uma oferta ativa");
    await ctx.tx.update(product).set({ deletedAt: new Date() }).where(eq(product.id, input.id));
    return { id: input.id };
  },
});
