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

/** "a", "a e b", "a, b e c". */
const joinPt = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`);

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
  const what = joinPt(parts);
  const onlyPrice = c.price && parts.length === 1;
  return { title: `Alterar ${what} desta oferta?`, confirm: onlyPrice ? "Salvar novo preço" : "Salvar alterações" };
}

/** Uma gravação do editor (uma server action). `label` diz o que ela salva, para a mensagem. */
export type SaveStep = { label: string; run: () => Promise<{ ok: true } | { ok: false; error: string }> };
export type SaveResult = { saved: string[]; failed: { label: string; error: string } | null };

/** Roda as gravações em ordem e para no primeiro erro (as seguintes não rodam). */
export async function runSaveSteps(steps: readonly SaveStep[]): Promise<SaveResult> {
  const saved: string[] = [];
  for (const step of steps) {
    const r = await step.run();
    if (!r.ok) return { saved, failed: { label: step.label, error: r.error } };
    saved.push(step.label);
  }
  return { saved, failed: null };
}

/** Mensagem do resultado: com falha depois de algo salvo, diz o que foi salvo e o que não foi. */
export function saveOutcome(r: SaveResult, okText: string): { tone: "ok" | "error"; text: string } {
  if (!r.failed) return { tone: "ok", text: okText };
  if (r.saved.length === 0) return { tone: "error", text: r.failed.error };
  return { tone: "error", text: `Salvo: ${joinPt(r.saved)}. Não foi salvo: ${r.failed.label}. ${r.failed.error}` };
}

/**
 * Linhas do bump ao religá-lo: linha válida (preenchida, fora dos principais, primeira vez) fica; as demais (vazias ou
 * repetidas) ganham, em ordem, produtos de `available` ainda livres, sem repetir entre si; sem produto livre, ficam "".
 */
export function fillBumpLines(main: readonly string[], bump: readonly string[], available: readonly string[]): string[] {
  const taken = new Set(main);
  const keep = bump.map((id) => {
    if (!id || taken.has(id)) return false;
    taken.add(id);
    return true;
  });
  return bump.map((id, i) => {
    if (keep[i]) return id;
    const free = available.find((p) => !taken.has(p)) ?? "";
    if (free) taken.add(free);
    return free;
  });
}

/**
 * Para onde vai o foco depois de mover o item `index` (`delta` −1 sobe, +1 desce) numa lista de `length`: o mesmo botão
 * do item na posição nova; se ele chegou à borda (o botão fica desabilitado), o outro botão de mover.
 */
export function focusAfterMove(index: number, delta: -1 | 1, length: number): { index: number; target: "up" | "down" } {
  const to = Math.min(Math.max(index + delta, 0), length - 1);
  if (delta < 0) return { index: to, target: to === 0 ? "down" : "up" };
  return { index: to, target: to === length - 1 ? "up" : "down" };
}

/** Depois de remover o item `index`, o select vizinho: o que ocupou a posição, ou o anterior se era o último. */
export function focusAfterRemove(index: number, newLength: number): number {
  return Math.max(0, Math.min(index, newLength - 1));
}

export const moveAnnouncement = (name: string, position: number) => `${name} movido para a posição ${position}`;
export const removeAnnouncement = (name: string) => `${name} removido`;

/**
 * Opção vazia do select de produto. A 1ª linha dos principais não a tem quando há produto escolhido (como sempre foi);
 * com valor vazio ela aparece, para o select mostrar exatamente o estado (sem opção vazia, o navegador exibiria o
 * primeiro produto como se estivesse escolhido).
 */
export function emptyOptionLabel(o: { firstMain: boolean; value: string; hasProducts: boolean }): string | null {
  if (!o.firstMain) return "Escolha…";
  if (!o.hasProducts) return "Envie um PDF em Produtos";
  return o.value === "" ? "Escolha…" : null;
}
