import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { offer, offerProduct, product } from "@/lib/db/schema";
import { sha256Bytes } from "@/lib/crypto";
import type { PdfInspection } from "@/lib/pdf/core";
import { PdfBusyError, inspectInSandbox } from "@/lib/pdf/sandbox";
import { storage } from "@/lib/storage";

export const MAX_PDF_BYTES = 52_428_800;
export const MAX_PDF_PAGES = 500;

/**
 * Única regra de validação do PDF (a rota de upload e a ação chamam o mesmo caminho).
 * Devolve a mensagem de erro para o usuário, ou `null` se o arquivo serve. A abertura do PDF roda isolada num Worker
 * (teto de memória e tempo, src/lib/pdf/sandbox.ts); fila cheia lança `PdfBusyError`.
 */
export async function checkPdfBytes(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length === 0 || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    return "Envie um arquivo PDF válido.";
  }
  if (bytes.length > MAX_PDF_BYTES) return "O PDF passa de 50 MB.";
  let r: PdfInspection;
  try {
    r = await inspectInSandbox(bytes);
  } catch (e) {
    if (e instanceof PdfBusyError) throw e;
    // Tempo-limite, falta de memória no Worker etc.
    return "Não conseguimos processar este PDF (grande ou complexo demais). Gere o arquivo de novo, de preferência otimizado, e envie outra vez.";
  }
  if ("error" in r) {
    return r.error === "encrypted"
      ? "O PDF está protegido por senha ou criptografado. Envie uma versão sem proteção."
      : "O PDF está corrompido ou tem estrutura inválida. Gere o arquivo de novo e envie outra vez.";
  }
  if (r.pages < 1) return "O PDF não tem páginas.";
  if (r.pages > MAX_PDF_PAGES) return `O PDF tem ${r.pages} páginas; o máximo é ${MAX_PDF_PAGES}.`;
  return null;
}

const pdfBytes = z.instanceof(Uint8Array);

const fileKeyFor = (storeId: string, productId: string) => `products/${storeId}/${productId}.pdf`;

const name = z.string().trim().min(1).max(200);
const fileName = z.string().trim().min(1).max(200);
const id = z.uuid();

const view = {
  id: product.id,
  name: product.name,
  fileName: product.fileName,
  fileSize: product.fileSize,
  createdAt: product.createdAt,
};

export const createProduct = defineAction({
  name: "products.create",
  description: "Cria um produto digital a partir de um PDF (bytes; chega pela rota de upload autenticada).",
  input: z.object({ name, fileName, file: pdfBytes }),
  permission: "products.write",
  // O arquivo nunca vai para a auditoria: só nome, nome do arquivo e tamanho.
  auditInput: (i) => ({ name: i.name, fileName: i.fileName, fileSize: i.file.length }),
  // Validação do PDF (CPU) antes de abrir a transação.
  async prepare(_call, input) {
    let problem: string | null;
    try {
      problem = await checkPdfBytes(input.file);
    } catch (e) {
      if (e instanceof PdfBusyError) throw new ActionError("rate_limited", "Outro PDF está sendo processado agora. Tente de novo em instantes.");
      throw e;
    }
    if (problem) throw new ActionError("invalid_input", problem);
  },
  async run(ctx, input) {
    const bytes = input.file;
    const productId = randomUUID();
    const fileKey = fileKeyFor(ctx.storeId, productId);
    const [row] = await ctx.tx
      .insert(product)
      .values({ id: productId, storeId: ctx.storeId, name: input.name, fileKey, fileName: input.fileName, fileSize: bytes.length, fileSha256: sha256Bytes(bytes) })
      .returning(view);
    // Último passo: se a gravação falhar, a exceção desfaz a transação.
    await storage.put(fileKey, bytes);
    return row!;
  },
  // Falha depois do put (auditoria ou commit): remove o arquivo órfão.
  compensate: (call, _input, out) => storage.delete(fileKeyFor(call.storeId, out.id)),
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
