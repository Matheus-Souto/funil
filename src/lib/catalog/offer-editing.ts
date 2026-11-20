// Regras puras do editor de oferta do painel (sem dependência de banco: roda no navegador). As mesmas regras valem no
// servidor (offer-products.ts); aqui elas só dão a mensagem antes de chamar a ação.

/** Máximo de produtos em cada lista da oferta (principais e bump). */
export const MAX_PRODUCTS_PER_GROUP = 20;

/** Lista com o item `index` trocado de lugar com o vizinho (`delta` −1 sobe, +1 desce). Na borda, nada muda. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  const out = [...list];
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return out;
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

/** Lista sem o item `index`. */
export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** Problema nas listas do editor (mensagem para o vendedor) ou `null`. Linha vazia é `""`. */
export function productsProblem(d: {
  productIds: string[];
  bumpOn: boolean;
  bumpProductIds: string[];
  bumpPriceCents: number | null;
  bumpLabel: string | null;
}): string | null {
  if (!d.productIds[0]) return "Escolha o produto entregue (envie o PDF em Produtos).";
  if (d.productIds.some((id) => !id)) return "Escolha um produto em cada linha ou remova a linha vazia.";
  const bump = d.bumpOn ? d.bumpProductIds : [];
  if (d.productIds.length > MAX_PRODUCTS_PER_GROUP || bump.length > MAX_PRODUCTS_PER_GROUP) return `No máximo ${MAX_PRODUCTS_PER_GROUP} produtos em cada lista.`;
  if (d.bumpOn && (bump.length === 0 || bump.some((id) => !id) || !d.bumpPriceCents)) return "Bump: escolha o produto e o preço do acréscimo.";
  const all = [...d.productIds, ...bump];
  if (new Set(all).size !== all.length) return "O mesmo produto aparece mais de uma vez na oferta.";
  if (bump.length > 1 && !d.bumpLabel?.trim()) return "Bump com mais de um produto: preencha o título da caixa.";
  return null;
}

export type OfferProductsState = {
  /** `null`: preço ainda inválido no editor. */
  priceCents: number | null;
  productIds: string[];
  bump: { productIds: string[]; priceCents: number; label: string | null } | null;
};

/** O que mudou entre a oferta salva e o editor. `label`: o bump existe antes e depois, com rótulo diferente. */
export type OfferChanges = { price: boolean; products: boolean; bump: boolean; label: boolean };

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function offerChanges(before: OfferProductsState, after: OfferProductsState): OfferChanges {
  const b = before.bump;
  const a = after.bump;
  const bump = (b === null) !== (a === null) || (b !== null && a !== null && (b.priceCents !== a.priceCents || !sameList(b.productIds, a.productIds)));
  return {
    price: before.priceCents !== after.priceCents,
    products: !sameList(before.productIds, after.productIds),
    bump,
    label: b !== null && a !== null && (b.label ?? null) !== (a.label ?? null),
  };
}

/**
 * Ação sensível que salva a mudança: produtos/bump/rótulo vão por `offers.setProducts` (com o preço junto, atômico,
 * quando ele também mudou); só o preço, por `offers.updatePrice`.
 */
export function saveCall(c: OfferChanges): { action: "setProducts"; withPrice: boolean } | { action: "updatePrice" } | null {
  if (c.products || c.bump || c.label) return { action: "setProducts", withPrice: c.price };
  if (c.price) return { action: "updatePrice" };
  return null;
}

/** Título e botão do diálogo de confirmação: diz o que muda (preço, produtos, order bump ou só o título do bump). */
export function changeDialog(c: OfferChanges): { title: string; confirm: string } {
  const parts = [
    ...(c.price ? ["o preço"] : []),
    ...(c.products ? ["os produtos"] : []),
    ...(c.bump ? ["o order bump"] : []),
    ...(c.label && !c.bump ? ["o título do bump"] : []),
  ];
  const what = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`;
  const onlyPrice = c.price && parts.length === 1;
  return { title: `Alterar ${what} desta oferta?`, confirm: onlyPrice ? "Salvar novo preço" : "Salvar alterações" };
}
