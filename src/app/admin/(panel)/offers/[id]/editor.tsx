"use client";

// Editor de oferta (P12). Produtos principais e do bump em listas ordenadas (1 a 20 cada: adicionar, subir/descer,
// remover). Produtos/bump/rótulo por offers.setProducts, com o preço junto quando ele também mudou (atômico); só o
// preço por offers.updatePrice. As duas são sensíveis: diálogo de confirmação que diz o que muda. Endereço por
// offers.setSlug (sensível; o dono no painel executa direto); os demais campos por offers.update; pixel próprio por
// offers.setPixel (tracking.write, com diálogo). Prévia no celular ao lado. Regras puras em offer-editing.ts.
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { brandVars } from "@/lib/brand";
import { MAX_PRODUCTS_PER_GROUP, changeDialog, moveItem, offerChanges, productsProblem, removeAt, saveCall } from "@/lib/catalog/offer-editing";
import { brl, centsToInput, parseBrl } from "@/lib/format";
import { cardToggle } from "@/lib/payments/card-messages";
import { Badge } from "../../../blocks";
import { PIcon } from "../../../icons";
import s from "../../../panel.module.css";
import { CopyButton, Dialog, Live, useActionRunner } from "../../../ui";
import { createOfferAction, setOfferPixelAction, setOfferProductsAction, setOfferSlugAction, updateOfferAction, updateOfferPriceAction } from "../../actions";

export interface OfferData {
  id: string;
  slug: string;
  name: string;
  /** Produtos principais, na ordem da oferta. */
  productIds: string[];
  priceCents: number;
  methods: string[];
  pixMode: "manual" | "asaas";
  maxInstallments: number;
  bump: { productIds: string[]; priceCents: number; label: string | null } | null;
  thankYouText: string | null;
  pixelId: string | null;
  active: boolean;
}

/** Produto que pode aparecer nos selects. `deleted`: excluído (só aparece porque a oferta ainda o tem). */
export interface ProductOption {
  id: string;
  name: string;
  deleted?: boolean;
}

const slugify = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export function OfferEditor(props: {
  offer: OfferData | null;
  products: ProductOption[];
  checkoutBase: string;
  storeName: string;
  brandColor: string | null;
  canWrite: boolean;
  canPixel: boolean;
  /** Serviço de cartão configurado na instalação (CARD_ORIGIN). Sem ele, o cartão não liga e o editor diz por quê. */
  cardAvailable: boolean;
  /** Acabou de ser criada (a página nova mostra a confirmação). */
  created?: boolean;
}) {
  const { offer, products, canWrite } = props;
  const router = useRouter();
  const [f, setF] = useState(() => ({
    name: offer?.name ?? "",
    slug: offer?.slug ?? "",
    productIds: offer?.productIds ?? [products.find((p) => !p.deleted)?.id ?? ""],
    price: offer ? centsToInput(offer.priceCents) : "",
    pix: offer ? offer.methods.includes("pix") : true,
    card: offer ? offer.methods.includes("card") : false,
    pixMode: offer?.pixMode ?? ("manual" as "manual" | "asaas"),
    maxInstallments: offer?.maxInstallments ?? 1,
    bumpOn: offer?.bump != null,
    bumpProductIds: offer?.bump?.productIds ?? [""],
    bumpPrice: offer?.bump ? centsToInput(offer.bump.priceCents) : "",
    bumpLabel: offer?.bump?.label ?? "",
    thankYouText: offer?.thankYouText ?? "",
    active: offer?.active ?? true,
  }));
  const [slugTouched, setSlugTouched] = useState(Boolean(offer));
  const [pixelOn, setPixelOn] = useState(Boolean(offer?.pixelId));
  const [pixel, setPixel] = useState(offer?.pixelId ?? "");
  const [dialog, setDialog] = useState<null | "price" | "pixel">(null);
  const save = useActionRunner();
  const px = useActionRunner();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const priceCents = parseBrl(f.price);
  const bumpCents = f.bumpOn ? parseBrl(f.bumpPrice) : null;
  const bumpLabel = f.bumpLabel.trim() || null;
  /** Bump como as ações recebem (offers.create / offers.setProducts). */
  const bumpInput = f.bumpOn && bumpCents ? { productIds: f.bumpProductIds, priceCents: bumpCents, label: bumpLabel } : null;
  const changes = offer
    ? offerChanges({ priceCents: offer.priceCents, productIds: offer.productIds, bump: offer.bump }, { priceCents, productIds: f.productIds, bump: bumpInput })
    : null;
  const slugChanged = offer !== null && f.slug !== offer.slug;
  const methods = [...(f.pix ? ["pix"] : []), ...(f.card ? ["card"] : [])];
  const cardBox = cardToggle(props.cardAvailable, f.card);
  const link = `${props.checkoutBase}/c/${f.slug || "endereco-da-oferta"}`;
  const nameOf = (id: string) => products.find((p) => p.id === id)?.name ?? "Produto";
  const namesOf = (ids: string[]) => ids.map(nameOf).join(" · ");
  const productName = f.productIds.length > 1 ? f.name.trim() || "Oferta" : nameOf(f.productIds[0] ?? "");
  const vars = useMemo(() => brandVars(props.brandColor) as CSSProperties, [props.brandColor]);
  /** Produtos já escolhidos em alguma linha (o bump só conta ligado): o mesmo produto não entra duas vezes. */
  const used = new Set([...f.productIds, ...(f.bumpOn ? f.bumpProductIds : [])].filter(Boolean));
  const firstUnused = (taken: Set<string>) => products.find((p) => !p.deleted && !taken.has(p.id))?.id ?? "";

  function problem(): string | null {
    if (!f.name.trim()) return "Informe o nome da oferta.";
    if (!/^[a-z0-9-]{3,60}$/.test(f.slug)) return "Endereço: use 3 a 60 caracteres (letras minúsculas, números e hífen).";
    const lists = productsProblem({ productIds: f.productIds, bumpOn: f.bumpOn, bumpProductIds: f.bumpProductIds, bumpPriceCents: bumpCents, bumpLabel });
    if (lists) return lists;
    if (!priceCents || priceCents <= 0) return "Preço inválido. Use o formato 9,90.";
    if (methods.length === 0) return "Escolha ao menos um método de pagamento.";
    // Produto excluído só pode ficar se a lista não for regravada (offers.setProducts recusaria).
    if (!changes || saveCall(changes)?.action === "setProducts") {
      const gone = [...used].find((id) => products.find((p) => p.id === id)?.deleted);
      if (gone) return `“${nameOf(gone)}” foi excluído: troque ou remova esse produto da oferta.`;
    }
    return null;
  }

  const common = () => ({
    name: f.name.trim(),
    methods,
    pixMode: f.pixMode,
    maxInstallments: f.maxInstallments,
    thankYouText: f.thankYouText.trim() || null,
    active: f.active,
  });

  async function submit() {
    const p = problem();
    if (p) {
      save.setMsg({ tone: "error", text: p });
      return;
    }
    if (!offer) {
      await save.run(
        () =>
          createOfferAction({
            ...common(),
            slug: f.slug,
            productIds: f.productIds,
            priceCents,
            bump: bumpInput,
          }),
        { refresh: false, onOk: (o: { id: string }) => router.push(`/admin/offers/${o.id}?criada=1`) },
      );
      return;
    }
    if (changes && saveCall(changes)) {
      setDialog("price");
      return;
    }
    await saveRest();
  }

  /** Endereço (offers.setSlug, se mudou) e os demais campos (offers.update). */
  async function saveRest(ok?: string) {
    if (!offer) return;
    if (slugChanged) {
      const r = await save.run(() => setOfferSlugAction({ id: offer.id, slug: f.slug }), { refresh: false });
      if (!r.ok) return;
    }
    await save.run(() => updateOfferAction({ id: offer.id, ...common() }), ok ? { ok } : {});
  }

  /** Ação sensível confirmada no diálogo (produtos e preço juntos, ou só o preço); depois os demais campos. */
  async function confirmChanges() {
    if (!offer || !changes) return;
    const c = saveCall(changes);
    if (c?.action === "setProducts") {
      const input = { id: offer.id, productIds: f.productIds, bump: bumpInput, ...(c.withPrice ? { priceCents } : {}) };
      const r = await save.run(() => setOfferProductsAction(input), { refresh: false });
      if (!r.ok) return;
    } else if (c?.action === "updatePrice") {
      const r = await save.run(() => updateOfferPriceAction({ id: offer.id, priceCents }), { refresh: false });
      if (!r.ok) return;
    }
    setDialog(null);
    await saveRest(c?.action === "updatePrice" ? "Oferta e preço salvos." : "Oferta salva.");
  }

  const dialogText = changes ? changeDialog(changes) : null;
  const bumpSummary = (b: { productIds: string[]; priceCents: number } | null) => (b ? `${namesOf(b.productIds)} + ${brl(b.priceCents)}` : "sem bump");
  const quoted = (t: string | null) => (t ? `“${t}”` : "sem título");

  /** Lista ordenada de selects de produto: a primeira linha leva `firstLabel` (os rótulos que o E2E usa). */
  function productList(o: { ids: string[]; onChange: (ids: string[]) => void; firstLabel: string; lineLabel: (n: number) => string; addLabel?: string; firstEmpty: ReactNode }) {
    const { ids, onChange } = o;
    return (
      <div className={s.productLines}>
        {ids.map((id, i) => {
          const label = i === 0 ? o.firstLabel : o.lineLabel(i + 1);
          const what = id ? nameOf(id) : `produto ${i + 1}`;
          return (
            <div className={s.productLine} key={i}>
              <label className={s.field}>
                <span className={s.label}>{label}</span>
                <select className={s.select} value={id} onChange={(e) => onChange(ids.map((x, j) => (j === i ? e.target.value : x)))}>
                  {i === 0 ? o.firstEmpty : <option value="">Escolha…</option>}
                  {products.map((p) => (
                    <option key={p.id} value={p.id} disabled={p.id !== id && (p.deleted || used.has(p.id))}>
                      {p.deleted ? `${p.name} (excluído)` : p.name}
                    </option>
                  ))}
                </select>
              </label>
              {ids.length > 1 ? (
                <>
                  <button type="button" className={s.iconBtn} aria-label={`Mover ${what} para cima`} disabled={i === 0} onClick={() => onChange(moveItem(ids, i, -1))}>
                    <PIcon name="chevron-up" size={16} />
                  </button>
                  <button type="button" className={s.iconBtn} aria-label={`Mover ${what} para baixo`} disabled={i === ids.length - 1} onClick={() => onChange(moveItem(ids, i, 1))}>
                    <PIcon name="chevron-down" size={16} />
                  </button>
                  <button type="button" className={s.iconBtn} aria-label={`Remover ${what}`} onClick={() => onChange(removeAt(ids, i))}>
                    <PIcon name="x" size={16} />
                  </button>
                </>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className={`${s.btn} ${s.btnSm}`}
          style={{ alignSelf: "flex-start" }}
          aria-label={o.addLabel}
          disabled={ids.length >= MAX_PRODUCTS_PER_GROUP}
          onClick={() => onChange([...ids, firstUnused(used)])}
        >
          <PIcon name="plus" size={16} />
          Adicionar produto
        </button>
      </div>
    );
  }

  const ro = !canWrite;
  return (
    <>
      <Link className={s.back} href="/admin/offers">
        <PIcon name="arrow-left" size={16} />
        Ofertas
      </Link>
      <div className={s.pageHead}>
        <div className={s.titleRow}>
          <h1>{offer ? offer.name : "Nova oferta"}</h1>
          {offer ? <Badge tone={offer.active ? "success" : "neutral"}>{offer.active ? "Ativa" : "Inativa"}</Badge> : null}
        </div>
        <div className={s.headActions}>
          {offer ? (
            <a className={s.btn} href={`${props.checkoutBase}/c/${offer.slug}`} target="_blank" rel="noreferrer">
              <PIcon name="external-link" size={16} />
              Ver checkout
            </a>
          ) : null}
          {canWrite ? (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={submit} disabled={save.pending}>
              {save.pending ? "Salvando…" : offer ? "Salvar" : "Criar oferta"}
            </button>
          ) : null}
        </div>
      </div>
      <Live msg={save.msg ?? (props.created ? { tone: "ok", text: "Oferta criada." } : null)} />

      <div className={s.split}>
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset className={s.card} disabled={ro} style={{ margin: 0 }}>
            <legend className={s.sectionTitle} style={{ float: "left", width: "100%" }}>
              Oferta
            </legend>
            <p className={s.cardSub} style={{ clear: "both", margin: "0 0 16px" }}>
              O que o comprador vê no topo do checkout.
            </p>
            <div className={s.stack}>
              <div className={s.formGrid}>
                <label className={s.field}>
                  <span className={s.label}>Nome da oferta</span>
                  <input
                    className={s.input}
                    value={f.name}
                    maxLength={200}
                    onChange={(e) => {
                      set("name", e.target.value);
                      if (!slugTouched) set("slug", slugify(e.target.value));
                    }}
                  />
                </label>
                <div className={s.field}>
                  <label className={s.field}>
                  <span className={s.label}>Preço</span>
                  <input className={s.input} value={f.price} inputMode="decimal" placeholder="9,90" onChange={(e) => set("price", e.target.value)} />
                  </label>
                  {priceCents ? <span className={s.hint}>{brl(priceCents)}</span> : null}
                </div>
              </div>
              <div className={s.formGrid}>
                {productList({
                  ids: f.productIds,
                  onChange: (ids) => set("productIds", ids),
                  firstLabel: "Produto entregue",
                  lineLabel: (n) => `Produto ${n}`,
                  firstEmpty: products.length === 0 ? <option value="">Envie um PDF em Produtos</option> : null,
                })}
                <div className={s.field}>
                  <label className={s.field}>
                  <span className={s.label}>Endereço (slug)</span>
                  <input
                    className={`${s.input} ${s.mono}`}
                    value={f.slug}
                    maxLength={60}
                    onChange={(e) => {
                      setSlugTouched(true);
                      set("slug", e.target.value.toLowerCase());
                    }}
                  />
                  </label>
                  <span className={s.hint}>Só letras minúsculas, números e hífen.</span>
                </div>
              </div>
              <div className={s.field}>
                <span className={s.label}>Link do checkout</span>
                <div className={s.copyBox}>
                  <code>{link}</code>
                  <CopyButton text={link} small />
                </div>
              </div>
              <label className={s.switch}>
                <input type="checkbox" checked={f.active} onChange={(e) => set("active", e.target.checked)} />
                Oferta ativa (checkout aberto para compras)
              </label>
            </div>
          </fieldset>

          <fieldset className={s.card} disabled={ro} style={{ margin: 0 }}>
            <legend className={s.sectionTitle} style={{ float: "left", width: "100%" }}>
              Pagamento
            </legend>
            <p className={s.cardSub} style={{ clear: "both", margin: "0 0 16px" }}>
              Quais métodos aparecem neste checkout.
            </p>
            <div className={s.stack}>
              <div className={s.grid2}>
                <label className={s.check}>
                  <input type="checkbox" checked={f.pix} onChange={(e) => set("pix", e.target.checked)} />
                  Pix
                </label>
                <label className={s.check}>
                  <input type="checkbox" checked={f.card} onChange={(e) => set("card", e.target.checked)} disabled={cardBox.disabled} aria-describedby={cardBox.notice ? "cartao-indisponivel" : undefined} />
                  Cartão de crédito
                </label>
              </div>
              {cardBox.notice ? (
                <p id="cartao-indisponivel" className={s.hint} role="note">
                  {cardBox.notice}
                </p>
              ) : null}
              <div className={s.grid2}>
                <div className={s.field} role="radiogroup" aria-label="Modo do Pix">
                  <span className={s.label}>Modo do Pix</span>
                  <div className={s.segment} style={{ alignSelf: "flex-start" }}>
                    <label>
                      <input type="radio" name="pixMode" checked={f.pixMode === "asaas"} onChange={() => set("pixMode", "asaas")} />
                      Asaas (automático)
                    </label>
                    <label>
                      <input type="radio" name="pixMode" checked={f.pixMode === "manual"} onChange={() => set("pixMode", "manual")} />
                      Manual
                    </label>
                  </div>
                  <span className={s.hint}>
                    {f.pixMode === "asaas"
                      ? "Com Asaas o pedido é liberado sozinho e o comprador informa CPF."
                      : "Pix direto na sua chave: você confere no extrato e libera cada pedido."}
                  </span>
                </div>
                <div className={s.field}>
                  <label className={s.field}>
                  <span className={s.label}>Parcelas máximas no cartão</span>
                  <select className={s.select} value={f.maxInstallments} onChange={(e) => set("maxInstallments", Number(e.target.value))} disabled={ro || !f.card}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n === 1 ? "1x (à vista)" : `até ${n}x`}
                      </option>
                    ))}
                  </select>
                  </label>
                  <span className={s.hint}>Parcela mínima do Asaas: R$ 5,00.</span>
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset className={s.card} disabled={ro} style={{ margin: 0 }}>
            <div className={s.cardHead} style={{ marginBottom: 4 }}>
              <legend className={s.sectionTitle}>Order bump</legend>
              <label className={s.switch}>
                <span className={s.srOnly}>Oferecer order bump</span>
                <input
                  type="checkbox"
                  checked={f.bumpOn}
                  onChange={(e) => {
                    const on = e.target.checked;
                    // Ao ligar, linha vazia ou repetida com um principal ganha o primeiro produto livre.
                    const main = new Set(f.productIds);
                    const ids = f.bumpProductIds.map((id) => (id && !main.has(id) ? id : ""));
                    setF((x) => ({ ...x, bumpOn: on, bumpProductIds: on ? ids.map((id) => id || firstUnused(new Set([...main, ...ids]))) : x.bumpProductIds }));
                  }}
                />
              </label>
            </div>
            <p className={s.cardSub} style={{ margin: "0 0 16px" }}>
              Uma caixa extra antes do botão de pagar. Sempre começa desmarcada.
            </p>
            {f.bumpOn ? (
              <div className={s.stack}>
                <div className={s.grid2}>
                  {productList({
                    ids: f.bumpProductIds,
                    onChange: (ids) => set("bumpProductIds", ids),
                    firstLabel: "Produto do bump",
                    lineLabel: (n) => `Produto ${n} do bump`,
                    addLabel: "Adicionar produto ao bump",
                    firstEmpty: <option value="">Escolha…</option>,
                  })}
                  <div className={s.field}>
                    <label className={s.field}>
                    <span className={s.label}>Preço do acréscimo</span>
                    <input className={s.input} value={f.bumpPrice} inputMode="decimal" placeholder="17,10" onChange={(e) => set("bumpPrice", e.target.value)} />
                    </label>
                    {priceCents && bumpCents ? <span className={s.hint}>Total com bump: {brl(priceCents + bumpCents)}</span> : null}
                  </div>
                </div>
                <div className={s.field}>
                  <label className={s.field}>
                  <span className={s.label}>Título da caixa</span>
                  <input
                    className={s.input}
                    value={f.bumpLabel}
                    maxLength={200}
                    placeholder={f.bumpProductIds.length > 1 ? "5 Kits Extras" : "Quero a versão completa"}
                    aria-required={f.bumpProductIds.length > 1}
                    onChange={(e) => set("bumpLabel", e.target.value)}
                  />
                  </label>
                  <span className={s.hint}>
                    {f.bumpProductIds.length > 1 ? "Obrigatório com mais de um produto. " : ""}Quem marca recebe tudo no mesmo e-mail.
                  </span>
                </div>
              </div>
            ) : null}
          </fieldset>

          <fieldset className={s.card} disabled={ro} style={{ margin: 0 }}>
            <legend className={s.sectionTitle} style={{ float: "left", width: "100%" }}>
              Página de obrigado
            </legend>
            <label className={s.field} style={{ clear: "both" }}>
              <span className={s.label}>Mensagem exibida depois do pagamento confirmado</span>
              <textarea className={s.textarea} value={f.thankYouText} maxLength={2000} onChange={(e) => set("thankYouText", e.target.value)} />
            </label>
          </fieldset>
          <button type="submit" hidden />
        </form>

        <div className={s.stack}>
          <span className={s.eyebrow}>Prévia no celular</span>
          <div className={s.preview} style={vars} aria-hidden="true">
            <div className={s.previewHead}>
              <b>{props.storeName}</b>
              <span>Pagamento seguro</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>{productName}</span>
              <b>{priceCents ? brl(priceCents) : "—"}</b>
            </div>
            {f.productIds.length > 1 ? <p className={s.previewIncludes}>Inclui: {namesOf(f.productIds.filter(Boolean))}</p> : null}
            {f.bumpOn && bumpCents ? (
              <div className={s.previewBump}>
                <b>{f.bumpLabel || "Acrescentar"}</b> + {brl(bumpCents)}
              </div>
            ) : null}
            <span className={s.previewBtn}>
              {f.pix ? "Gerar Pix" : "Pagar"} de {priceCents ? brl(priceCents) : "R$ —"}
            </span>
          </div>

          {offer ? (
            <section className={s.card} aria-labelledby="pixel-titulo">
              <div className={s.cardHead}>
                <h2 id="pixel-titulo">Pixel próprio desta oferta</h2>
                {props.canPixel ? (
                  <label className={s.switch}>
                    <span className={s.srOnly}>Usar pixel próprio</span>
                    <input type="checkbox" checked={pixelOn} onChange={(e) => setPixelOn(e.target.checked)} />
                  </label>
                ) : null}
              </div>
              <p className={s.cardSub}>Opcional. Sem preencher, usa o Pixel da loja (Conexões → Meta).</p>
              {pixelOn ? (
                <label className={s.field}>
                  <span className={s.label}>Pixel ID</span>
                  <input
                    className={`${s.input} ${s.mono}`}
                    value={pixel}
                    inputMode="numeric"
                    placeholder="ex.: 1234567890123456"
                    disabled={!props.canPixel}
                    onChange={(e) => setPixel(e.target.value.trim())}
                  />
                </label>
              ) : null}
              {props.canPixel ? (
                <div className={s.formActions} style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className={s.btn}
                    disabled={px.pending || (pixelOn ? pixel === (offer.pixelId ?? "") : offer.pixelId === null)}
                    onClick={() => {
                      if (pixelOn && !/^\d{5,20}$/.test(pixel)) {
                        px.setMsg({ tone: "error", text: "Pixel ID: só números (5 a 20)." });
                        return;
                      }
                      setDialog("pixel");
                    }}
                  >
                    Salvar pixel
                  </button>
                </div>
              ) : null}
              <Live msg={px.msg} />
            </section>
          ) : null}
        </div>
      </div>

      <Dialog
        open={dialog === "price"}
        onClose={() => setDialog(null)}
        icon={changes?.products || changes?.bump ? "package" : "tag"}
        title={dialogText?.title ?? ""}
        footer={
          <>
            <button type="button" className={s.btn} onClick={() => setDialog(null)} data-autofocus>
              Cancelar
            </button>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={confirmChanges} disabled={save.pending}>
              {save.pending ? "Salvando…" : (dialogText?.confirm ?? "Salvar")}
            </button>
          </>
        }
      >
        <p>
          Vale para os próximos pedidos.
          {changes?.price ? " Quem já gerou um Pix paga o valor antigo." : ""}
          {changes?.products || changes?.bump ? " Pedidos já feitos recebem o que foi comprado." : ""}
        </p>
        <ul className={s.infoList}>
          {changes?.price && offer ? (
            <li>
              <PIcon name="tag" size={16} />
              <span>
                Preço: {brl(offer.priceCents)} → <b>{priceCents ? brl(priceCents) : "—"}</b>
              </span>
            </li>
          ) : null}
          {changes?.products && offer ? (
            <li>
              <PIcon name="file-text" size={16} />
              <span>
                Produtos entregues: {namesOf(offer.productIds)} → <b>{namesOf(f.productIds)}</b>
              </span>
            </li>
          ) : null}
          {changes?.bump && offer ? (
            <li>
              <PIcon name="gift" size={16} />
              <span>
                Bump: {bumpSummary(offer.bump)} → <b>{bumpSummary(bumpInput)}</b>
              </span>
            </li>
          ) : null}
          {changes?.label && offer ? (
            <li>
              <PIcon name="gift" size={16} />
              <span>
                Título da caixa: {quoted(offer.bump?.label ?? null)} → <b>{quoted(bumpLabel)}</b>
              </span>
            </li>
          ) : null}
        </ul>
        {save.msg?.tone === "error" ? <Live msg={save.msg} /> : null}
      </Dialog>

      <Dialog
        open={dialog === "pixel"}
        onClose={() => setDialog(null)}
        icon="code"
        title={pixelOn ? `Usar o Pixel ${pixel} nesta oferta?` : "Voltar a usar o Pixel da loja?"}
        footer={
          <>
            <button type="button" className={s.btn} onClick={() => setDialog(null)} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnPrimary}`}
              disabled={px.pending}
              onClick={async () => {
                const r = await px.run(() => setOfferPixelAction(offer!.id, pixelOn ? pixel : null));
                if (r.ok) setDialog(null);
              }}
            >
              {px.pending ? "Salvando…" : "Salvar pixel"}
            </button>
          </>
        }
      >
        <p>
          {pixelOn
            ? "Os eventos desta oferta (navegador e API de Conversões) passam a ir para este Pixel. Ele é conferido com o token da loja antes de salvar."
            : "Os eventos desta oferta voltam para o Pixel configurado em Conexões."}
        </p>
        {px.msg?.tone === "error" ? <Live msg={px.msg} /> : null}
      </Dialog>
    </>
  );
}
