"use client";

// Editor de oferta (P12). Preço por offers.updatePrice e produto/bump por offers.setProducts (ações sensíveis: diálogo de
// confirmação); endereço por offers.setSlug (sensível; o dono no painel executa direto); os demais campos por
// offers.update; pixel próprio por offers.setPixel (tracking.write, com diálogo). Prévia no celular ao lado.
// Por ora edita 1 produto principal e 1 no bump; oferta com mais não tem produtos/bump editáveis aqui (Task 4).
import { useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { brandVars } from "@/lib/brand";
import { editorCanEditProducts } from "@/lib/catalog/offer-editing";
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
  productId: string;
  priceCents: number;
  methods: string[];
  pixMode: "manual" | "asaas";
  maxInstallments: number;
  bumpProductId: string | null;
  bumpPriceCents: number | null;
  bumpLabel: string | null;
  thankYouText: string | null;
  pixelId: string | null;
  active: boolean;
  /** Quantos produtos principais e do bump a oferta tem (offer_product). */
  mainCount: number;
  bumpCount: number;
}

const MULTI_NOTICE = "Esta oferta tem vários produtos; edite os produtos e o bump pelo painel novo (em breve).";

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
  products: Array<{ id: string; name: string }>;
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
    productId: offer?.productId ?? products[0]?.id ?? "",
    price: offer ? centsToInput(offer.priceCents) : "",
    pix: offer ? offer.methods.includes("pix") : true,
    card: offer ? offer.methods.includes("card") : false,
    pixMode: offer?.pixMode ?? ("manual" as "manual" | "asaas"),
    maxInstallments: offer?.maxInstallments ?? 1,
    bumpOn: Boolean(offer?.bumpProductId),
    bumpProductId: offer?.bumpProductId ?? products.find((p) => p.id !== (offer?.productId ?? products[0]?.id))?.id ?? "",
    bumpPrice: offer?.bumpPriceCents ? centsToInput(offer.bumpPriceCents) : "",
    bumpLabel: offer?.bumpLabel ?? "",
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
  const bump = f.bumpOn && f.bumpProductId && bumpCents ? { productId: f.bumpProductId, priceCents: bumpCents, label: bumpLabel } : null;
  // Oferta com vários produtos: este editor não mexe em produtos nem no bump (salvar reduziria a lista a 1 por grupo).
  const productsEditable = editorCanEditProducts(offer && { mainCount: offer.mainCount, bumpCount: offer.bumpCount });
  const priceChanged = offer !== null && priceCents !== offer.priceCents;
  const slugChanged = offer !== null && f.slug !== offer.slug;
  const productChanged = productsEditable && offer !== null && f.productId !== offer.productId;
  const bumpChanged =
    productsEditable &&
    offer !== null &&
    JSON.stringify(bump) !==
      JSON.stringify(offer.bumpProductId && offer.bumpPriceCents ? { productId: offer.bumpProductId, priceCents: offer.bumpPriceCents, label: offer.bumpLabel } : null);
  /** Entrada de offers.setProducts / do bump de offers.create (1 produto em cada grupo neste editor). */
  const bumpInput = bump ? { productIds: [bump.productId], priceCents: bump.priceCents, label: bump.label } : null;
  const methods = [...(f.pix ? ["pix"] : []), ...(f.card ? ["card"] : [])];
  const cardBox = cardToggle(props.cardAvailable, f.card);
  const link = `${props.checkoutBase}/c/${f.slug || "endereco-da-oferta"}`;
  const productName = products.find((p) => p.id === f.productId)?.name ?? "Produto";
  const vars = useMemo(() => brandVars(props.brandColor) as CSSProperties, [props.brandColor]);

  function problem(): string | null {
    if (!f.name.trim()) return "Informe o nome da oferta.";
    if (!/^[a-z0-9-]{3,60}$/.test(f.slug)) return "Endereço: use 3 a 60 caracteres (letras minúsculas, números e hífen).";
    if (productsEditable && !f.productId) return "Escolha o produto entregue (envie o PDF em Produtos).";
    if (!priceCents || priceCents <= 0) return "Preço inválido. Use o formato 9,90.";
    if (methods.length === 0) return "Escolha ao menos um método de pagamento.";
    if (productsEditable && f.bumpOn && (!f.bumpProductId || !bumpCents)) return "Bump: escolha o produto e o preço do acréscimo.";
    if (productsEditable && f.bumpOn && f.bumpProductId === f.productId) return "O produto do bump deve ser diferente do principal.";
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
            productIds: [f.productId],
            priceCents,
            bump: bumpInput,
          }),
        { refresh: false, onOk: (o: { id: string }) => router.push(`/admin/offers/${o.id}?criada=1`) },
      );
      return;
    }
    if (priceChanged || productChanged || bumpChanged) {
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

  async function confirmPrice() {
    if (!offer) return;
    if (priceChanged) {
      const r = await save.run(() => updateOfferPriceAction({ id: offer.id, priceCents }), { refresh: false });
      if (!r.ok) return;
    }
    if (productChanged || bumpChanged) {
      const r = await save.run(() => setOfferProductsAction({ id: offer.id, productIds: [f.productId], bump: bumpInput }), { refresh: false });
      if (!r.ok) return;
    }
    setDialog(null);
    await saveRest("Oferta e preço salvos.");
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
                {productsEditable ? (
                  <label className={s.field}>
                    <span className={s.label}>Produto entregue</span>
                    <select className={s.select} value={f.productId} onChange={(e) => set("productId", e.target.value)}>
                      {products.length === 0 ? <option value="">Envie um PDF em Produtos</option> : null}
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className={s.field}>
                    <span className={s.label}>Produtos entregues</span>
                    <span className={s.hint}>{MULTI_NOTICE}</span>
                  </div>
                )}
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
              {productsEditable ? (
                <label className={s.switch}>
                  <span className={s.srOnly}>Oferecer order bump</span>
                  <input type="checkbox" checked={f.bumpOn} onChange={(e) => set("bumpOn", e.target.checked)} />
                </label>
              ) : null}
            </div>
            <p className={s.cardSub} style={{ margin: "0 0 16px" }}>
              {productsEditable ? "Uma caixa extra antes do botão de pagar. Sempre começa desmarcada." : MULTI_NOTICE}
            </p>
            {productsEditable && f.bumpOn ? (
              <div className={s.stack}>
                <div className={s.grid2}>
                  <label className={s.field}>
                    <span className={s.label}>Produto do bump</span>
                    <select className={s.select} value={f.bumpProductId} onChange={(e) => set("bumpProductId", e.target.value)}>
                      <option value="">Escolha…</option>
                      {products
                        .filter((p) => p.id !== f.productId)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
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
                  <input className={s.input} value={f.bumpLabel} maxLength={200} placeholder="Quero a versão completa" onChange={(e) => set("bumpLabel", e.target.value)} />
                  </label>
                  <span className={s.hint}>Quem marca recebe os dois PDFs no mesmo e-mail.</span>
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
        icon="tag"
        title="Alterar o preço desta oferta?"
        footer={
          <>
            <button type="button" className={s.btn} onClick={() => setDialog(null)} data-autofocus>
              Cancelar
            </button>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={confirmPrice} disabled={save.pending}>
              {save.pending ? "Salvando…" : "Salvar novo preço"}
            </button>
          </>
        }
      >
        <p>Vale para os próximos pedidos. Quem já gerou um Pix paga o valor antigo.</p>
        <ul className={s.infoList}>
          {priceChanged && offer ? (
            <li>
              <PIcon name="tag" size={16} />
              <span>
                Preço: {brl(offer.priceCents)} → <b>{priceCents ? brl(priceCents) : "—"}</b>
              </span>
            </li>
          ) : null}
          {productChanged && offer ? (
            <li>
              <PIcon name="file-text" size={16} />
              <span>
                Produto entregue: {products.find((p) => p.id === offer.productId)?.name ?? "produto"} → <b>{productName}</b>
              </span>
            </li>
          ) : null}
          {bumpChanged && offer ? (
            <li>
              <PIcon name="gift" size={16} />
              <span>
                Bump: {offer.bumpPriceCents ? brl(offer.bumpPriceCents) : "sem bump"} → <b>{bump ? brl(bump.priceCents) : "sem bump"}</b>
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
