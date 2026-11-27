import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import type { Tx } from "@/lib/db/client";
import { offer, offerProduct, orders, store } from "@/lib/db/schema";
import { MAX_PRODUCTS_PER_GROUP } from "./offer-editing";
import { bumpInput, checkOfferProducts, loadOfferProducts, productsFields, refineProducts, writeOfferProducts, type ProductRef } from "./offer-products";
import { PIXEL_ID_RE, pixelIdFor, validatePixelWithStoredToken } from "@/lib/tracking/meta";

const id = z.uuid();
/** Endereço público da oferta (/c/<slug>): também o formato aceito em `oferta` pela API do app. */
export const offerSlugSchema = z.string().regex(/^[a-z0-9-]{3,60}$/, "Use 3 a 60 caracteres: letras minúsculas, números e hífen");
const slug = offerSlugSchema;
const name = z.string().trim().min(1).max(200);
const priceCents = z.number().int().positive().max(2_147_483_647);
const methods = z.array(z.enum(["pix", "card"])).min(1).refine((m) => new Set(m).size === m.length, "Métodos repetidos");
const pixMode = z.enum(["manual", "asaas"]);
const maxInstallments = z.number().int().min(1).max(12);
const text = z.string().trim().max(2000);
/** Entrega: `download` (PDFs por e-mail, como sempre) ou `app` (o funil cobra e avisa o app; sem PDF). */
const delivery = z.enum(["download", "app"]);
/** Código que vai no aviso ao app (ex.: `start_anual`); o app traduz em plano ou créditos. */
export const APP_CODE_RE = /^[a-z0-9_]{1,40}$/;
const appCode = z.string().regex(APP_CODE_RE, "Código no app: 1 a 40 letras minúsculas, números ou _");

export const APP_CODE_TAKEN = "Código já usado por outra oferta";
/**
 * Oferta `app` (§7.4, §7.5): sem produtos nem bump, à vista, Pix só do Asaas e com código. O banco também confere
 * (offer_app_checkout_check); aqui o erro sai com o caminho do campo. Lista vazia: tudo certo.
 */
export function appOfferProblems(o: {
  delivery: string;
  appCode: string | null | undefined;
  productCount: number;
  hasBump: boolean;
  maxInstallments: number;
  pixMode: string;
}): { path: string[]; message: string }[] {
  const out: { path: string[]; message: string }[] = [];
  const add = (field: string, message: string) => out.push({ path: [field], message });
  if (o.delivery !== "app") {
    if (o.appCode != null) add("appCode", "Só oferta de app tem código no app");
    return out;
  }
  if (o.productCount > 0) add("productIds", "Oferta de app não entrega produtos");
  if (o.hasBump) add("bump", "Oferta de app não tem order bump");
  if (o.maxInstallments !== 1) add("maxInstallments", "Oferta de app é só à vista");
  if (o.pixMode !== "asaas") add("pixMode", "Oferta de app usa o Pix do Asaas");
  if (o.appCode == null) add("appCode", "Informe o código no app");
  return out;
}

function throwProblems(problems: { path: string[]; message: string }[]): void {
  if (problems.length > 0) throw new ActionError("invalid_input", problems[0]!.message, problems);
}

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

function isUniqueViolation(e: unknown): boolean {
  const c = (e as { code?: string; cause?: { code?: string } } | null) ?? {};
  return c.code === "23505" || c.cause?.code === "23505";
}

/** Violação do unique (loja, app_code): o código do app já é de outra oferta. */
function isAppCodeViolation(e: unknown): boolean {
  const c = (e as { constraint_name?: string; cause?: { constraint_name?: string } } | null) ?? {};
  return isUniqueViolation(e) && (c.constraint_name ?? c.cause?.constraint_name) === "offer_store_app_code_unique";
}

async function ensureAppCodeFree(ctx: Ctx, code: string, exceptId?: string): Promise<void> {
  const [row] = await ctx.tx.select({ id: offer.id }).from(offer).where(eq(offer.appCode, code));
  if (row && row.id !== exceptId) throw new ActionError("conflict", APP_CODE_TAKEN);
}

async function ensureSlugFree(ctx: Ctx, s: string, exceptId?: string): Promise<void> {
  const [row] = await ctx.tx.select({ id: offer.id }).from(offer).where(eq(offer.slug, s));
  if (row && row.id !== exceptId) throw new ActionError("conflict", "Já existe uma oferta com esse endereço");
}

const createInput = z
  .strictObject({
    slug,
    name,
    delivery: delivery.default("download"),
    /** Só na oferta `app` (obrigatório nela). */
    appCode: appCode.optional(),
    // Oferta `app` não tem produtos (lista vazia); a `download` precisa de ao menos 1 (conferido abaixo).
    productIds: z.array(z.uuid()).max(MAX_PRODUCTS_PER_GROUP).default([]),
    bump: bumpInput.nullish().transform((v) => v ?? null),
    priceCents,
    methods,
    pixMode,
    maxInstallments: maxInstallments.default(1),
    thankYouText: text.nullish(),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    refineProducts(v, ctx);
    if (v.delivery === "download" && v.productIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["productIds"], message: "Escolha ao menos 1 produto entregue" });
    }
    const problems = appOfferProblems({
      delivery: v.delivery,
      appCode: v.appCode,
      productCount: v.productIds.length,
      hasBump: v.bump !== null,
      maxInstallments: v.maxInstallments,
      pixMode: v.pixMode,
    });
    for (const p of problems) ctx.addIssue({ code: "custom", path: p.path, message: p.message });
  });

export const createOffer = defineAction({
  name: "offers.create",
  description:
    "Cria uma oferta (preço em centavos) com os produtos entregues (productIds, 1 a 20, em ordem) e order bump opcional (bump: productIds, priceCents e label, obrigatório com mais de 1 produto). delivery: download (padrão) ou app; oferta app não tem produtos nem bump, é à vista, com Pix do Asaas, e exige appCode (código que vai no aviso ao app).",
  input: createInput,
  permission: "offers.write",
  // Oferta nova vai ao ar com preço e produtos entregues: MCP/IA pedem aprovação.
  sensitive: true,
  async run(ctx, input) {
    const bumpIds = input.bump?.productIds ?? [];
    const app = input.delivery === "app";
    // Antes do insert: valida os produtos (loja, apagados, repetidos) com erro legível. Oferta de app não tem produtos.
    if (!app) await checkOfferProducts(ctx, input.productIds, bumpIds);
    await ensureSlugFree(ctx, input.slug);
    if (app) await ensureAppCodeFree(ctx, input.appCode!);
    let row: OfferRow;
    try {
      [row] = (await ctx.tx
        .insert(offer)
        .values({
          storeId: ctx.storeId,
          slug: input.slug,
          name: input.name,
          delivery: input.delivery,
          appCode: app ? input.appCode! : null,
          bumpPriceCents: input.bump?.priceCents ?? null,
          bumpLabel: input.bump?.label ?? null,
          priceCents: input.priceCents,
          methods: input.methods,
          pixMode: input.pixMode,
          maxInstallments: input.maxInstallments,
          thankYouText: input.thankYouText ?? null,
          active: input.active,
        })
        .returning(offerCols)) as [OfferRow];
    } catch (e) {
      if (isAppCodeViolation(e)) throw new ActionError("conflict", APP_CODE_TAKEN);
      if (isUniqueViolation(e)) throw new ActionError("conflict", "Já existe uma oferta com esse endereço");
      throw e;
    }
    if (!app) await writeOfferProducts(ctx, row.id, input.productIds, bumpIds);
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
    const [current] = await ctx.tx.select({ id: offer.id, delivery: offer.delivery }).from(offer).where(eq(offer.id, input.id)).for("update");
    if (!current) throw new ActionError("not_found", "Oferta não encontrada");
    if (current.delivery === "app") {
      const message = "Oferta de app não entrega produtos";
      throw new ActionError("invalid_input", message, [{ path: ["productIds"], message }]);
    }
    // Lista primeiro (valida os produtos); depois o preço e o rótulo do bump.
    await writeOfferProducts(ctx, input.id, input.productIds, input.bump?.productIds ?? []);
    const price = input.priceCents === undefined ? {} : { priceCents: input.priceCents };
    const [row] = await ctx.tx
      .update(offer)
      .set({ bumpPriceCents: input.bump?.priceCents ?? null, bumpLabel: input.bump?.label ?? null, ...price })
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
    "Atualiza dados da oferta, exceto endereço (use offers.setSlug), preço (use offers.updatePrice) e produtos/bump (use offers.setProducts). delivery troca a entrega (download ou app) só em oferta sem pedidos: virar app tira os produtos e o bump; voltar a download deixa a oferta sem produto até offers.setProducts. appCode só em oferta app.",
  input: z.strictObject({
    id,
    name: name.optional(),
    delivery: delivery.optional(),
    appCode: appCode.nullable().optional(),
    methods: methods.optional(),
    pixMode: pixMode.optional(),
    maxInstallments: maxInstallments.optional(),
    thankYouText: text.nullable().optional(),
    active: z.boolean().optional(),
  }),
  permission: "offers.write",
  // Nome, entrega, código no app, métodos, modo Pix, parcelas, texto de obrigado e `active` aparecem no checkout ou no
  // aviso ao app: MCP/IA pedem aprovação.
  sensitive: true,
  async run(ctx, input) {
    const { id: offerId, ...changes } = input;
    // Trava a linha: a troca de entrega e o código no app são conferidos contra o estado salvo, sem corrida.
    const [current] = await ctx.tx.select(offerCols).from(offer).where(eq(offer.id, offerId)).for("update");
    if (!current) throw new ActionError("not_found", "Oferta não encontrada");
    const set: Partial<typeof offer.$inferInsert> = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) return current;
    const next = { ...current, ...set };
    const switching = next.delivery !== current.delivery;
    if (switching) {
      // O pedido já feito segue a entrega da oferta (e-mail com PDF ou aviso ao app): com pedido, a entrega não muda.
      const [sold] = await ctx.tx.select({ id: orders.id }).from(orders).where(eq(orders.offerId, offerId)).limit(1);
      if (sold) throw new ActionError("conflict", "Esta oferta já tem pedidos: crie outra oferta para mudar a entrega");
      // Voltar a download sem dizer o código: o código sai junto.
      if (next.delivery === "download" && input.appCode === undefined) next.appCode = null;
    }
    const toApp = switching && next.delivery === "app";
    // Ao virar app, produtos e bump saem; até lá contam como estão.
    const productCount = toApp ? 0 : (await loadOfferProducts(ctx.tx, [offerId])).get(offerId)!.main.length;
    throwProblems(
      appOfferProblems({
        delivery: next.delivery,
        appCode: next.appCode,
        productCount: next.delivery === "app" ? productCount : 0,
        hasBump: !toApp && next.bumpPriceCents !== null,
        maxInstallments: next.maxInstallments,
        pixMode: next.pixMode,
      }),
    );
    if (next.appCode !== null && next.appCode !== current.appCode) await ensureAppCodeFree(ctx, next.appCode, offerId);
    if (toApp) {
      await ctx.tx.delete(offerProduct).where(eq(offerProduct.offerId, offerId));
      Object.assign(set, { bumpPriceCents: null, bumpLabel: null });
    }
    if (switching) set.appCode = next.appCode;
    try {
      const [row] = await ctx.tx.update(offer).set(set).where(eq(offer.id, offerId)).returning(offerCols);
      return row!;
    } catch (e) {
      if (isAppCodeViolation(e)) throw new ActionError("conflict", APP_CODE_TAKEN);
      throw e;
    }
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
  audit: false,
  run: async (ctx) => withProducts(ctx.tx, await ctx.tx.select(offerCols).from(offer).orderBy(desc(offer.createdAt))),
});

export const getOffer = defineAction({
  name: "offers.get",
  description: "Busca uma oferta pelo id.",
  input: z.object({ id }),
  permission: "offers.read",
  audit: false,
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
    const app = o.delivery === "app";
    // Nunca vende combo incompleto: principal apagado esconde a oferta; produto do bump apagado esconde o bump. Oferta
    // de app não tem produtos (o app libera o plano ou os créditos).
    if (!app && (main.length === 0 || main.some((p) => p.deletedAt))) throw new ActionError("not_found", "Oferta não encontrada");
    const hasBump = !app && bump.length > 0 && o.bumpPriceCents !== null && !bump.some((p) => p.deletedAt);
    // Aviso de captura de contato: só com a captura ligada. O e-mail de privacidade é público (aparece no aviso).
    const [st] = await ctx.tx
      .select({ on: store.leadCapture, privacyEmail: store.privacyEmail, acceptCnpj: store.acceptCnpj })
      .from(store)
      .where(eq(store.id, ctx.storeId));
    const names = (ps: ProductRef[]) => ps.map((p) => ({ name: p.name }));
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      /** O código no app (`appCode`) não sai: é do aviso ao app, não da página. */
      delivery: o.delivery as "download" | "app",
      products: app ? [] : names(main),
      priceCents: o.priceCents,
      methods: o.methods,
      pixMode: o.pixMode,
      maxInstallments: o.maxInstallments,
      bump: hasBump ? { products: names(bump), priceCents: o.bumpPriceCents!, label: o.bumpLabel } : null,
      thankYouText: o.thankYouText,
      pixelId: await pixelIdFor(ctx.tx, ctx.storeId, o.pixelId),
      leadCapture: st?.on && st.privacyEmail ? { privacyEmail: st.privacyEmail } : null,
      /** A loja aceita CPF ou CNPJ no checkout (só CPF sem a opção). */
      acceptCnpj: st?.acceptCnpj ?? false,
    };
  },
});
