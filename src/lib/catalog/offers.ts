import { and, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { offer, product } from "@/lib/db/schema";

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

async function activeProduct(ctx: Ctx, productId: string): Promise<void> {
  const [p] = await ctx.tx.select({ id: product.id }).from(product).where(and(eq(product.id, productId), isNull(product.deletedAt)));
  if (!p) throw new ActionError("not_found", "Produto não encontrado");
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
  .object({
    slug,
    name,
    productId: id,
    priceCents,
    methods,
    pixMode,
    maxInstallments: maxInstallments.default(1),
    bumpProductId: id.nullish(),
    bumpPriceCents: priceCents.nullish(),
    bumpLabel: text.nullish(),
    thankYouText: text.nullish(),
    pixelId: z.string().trim().max(100).nullish(),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const hasProduct = v.bumpProductId != null;
    if (hasProduct !== (v.bumpPriceCents != null)) {
      ctx.addIssue({ code: "custom", path: ["bumpPriceCents"], message: "Bump exige produto e preço juntos" });
    }
    if (hasProduct && v.bumpProductId === v.productId) {
      ctx.addIssue({ code: "custom", path: ["bumpProductId"], message: "O bump deve ser diferente do produto principal" });
    }
  });

export const createOffer = defineAction({
  name: "offers.create",
  description: "Cria uma oferta (preço em centavos) com order bump opcional.",
  input: createInput,
  permission: "offers.write",
  async run(ctx, input) {
    await activeProduct(ctx, input.productId);
    if (input.bumpProductId) await activeProduct(ctx, input.bumpProductId);
    await ensureSlugFree(ctx, input.slug);
    try {
      const [row] = await ctx.tx
        .insert(offer)
        .values({
          storeId: ctx.storeId,
          slug: input.slug,
          name: input.name,
          productId: input.productId,
          priceCents: input.priceCents,
          methods: input.methods,
          pixMode: input.pixMode,
          maxInstallments: input.maxInstallments,
          bumpProductId: input.bumpProductId ?? null,
          bumpPriceCents: input.bumpPriceCents ?? null,
          bumpLabel: input.bumpLabel ?? null,
          thankYouText: input.thankYouText ?? null,
          pixelId: input.pixelId ?? null,
          active: input.active,
        })
        .returning(offerCols);
      return row!;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ActionError("conflict", "Já existe uma oferta com esse endereço");
      throw e;
    }
  },
});

// strictObject: campos de preço (priceCents, bumpPriceCents, bumpProductId) são rejeitados aqui.
export const updateOffer = defineAction({
  name: "offers.update",
  description: "Atualiza dados da oferta, exceto preços e produto do bump (use offers.updatePrice).",
  input: z.strictObject({
    id,
    slug: slug.optional(),
    name: name.optional(),
    productId: id.optional(),
    methods: methods.optional(),
    pixMode: pixMode.optional(),
    maxInstallments: maxInstallments.optional(),
    bumpLabel: text.nullable().optional(),
    thankYouText: text.nullable().optional(),
    pixelId: z.string().trim().max(100).nullable().optional(),
    active: z.boolean().optional(),
  }),
  permission: "offers.write",
  async run(ctx, input) {
    const { id: offerId, ...changes } = input;
    const [current] = await ctx.tx.select(offerCols).from(offer).where(eq(offer.id, offerId));
    if (!current) throw new ActionError("not_found", "Oferta não encontrada");
    if (changes.productId !== undefined) {
      if (changes.productId === current.bumpProductId) {
        throw new ActionError("invalid_input", "O produto principal não pode ser o do bump");
      }
      await activeProduct(ctx, changes.productId);
    }
    if (changes.slug !== undefined) await ensureSlugFree(ctx, changes.slug, offerId);
    const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) return current;
    try {
      const [row] = await ctx.tx.update(offer).set(set).where(eq(offer.id, offerId)).returning(offerCols);
      return row!;
    } catch (e) {
      if (isUniqueViolation(e)) throw new ActionError("conflict", "Já existe uma oferta com esse endereço");
      throw e;
    }
  },
});

export const updateOfferPrice = defineAction({
  name: "offers.updatePrice",
  description: "Altera o preço da oferta e/ou define ou remove o bump (produto e preço em centavos).",
  input: z
    .strictObject({
      id,
      priceCents: priceCents.optional(),
      bump: z.strictObject({ productId: id, priceCents }).nullable().optional(),
    })
    .refine((v) => v.priceCents !== undefined || v.bump !== undefined, "Informe priceCents e/ou bump"),
  permission: "offers.write",
  sensitive: true,
  async run(ctx, input) {
    const [current] = await ctx.tx.select(offerCols).from(offer).where(eq(offer.id, input.id));
    if (!current) throw new ActionError("not_found", "Oferta não encontrada");
    const set: Partial<typeof offer.$inferInsert> = {};
    if (input.priceCents !== undefined) set.priceCents = input.priceCents;
    if (input.bump === null) {
      set.bumpProductId = null;
      set.bumpPriceCents = null;
    } else if (input.bump) {
      if (input.bump.productId === current.productId) {
        throw new ActionError("invalid_input", "O bump deve ser diferente do produto principal");
      }
      await activeProduct(ctx, input.bump.productId);
      set.bumpProductId = input.bump.productId;
      set.bumpPriceCents = input.bump.priceCents;
    }
    const [row] = await ctx.tx.update(offer).set(set).where(eq(offer.id, input.id)).returning(offerCols);
    return row!;
  },
});

export const listOffers = defineAction({
  name: "offers.list",
  description: "Lista as ofertas da loja.",
  input: z.object({}),
  permission: "offers.read",
  run: (ctx) => ctx.tx.select(offerCols).from(offer).orderBy(desc(offer.createdAt)),
});

export const getOffer = defineAction({
  name: "offers.get",
  description: "Busca uma oferta pelo id.",
  input: z.object({ id }),
  permission: "offers.read",
  async run(ctx, input) {
    const [row] = await ctx.tx.select(offerCols).from(offer).where(eq(offer.id, input.id));
    if (!row) throw new ActionError("not_found", "Oferta não encontrada");
    return row;
  },
});

export const getPublicOffer = defineAction({
  name: "offers.getPublic",
  description: "Dados públicos de uma oferta ativa para a página de compra (nunca expõe o arquivo).",
  input: z.object({ slug: z.string().min(1).max(100) }),
  permission: "public",
  audit: false,
  async run(ctx, input) {
    const bumpProduct = alias(product, "bump_product");
    const [row] = await ctx.tx
      .select({ o: offer, productName: product.name, bumpName: bumpProduct.name, bumpDeleted: bumpProduct.deletedAt, mainDeleted: product.deletedAt })
      .from(offer)
      .innerJoin(product, eq(product.id, offer.productId))
      .leftJoin(bumpProduct, eq(bumpProduct.id, offer.bumpProductId))
      .where(and(eq(offer.slug, input.slug), eq(offer.active, true)));
    if (!row || row.mainDeleted) throw new ActionError("not_found", "Oferta não encontrada");
    const o = row.o;
    const hasBump = o.bumpProductId !== null && o.bumpPriceCents !== null && row.bumpName !== null && !row.bumpDeleted;
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      productName: row.productName,
      priceCents: o.priceCents,
      methods: o.methods,
      pixMode: o.pixMode,
      maxInstallments: o.maxInstallments,
      bump: hasBump ? { productName: row.bumpName!, priceCents: o.bumpPriceCents!, label: o.bumpLabel } : null,
      thankYouText: o.thankYouText,
    };
  },
});
