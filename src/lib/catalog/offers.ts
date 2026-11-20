import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import type { Tx } from "@/lib/db/client";
import { offer } from "@/lib/db/schema";
import { checkOfferProducts, loadOfferProducts, productsFields, refineProducts, writeOfferProducts, type BumpInput, type ProductRef } from "./offer-products";
import { PIXEL_ID_RE, pixelIdFor, validatePixelWithStoredToken } from "@/lib/tracking/meta";

const id = z.uuid();
const slug = z.string().regex(/^[a-z0-9-]{3,60}$/, "Use 3 a 60 caracteres: letras minúsculas, números e hífen");
const name = z.string().trim().min(1).max(200);
const priceCents = z.number().int().positive().max(2_147_483_647);
const methods = z.array(z.enum(["pix", "card"])).min(1).refine((m) => new Set(m).size === m.length, "Métodos repetidos");
const pixMode = z.enum(["manual", "asaas"]);
const maxInstallments = z.number().int().min(1).max(12);
const text = z.string().trim().max(2000);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { storeId: _omit, ...offerCols } = getTableColumns(offer);

type OfferRow = Omit<typeof offer.$inferSelect, "storeId">;
export type OfferView = OfferRow & {
  products: ProductRef[];
  bump: { products: ProductRef[]; priceCents: number; label: string | null } | null;
};

/** Oferta com a lista de produtos (offer_product), na ordem; inclui apagados (o painel mostra para corrigir). */
async function withProducts(tx: Tx, rows: OfferRow[]): Promise<OfferView[]> {
  const lists = await loadOfferProducts(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const g = lists.get(r.id)!;
    const bump = g.bump.length > 0 && r.bumpPriceCents !== null ? { products: g.bump, priceCents: r.bumpPriceCents, label: r.bumpLabel } : null;
    return { ...r, products: g.main, bump };
  });
}

/**
 * Colunas da oferta ligadas à lista. `product_id` e `bump_product_id` são as antigas, gravadas a partir do primeiro
 * principal e do primeiro do bump para os leitores ainda não migrados para offer_product (pedido, entrega, painel); só
 * elas saem na Task 5. `bump_price_cents` e `bump_label` continuam (preço e rótulo do bump).
 */
function legacyColumns(productIds: string[], bump: BumpInput | null) {
  return {
    productId: productIds[0]!,
    bumpProductId: bump?.productIds[0] ?? null,
    bumpPriceCents: bump?.priceCents ?? null,
    bumpLabel: bump?.label ?? null,
  };
}

function isUniqueViolation(e: unknown): boolean {
  const c = (e as { code?: string; cause?: { code?: string } } | null) ?? {};
  return c.code === "23505" || c.cause?.code === "23505";
}

async function ensureSlugFree(ctx: Ctx, s: string, exceptId?: string): Promise<void> {
  const [row] = await ctx.tx.select({ id: offer.id }).from(offer).where(eq(offer.slug, s));
  if (row && row.id !== exceptId) throw new ActionError("conflict", "Já existe uma oferta com esse endereço");
}

const createInput = z
  .strictObject({
    slug,
    name,
    ...productsFields,
    bump: productsFields.bump.optional().transform((v) => v ?? null),
    priceCents,
    methods,
    pixMode,
    maxInstallments: maxInstallments.default(1),
    thankYouText: text.nullish(),
    active: z.boolean().default(true),
  })
  .superRefine(refineProducts);

export const createOffer = defineAction({
  name: "offers.create",
  description:
    "Cria uma oferta (preço em centavos) com os produtos entregues (productIds, 1 a 20, em ordem) e order bump opcional (bump: productIds, priceCents e label, obrigatório com mais de 1 produto).",
  input: createInput,
  permission: "offers.write",
  async run(ctx, input) {
    const bumpIds = input.bump?.productIds ?? [];
    // Antes do insert: a coluna antiga product_id tem FK simples e daria erro cru com produto inválido.
    await checkOfferProducts(ctx, input.productIds, bumpIds);
    await ensureSlugFree(ctx, input.slug);
    let row: OfferRow;
    try {
      [row] = (await ctx.tx
        .insert(offer)
        .values({
          storeId: ctx.storeId,
          slug: input.slug,
          name: input.name,
          ...legacyColumns(input.productIds, input.bump),
          priceCents: input.priceCents,
          methods: input.methods,
          pixMode: input.pixMode,
          maxInstallments: input.maxInstallments,
          thankYouText: input.thankYouText ?? null,
          active: input.active,
        })
        .returning(offerCols)) as [OfferRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new ActionError("conflict", "Já existe uma oferta com esse endereço");
      throw e;
    }
    await writeOfferProducts(ctx, row.id, input.productIds, bumpIds);
    return (await withProducts(ctx.tx, [row]))[0]!;
  },
});

/**
 * Troca o que a oferta entrega: produtos principais (em ordem) e o bump (produtos, preço e rótulo), ou remove o bump
 * com `null`. `priceCents` opcional muda o preço da oferta na mesma transação (o editor salva produtos e preço juntos,
 * sem ficar pela metade). Sensível como o preço (muda o que é entregue): MCP/IA pedem aprovação.
 */
export const setOfferProducts = defineAction({
  name: "offers.setProducts",
  description:
    "Define os produtos entregues pela oferta (productIds, 1 a 20, em ordem) e o order bump (productIds, priceCents em centavos e label, obrigatório com mais de 1 produto), ou remove o bump com null. priceCents (opcional, centavos) muda também o preço da oferta, junto.",
  input: z.strictObject({ id, ...productsFields, priceCents: priceCents.optional() }).superRefine(refineProducts),
  permission: "offers.write",
  sensitive: true,
  async run(ctx, input) {
    // Trava a linha da oferta: duas chamadas simultâneas rodam uma depois da outra (sem a trava, o delete de uma não vê
    // as linhas novas da outra e as listas se juntam). O unique (offer_id, kind, position) é a rede de segurança.
    const [current] = await ctx.tx.select({ id: offer.id }).from(offer).where(eq(offer.id, input.id)).for("update");
    if (!current) throw new ActionError("not_found", "Oferta não encontrada");
    // Lista primeiro (valida os produtos); depois as colunas antigas, que têm FK simples para product.
    await writeOfferProducts(ctx, input.id, input.productIds, input.bump?.productIds ?? []);
    const price = input.priceCents === undefined ? {} : { priceCents: input.priceCents };
    const [row] = await ctx.tx
      .update(offer)
      .set({ ...legacyColumns(input.productIds, input.bump), ...price })
      .where(eq(offer.id, input.id))
      .returning(offerCols);
    return (await withProducts(ctx.tx, [row!]))[0]!;
  },
});

/**
 * Pixel próprio da oferta (sobrescreve o da conexão Meta da loja); `null` volta ao pixel da loja. Fica fora de
 * offers.create/update: exige `tracking.write` (dono, admin, tráfego) e é sensível (MCP/IA pedem aprovação). Um pixel
 * novo é validado no `prepare` com o token guardado pelo dono (mesmo teste do saveMeta; fora de transação); sem token
 * guardado, é recusado.
 */
export const setOfferPixel = defineAction({
  name: "offers.setPixel",
  description: "Define (ou limpa, com null) o Meta Pixel próprio de uma oferta.",
  input: z.object({ id, pixelId: z.string().trim().regex(PIXEL_ID_RE, "Pixel ID: só números (5 a 20)").nullable() }),
  permission: "tracking.write",
  sensitive: true,
  async prepare(call, input) {
    if (input.pixelId !== null) await validatePixelWithStoredToken(call.storeId, input.pixelId);
  },
  async run(ctx, input) {
    const [row] = await ctx.tx
      .update(offer)
      .set({ pixelId: input.pixelId })
      .where(eq(offer.id, input.id))
      .returning({ id: offer.id, pixelId: offer.pixelId });
    if (!row) throw new ActionError("not_found", "Oferta não encontrada");
    return row;
  },
});

/**
 * Troca o endereço público (/c/<slug>) de uma oferta existente. Sensível: trocar slugs entre ofertas faria o link dos
 * anúncios vender outros produtos ou outro preço sem passar por offers.setProducts/updatePrice.
 */
export const setOfferSlug = defineAction({
  name: "offers.setSlug",
  description: "Troca o endereço público (slug) de uma oferta existente.",
  input: z.strictObject({ id, slug }),
  permission: "offers.write",
  sensitive: true,
  async run(ctx, input) {
    await ensureSlugFree(ctx, input.slug, input.id);
    try {
      const [row] = await ctx.tx.update(offer).set({ slug: input.slug }).where(eq(offer.id, input.id)).returning(offerCols);
      if (!row) throw new ActionError("not_found", "Oferta não encontrada");
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ActionError("conflict", "Já existe uma oferta com esse endereço");
      throw e;
    }
  },
});

// strictObject: slug (offers.setSlug), preço (offers.updatePrice), produtos e bump (offers.setProducts) são rejeitados.
export const updateOffer = defineAction({
  name: "offers.update",
  description:
    "Atualiza dados da oferta, exceto endereço (use offers.setSlug), preço (use offers.updatePrice) e produtos/bump (use offers.setProducts).",
  input: z.strictObject({
    id,
    name: name.optional(),
    methods: methods.optional(),
    pixMode: pixMode.optional(),
    maxInstallments: maxInstallments.optional(),
    thankYouText: text.nullable().optional(),
    active: z.boolean().optional(),
  }),
  permission: "offers.write",
  async run(ctx, input) {
    const { id: offerId, ...changes } = input;
    const [current] = await ctx.tx.select(offerCols).from(offer).where(eq(offer.id, offerId));
    if (!current) throw new ActionError("not_found", "Oferta não encontrada");
    const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) return current;
    const [row] = await ctx.tx.update(offer).set(set).where(eq(offer.id, offerId)).returning(offerCols);
    return row!;
  },
});

export const updateOfferPrice = defineAction({
  name: "offers.updatePrice",
  description: "Altera o preço da oferta (centavos). O bump (produtos, preço e rótulo) muda por offers.setProducts, que também aceita o preço junto.",
  input: z.strictObject({ id, priceCents }),
  permission: "offers.write",
  sensitive: true,
  async run(ctx, input) {
    const [row] = await ctx.tx.update(offer).set({ priceCents: input.priceCents }).where(eq(offer.id, input.id)).returning(offerCols);
    if (!row) throw new ActionError("not_found", "Oferta não encontrada");
    return row;
  },
});

export const listOffers = defineAction({
  name: "offers.list",
  description: "Lista as ofertas da loja.",
  input: z.object({}),
  permission: "offers.read",
  run: async (ctx) => withProducts(ctx.tx, await ctx.tx.select(offerCols).from(offer).orderBy(desc(offer.createdAt))),
});

export const getOffer = defineAction({
  name: "offers.get",
  description: "Busca uma oferta pelo id.",
  input: z.object({ id }),
  permission: "offers.read",
  async run(ctx, input) {
    const [row] = await ctx.tx.select(offerCols).from(offer).where(eq(offer.id, input.id));
    if (!row) throw new ActionError("not_found", "Oferta não encontrada");
    return (await withProducts(ctx.tx, [row]))[0]!;
  },
});

export const getPublicOffer = defineAction({
  name: "offers.getPublic",
  description: "Dados públicos de uma oferta ativa para a página de compra (nunca expõe o arquivo).",
  input: z.object({ slug: z.string().min(1).max(100) }),
  permission: "public",
  audit: false,
  async run(ctx, input) {
    const [o] = await ctx.tx.select(offerCols).from(offer).where(and(eq(offer.slug, input.slug), eq(offer.active, true)));
    if (!o) throw new ActionError("not_found", "Oferta não encontrada");
    const { main, bump } = (await loadOfferProducts(ctx.tx, [o.id])).get(o.id)!;
    // Nunca vende combo incompleto: principal apagado esconde a oferta; produto do bump apagado esconde o bump.
    if (main.length === 0 || main.some((p) => p.deletedAt)) throw new ActionError("not_found", "Oferta não encontrada");
    const hasBump = bump.length > 0 && o.bumpPriceCents !== null && !bump.some((p) => p.deletedAt);
    const names = (ps: ProductRef[]) => ps.map((p) => ({ name: p.name }));
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      products: names(main),
      priceCents: o.priceCents,
      methods: o.methods,
      pixMode: o.pixMode,
      maxInstallments: o.maxInstallments,
      bump: hasBump ? { products: names(bump), priceCents: o.bumpPriceCents!, label: o.bumpLabel } : null,
      thankYouText: o.thankYouText,
      pixelId: await pixelIdFor(ctx.tx, ctx.storeId, o.pixelId),
    };
  },
});
