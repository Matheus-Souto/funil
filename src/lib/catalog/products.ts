import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { offer, product } from "@/lib/db/schema";
import { storage } from "@/lib/storage";

export const MAX_PDF_BYTES = 52_428_800;
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decodifica base64 e valida PDF (`%PDF-`, até 50 MB). Devolve null se inválido. */
export function decodePdfBase64(b64: string): Uint8Array | null {
  if (b64.length === 0 || b64.length > MAX_BASE64_CHARS || b64.length % 4 !== 0 || !BASE64.test(b64)) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) return null;
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

const pdfBase64 = z.string().max(MAX_BASE64_CHARS);

/** Tamanho decodificado aproximado, sem decodificar (para auditoria). */
function base64Size(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

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
  description: "Cria um produto digital a partir de um PDF (base64).",
  input: z.object({ name, fileName, fileBase64: pdfBase64 }),
  permission: "products.write",
  // O arquivo nunca vai para a auditoria: só nome, nome do arquivo e tamanho.
  auditInput: (i) => ({ name: i.name, fileName: i.fileName, fileSize: base64Size(i.fileBase64) }),
  async run(ctx, input) {
    const bytes = decodePdfBase64(input.fileBase64);
    if (!bytes) throw new ActionError("invalid_input", "Envie um PDF válido de até 50 MB");
    const productId = randomUUID();
    const fileKey = fileKeyFor(ctx.storeId, productId);
    const [row] = await ctx.tx
      .insert(product)
      .values({ id: productId, storeId: ctx.storeId, name: input.name, fileKey, fileName: input.fileName, fileSize: bytes.length })
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
    const [inUse] = await ctx.tx
      .select({ id: offer.id })
      .from(offer)
      .where(and(eq(offer.active, true), or(eq(offer.productId, input.id), eq(offer.bumpProductId, input.id))))
      .limit(1);
    if (inUse) throw new ActionError("conflict", "Produto usado por uma oferta ativa");
    await ctx.tx.update(product).set({ deletedAt: new Date() }).where(eq(product.id, input.id));
    return { id: input.id };
  },
});
