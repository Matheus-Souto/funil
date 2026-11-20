// Lista de produtos (PDFs) de uma oferta: principais (`main`) e do order bump (`bump`), ordenados por `position`.
// Regras compartilhadas por offers.create e offers.setProducts: 1 a 20 por grupo, sem repetir produto na oferta
// (somando principal e bump), bump com mais de 1 produto exige rótulo, produto precisa existir na loja e não estar
// apagado.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { ActionError, type Ctx } from "@/lib/actions/core";
import { offerProduct, product } from "@/lib/db/schema";
import type { Tx } from "@/lib/db/client";
import { MAX_PRODUCTS_PER_GROUP } from "./offer-editing";

export type ProductRef = { id: string; name: string; deletedAt: Date | null };
export type OfferProducts = { main: ProductRef[]; bump: ProductRef[] };

const productIds = z.array(z.uuid()).min(1).max(MAX_PRODUCTS_PER_GROUP);
const priceCents = z.number().int().positive().max(2_147_483_647);

/** Bump: produtos, preço em centavos e rótulo (obrigatório com mais de 1 produto). Rótulo em branco vira `null`. */
export const bumpInput = z
  .strictObject({
    productIds,
    priceCents,
    label: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (v.productIds.length > 1 && v.label === null) {
      ctx.addIssue({ code: "custom", path: ["label"], message: "Bump com mais de um produto precisa de rótulo" });
    }
  });

export type BumpInput = z.infer<typeof bumpInput>;

/** Campos da lista na entrada das ações. Use `refineProducts` no objeto que os contém. */
export const productsFields = { productIds, bump: bumpInput.nullable() };

/** Recusa produto repetido na oferta (dentro de um grupo ou entre principal e bump). */
export function refineProducts(v: { productIds: string[]; bump: { productIds: string[] } | null }, ctx: z.RefinementCtx): void {
  const all = [...v.productIds, ...(v.bump?.productIds ?? [])];
  if (new Set(all).size !== all.length) {
    ctx.addIssue({ code: "custom", path: ["productIds"], message: "O mesmo produto aparece mais de uma vez na oferta" });
  }
}

/** Produtos das ofertas pedidas, por grupo e na ordem de `position` (inclui apagados: quem lê decide). */
export async function loadOfferProducts(tx: Tx, offerIds: string[]): Promise<Map<string, OfferProducts>> {
  const out = new Map<string, OfferProducts>(offerIds.map((id) => [id, { main: [], bump: [] }]));
  if (offerIds.length === 0) return out;
  const rows = await tx
    .select({ offerId: offerProduct.offerId, kind: offerProduct.kind, id: product.id, name: product.name, deletedAt: product.deletedAt })
    .from(offerProduct)
    .innerJoin(product, eq(product.id, offerProduct.productId))
    .where(inArray(offerProduct.offerId, offerIds))
    .orderBy(asc(offerProduct.offerId), asc(offerProduct.kind), asc(offerProduct.position));
  for (const r of rows) {
    const group = out.get(r.offerId)!;
    (r.kind === "bump" ? group.bump : group.main).push({ id: r.id, name: r.name, deletedAt: r.deletedAt });
  }
  return out;
}

/**
 * Regras da lista com `invalid_input`: 1 a 20 principais, até 20 no bump, sem repetir produto, e todos existentes, não
 * apagados e desta loja (o RLS esconde o de outra loja).
 */
export async function checkOfferProducts(ctx: Ctx, main: string[], bump: string[]): Promise<void> {
  const all = [...main, ...bump];
  if (main.length < 1 || main.length > MAX_PRODUCTS_PER_GROUP || bump.length > MAX_PRODUCTS_PER_GROUP) {
    throw new ActionError("invalid_input", `A oferta precisa de 1 a ${MAX_PRODUCTS_PER_GROUP} produtos por grupo`);
  }
  if (new Set(all).size !== all.length) throw new ActionError("invalid_input", "O mesmo produto aparece mais de uma vez na oferta");
  const live = await ctx.tx
    .select({ id: product.id })
    .from(product)
    .where(and(inArray(product.id, all), isNull(product.deletedAt)));
  if (live.length !== all.length) throw new ActionError("invalid_input", "Produto não encontrado ou excluído");
}

/** Regrava a lista da oferta (apaga e insere na mesma transação), com posições 0..n−1 em cada grupo. */
export async function writeOfferProducts(ctx: Ctx, offerId: string, main: string[], bump: string[]): Promise<void> {
  await checkOfferProducts(ctx, main, bump);
  await ctx.tx.delete(offerProduct).where(eq(offerProduct.offerId, offerId));
  const row = (kind: "main" | "bump") => (productId: string, position: number) => ({ storeId: ctx.storeId, offerId, productId, kind, position });
  await ctx.tx.insert(offerProduct).values([...main.map(row("main")), ...bump.map(row("bump"))]);
}
