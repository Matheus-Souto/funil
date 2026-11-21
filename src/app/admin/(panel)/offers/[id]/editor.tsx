"use client";

// Editor de oferta (P12). Produtos principais e do bump em listas ordenadas (1 a 20 cada: adicionar, subir/descer,
// remover). Produtos/bump/rótulo por offers.setProducts, com o preço junto quando ele também mudou (atômico); só o
// preço por offers.updatePrice. As duas são sensíveis: diálogo de confirmação que diz o que muda. Endereço por
// offers.setSlug (sensível; o dono no painel executa direto); os demais campos por offers.update; pixel próprio por
// offers.setPixel (tracking.write, com diálogo). Prévia no celular ao lado. Regras puras em offer-editing.ts.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MAX_PRODUCTS_PER_GROUP,
  changeDialog,
  emptyOptionLabel,
  fillBumpLines,
  focusAfterMove,
  focusAfterRemove,
  moveAnnouncement,
  moveItem,
  offerChanges,
  productsProblem,
  removeAnnouncement,
  removeAt,
  runSaveSteps,
  saveCall,
  saveOutcome,
  type SaveStep,
} from "@/lib/catalog/offer-editing";
import { brl, centsToInput, parseBrl } from "@/lib/format";
import { cardToggle } from "@/lib/payments/card-messages";
import { Art, Badge } from "../../../blocks";
import { PIX_BRAND } from "../../../brand-icons";
import { CreditCard, Info } from "lucide-react";
import { MoneyInput } from "@/components/arc/money-input/money-input";
import { Select } from "@/components/arc/select/select";
import { PIcon } from "../../../icons";
import s from "../../../panel.module.css";
import type { ActionResult } from "../../../result";
import { CopyButton, Dialog, Live, useActionRunner } from "../../../ui";
import {
  createOfferAction,
  setOfferPixelAction,
  setOfferProductsAction,
  setOfferSlugAction,
  updateOfferAction,
  updateOfferPriceAction,
} from "../../actions";

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

/** Linha de select de produto: `key` local e estável (não muda ao trocar o produto, então o select não perde o foco). */
type Line = { key: string; id: string };
let lineSeq = 0;
const newLine = (id: string): Line => ({ key: `linha-${++lineSeq}`, id });
const ids = (lines: Line[]) => lines.map((l) => l.id);
/** Valor do menu para "nenhum produto" (o menu do Arc não aceita valor vazio). */
const NONE = "__nenhum__";

const slugify = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/** Formulário a partir da oferta salva (ou vazio, para uma oferta nova). */
function initialForm(offer: OfferData | null, products: ProductOption[]) {
  return {
    name: offer?.name ?? "",
    slug: offer?.slug ?? "",
    main: (offer?.productIds ?? [products.find((p) => !p.deleted)?.id ?? ""]).map(newLine),
    price: offer ? centsToInput(offer.priceCents) : "",
    pix: offer ? offer.methods.includes("pix") : true,
    card: offer ? offer.methods.includes("card") : false,
    pixMode: offer?.pixMode ?? ("manual" as "manual" | "asaas"),
    maxInstallments: offer?.maxInstallments ?? 1,
    bumpOn: offer?.bump != null,
    bumpLines: (offer?.bump?.productIds ?? [""]).map(newLine),
    bumpPrice: offer?.bump ? centsToInput(offer.bump.priceCents) : "",
    bumpLabel: offer?.bump?.label ?? "",
    thankYouText: offer?.thankYouText ?? "",
    active: offer?.active ?? true,
  };
}

/**
 * O que importa para saber se mudou: sem as chaves locais das linhas de produto, com os textos aparados como o salvar
 * grava, e sem os campos do bump quando ele está desligado (não são salvos).
 */
const comparable = (f: ReturnType<typeof initialForm>) => ({
  ...f,
  name: f.name.trim(),
  thankYouText: f.thankYouText.trim(),
  main: ids(f.main),
  bumpLines: f.bumpOn ? ids(f.bumpLines) : [],
  bumpPrice: f.bumpOn ? f.bumpPrice : "",
  bumpLabel: f.bumpOn ? f.bumpLabel.trim() : "",
});

export function OfferEditor(props: {
  offer: OfferData | null;
  products: ProductOption[];
  checkoutBase: string;
  canWrite: boolean;
  canPixel: boolean;
  /** Serviço de cartão configurado na instalação (CARD_ORIGIN). Sem ele, o cartão não liga e o editor diz por quê. */
  cardAvailable: boolean;
  /** Acabou de ser criada (a página nova mostra a confirmação). */
  created?: boolean;
}) {
  const { offer, products, canWrite } = props;
  const router = useRouter();
  const [f, setF] = useState(() => initialForm(offer, products));
  /** Há diferença entre o formulário e a oferta salva (a barra de baixo avisa e permite descartar). */
  const dirty = !offer || JSON.stringify(comparable(f)) !== JSON.stringify(comparable(initialForm(offer, products)));
  const discard = () => offer && setF(initialForm(offer, products));
  const [slugTouched, setSlugTouched] = useState(Boolean(offer));
  const [pixelOn, setPixelOn] = useState(Boolean(offer?.pixelId));
  const [pixel, setPixel] = useState(offer?.pixelId ?? "");
  const [dialog, setDialog] = useState<null | "price" | "pixel">(null);
  const save = useActionRunner();
  const px = useActionRunner();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const productIds = ids(f.main);
  const bumpProductIds = ids(f.bumpLines);
  // Foco depois de mover/remover/adicionar: chave `<linha>:<up|down|select>` aplicada após o render.
  const focusables = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<string | null>(null);
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    const k = pendingFocus.current;
    if (!k) return;
    pendingFocus.current = null;
    focusables.current.get(k)?.focus();
  });
  const focusRef = (k: string) => (el: HTMLElement | null) => {
    if (el) focusables.current.set(k, el);
    else focusables.current.delete(k);
  };

  const priceCents = parseBrl(f.price);
  const bumpCents = f.bumpOn ? parseBrl(f.bumpPrice) : null;
  const bumpLabel = f.bumpLabel.trim() || null;
  /** Bump como as ações recebem (offers.create / offers.setProducts). */
  const bumpInput = f.bumpOn && bumpCents ? { productIds: bumpProductIds, priceCents: bumpCents, label: bumpLabel } : null;
  const changes = offer
    ? offerChanges(
        { priceCents: offer.priceCents, productIds: offer.productIds, bump: offer.bump },
        { priceCents, productIds: productIds, bump: bumpInput },
      )
    : null;
  const slugChanged = offer !== null && f.slug !== offer.slug;
  const methods = [...(f.pix ? ["pix"] : []), ...(f.card ? ["card"] : [])];
  const cardBox = cardToggle(props.cardAvailable, f.card);
  const link = `${props.checkoutBase}/c/${f.slug || "endereco-da-oferta"}`;
  const nameOf = (id: string) => products.find((p) => p.id === id)?.name ?? "Produto";
  const namesOf = (ids: string[]) => ids.map(nameOf).join(" · ");
  /** Produtos já escolhidos em alguma linha (o bump só conta ligado): o mesmo produto não entra duas vezes. */
  const used = new Set([...productIds, ...(f.bumpOn ? bumpProductIds : [])].filter(Boolean));
  const available = products.filter((p) => !p.deleted).map((p) => p.id);
  const firstUnused = (taken: Set<string>) => available.find((id) => !taken.has(id)) ?? "";

  function problem(): string | null {
    if (!f.name.trim()) return "Informe o nome da oferta.";
    if (!/^[a-z0-9-]{3,60}$/.test(f.slug)) return "Endereço: use 3 a 60 caracteres (letras minúsculas, números e hífen).";
    const lists = productsProblem({ productIds: productIds, bumpOn: f.bumpOn, bumpProductIds: bumpProductIds, bumpPriceCents: bumpCents, bumpLabel });
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
            productIds: productIds,
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
    await saveAll(restSteps(), "Oferta salva.");
  }

  /** Uma server action como passo da gravação (a mensagem final é montada por saveOutcome). */
  const step = <T,>(label: string, fn: () => Promise<ActionResult<T>>): SaveStep => ({
    label,
    run: async () => {
      const r = await save.run(fn, { refresh: false });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
  });

  /** Endereço (offers.setSlug, se mudou) e os demais campos (offers.update). */
  function restSteps(): SaveStep[] {
    if (!offer) return [];
    return [
      ...(slugChanged ? [step("endereço", () => setOfferSlugAction({ id: offer.id, slug: f.slug }))] : []),
      step("demais dados", () => updateOfferAction({ id: offer.id, ...common() })),
    ];
  }

  /**
   * Roda as gravações em ordem e para no primeiro erro. Se algo foi salvo, recarrega a oferta do servidor (a base do
   * editor passa a ser o que está salvo, mesmo que um passo seguinte tenha falhado) e a mensagem diz o que foi salvo e o
   * que não foi.
   */
  async function saveAll(steps: SaveStep[], okText: string) {
    const r = await runSaveSteps(steps);
    if (r.saved.length > 0) router.refresh();
    save.setMsg(saveOutcome(r, okText));
    return r;
  }

  /** Ação sensível confirmada no diálogo (produtos e preço juntos, ou só o preço); depois os demais campos. */
  async function confirmChanges() {
    if (!offer || !changes) return;
    const c = saveCall(changes);
    const sensitive =
      c?.action === "setProducts"
        ? [
            step(c.withPrice ? "preço e produtos" : "produtos", () =>
              setOfferProductsAction({ id: offer.id, productIds, bump: bumpInput, ...(c.withPrice ? { priceCents } : {}) }),
            ),
          ]
        : c?.action === "updatePrice"
          ? [step("preço", () => updateOfferPriceAction({ id: offer.id, priceCents }))]
          : [];
    const r = await saveAll([...sensitive, ...restSteps()], c?.action === "updatePrice" ? "Oferta e preço salvos." : "Oferta salva.");
    // Nada salvo: o diálogo fica aberto com o erro. Algo salvo: fecha e a mensagem aparece na página.
    if (r.saved.length > 0) setDialog(null);
  }

  const dialogText = changes ? changeDialog(changes) : null;
  const bumpSummary = (b: { productIds: string[]; priceCents: number } | null) =>
    b ? `${namesOf(b.productIds)} + ${brl(b.priceCents)}` : "sem bump";
  const quoted = (t: string | null) => (t ? `“${t}”` : "sem título");

  /** Lista ordenada de selects de produto: a primeira linha leva `firstLabel` (os rótulos que o E2E usa). */
  function productList(o: { group: "main" | "bumpLines"; firstLabel: string; lineLabel: (n: number) => string; addLabel?: string }) {
    const lines = f[o.group];
    const setLines = (next: Line[]) => set(o.group, next);
    const nameAt = (l: Line, i: number) => (l.id ? nameOf(l.id) : `produto ${i + 1}`);
    function move(i: number, delta: -1 | 1) {
      const to = focusAfterMove(i, delta, lines.length);
      pendingFocus.current = `${lines[i]!.key}:${to.target}`;
      setLines(moveItem(lines, i, delta));
      setAnnounce(moveAnnouncement(nameAt(lines[i]!, i), to.index + 1));
    }
    function remove(i: number) {
      const rest = removeAt(lines, i);
      pendingFocus.current = `${rest[focusAfterRemove(i, rest.length)]!.key}:select`;
      setLines(rest);
      setAnnounce(removeAnnouncement(nameAt(lines[i]!, i)));
    }
    return (
      <div className={s.productLines}>
        {lines.map((line, i) => {
          const label = i === 0 ? o.firstLabel : o.lineLabel(i + 1);
          const what = nameAt(line, i);
          const empty = emptyOptionLabel({ firstMain: o.group === "main" && i === 0, value: line.id, hasProducts: products.length > 0 });
          return (
            <div className={s.productLine} key={line.key}>
              <Select
                ref={focusRef(`${line.key}:select`)}
                className={s.arcField}
                label={label}
                value={line.id || NONE}
                onValueChange={(v) => setLines(lines.map((l, j) => (j === i ? { ...l, id: v === NONE ? "" : v } : l)))}
                options={[
                  ...(empty !== null ? [{ value: NONE, label: empty }] : []),
                  ...products.map((p) => ({
                    value: p.id,
                    label: p.deleted ? `${p.name} (excluído)` : p.name,
                    disabled: p.id !== line.id && (p.deleted || used.has(p.id)),
                  })),
                ]}
              />
              {lines.length > 1 ? (
                <>
                  <button
                    type="button"
                    ref={focusRef(`${line.key}:up`)}
                    className={s.iconBtn}
                    aria-label={`Mover ${what} para cima`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <PIcon name="chevron-up" size={16} />
                  </button>
                  <button
                    type="button"
                    ref={focusRef(`${line.key}:down`)}
                    className={s.iconBtn}
                    aria-label={`Mover ${what} para baixo`}
                    disabled={i === lines.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <PIcon name="chevron-down" size={16} />
                  </button>
                  <button type="button" className={s.iconBtn} aria-label={`Remover ${what}`} onClick={() => remove(i)}>
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
          disabled={lines.length >= MAX_PRODUCTS_PER_GROUP}
          onClick={() => {
            const line = newLine(firstUnused(used));
            pendingFocus.current = `${line.key}:select`;
            setLines([...lines, line]);
          }}
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
        </div>
      </div>
      <Live msg={save.msg ?? (props.created ? { tone: "ok", text: "Oferta criada." } : null)} />
      <p className={s.srOnly} role="status" aria-live="polite">
        {announce}
      </p>

      <div>
        <div className={s.stack}>
          <form
            className={s.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <fieldset className={s.card} disabled={ro} style={{ margin: 0 }}>
              <legend className={s.sectionLegend}>
                <Art name="ticket" size={24} className={s.cardArt} />
                Oferta
              </legend>
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
                  <MoneyInput
                    className={s.arcField}
                    label="Preço"
                    value={priceCents}
                    onValueChange={(v) => set("price", v === null ? "" : centsToInput(v))}
                    currency="BRL"
                    currencies={["BRL"]}
                    quickAdd={[]}
                    locale="pt-BR"
                  />
                </div>
                <div className={s.formGrid}>
                  {productList({ group: "main", firstLabel: "Produto entregue", lineLabel: (n) => `Produto ${n}` })}
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
              <legend className={s.sectionLegend}>
                <Art name="pagos" size={24} className={s.cardArt} />
                Pagamento
              </legend>
              <div className={s.stack}>
                <div className={s.grid2}>
                  <label className={s.payTile}>
                    <span className={s.payIcon} aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20">
                        <path fill={PIX_BRAND.hex} d={PIX_BRAND.path} />
                      </svg>
                    </span>
                    <span className={s.payText}>
                      Pix
                      <small>{f.pixMode === "asaas" ? "Liberado sozinho pelo Asaas" : "Você confere e libera"}</small>
                    </span>
                    <input type="checkbox" checked={f.pix} onChange={(e) => set("pix", e.target.checked)} />
                  </label>
                  <label className={s.payTile} data-disabled={cardBox.disabled ? "true" : undefined}>
                    <span className={s.payIcon} aria-hidden="true">
                      <CreditCard size={20} strokeWidth={1.8} />
                    </span>
                    <span className={s.payText}>
                      Cartão de crédito
                      <small>Visa, Mastercard, Elo · até 12x</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={f.card}
                      onChange={(e) => set("card", e.target.checked)}
                      disabled={cardBox.disabled}
                      aria-describedby={cardBox.notice ? "cartao-indisponivel" : undefined}
                    />
                  </label>
                </div>
                {cardBox.notice ? (
                  <p id="cartao-indisponivel" className={s.payNote} role="note">
                    <Info size={14} strokeWidth={2} aria-hidden="true" />
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
                  <Select
                    className={s.arcField}
                    label="Parcelas máximas no cartão"
                    description="Parcela mínima do Asaas: R$ 5,00."
                    value={String(f.maxInstallments)}
                    onValueChange={(v) => set("maxInstallments", Number(v))}
                    disabled={ro || !f.card}
                    options={Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({
                      value: String(n),
                      label: n === 1 ? "1x (à vista)" : `até ${n}x`,
                    }))}
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className={s.card} disabled={ro} style={{ margin: 0 }}>
              <div className={s.cardHead} style={{ marginBottom: 4 }}>
                <legend className={s.sectionLegend}>
                  <Art name="receita" size={24} className={s.cardArt} />
                  Order bump
                </legend>
                <label className={s.switch}>
                  <span className={s.srOnly}>Oferecer order bump</span>
                  <input
                    type="checkbox"
                    checked={f.bumpOn}
                    onChange={(e) => {
                      const on = e.target.checked;
                      // Ao ligar, linhas vazias ou repetidas ganham produtos livres, sem repetir entre si.
                      const filled = fillBumpLines(productIds, bumpProductIds, available);
                      setF((x) => ({ ...x, bumpOn: on, bumpLines: on ? x.bumpLines.map((l, i) => ({ ...l, id: filled[i]! })) : x.bumpLines }));
                    }}
                  />
                </label>
              </div>
              <p className={s.cardSub} style={{ margin: "0 0 16px" }}>
                Uma caixa extra antes do botão de pagar. Sempre começa desmarcada.
              </p>
              {f.bumpOn ? (
                <div className={s.stack}>
                  {productList({
                    group: "bumpLines",
                    firstLabel: "Produto do bump",
                    lineLabel: (n) => `Produto ${n} do bump`,
                    addLabel: "Adicionar produto ao bump",
                  })}
                  <div className={s.grid2}>
                    <MoneyInput
                      className={s.arcField}
                      label="Preço do acréscimo"
                      value={parseBrl(f.bumpPrice)}
                      onValueChange={(v) => set("bumpPrice", v === null ? "" : centsToInput(v))}
                      currency="BRL"
                      currencies={["BRL"]}
                      quickAdd={[]}
                      locale="pt-BR"
                      description={priceCents && bumpCents ? `Total com bump: ${brl(priceCents + bumpCents)}` : undefined}
                    />
                    <div className={s.field}>
                      <label className={s.field}>
                        <span className={s.label}>Título da caixa</span>
                        <input
                          className={s.input}
                          value={f.bumpLabel}
                          maxLength={200}
                          placeholder={bumpProductIds.length > 1 ? "5 Kits Extras" : "Quero a versão completa"}
                          aria-required={bumpProductIds.length > 1}
                          aria-describedby="titulo-caixa-dica"
                          onChange={(e) => set("bumpLabel", e.target.value)}
                        />
                      </label>
                      <span id="titulo-caixa-dica" className={s.hint}>
                        {bumpProductIds.length > 1 ? "Obrigatório com mais de um produto. " : ""}Quem marca recebe tudo no mesmo e-mail.
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
            </fieldset>

            <fieldset className={s.card} disabled={ro} style={{ margin: 0 }}>
              <legend className={s.sectionLegend}>
                <Art name="funil" size={24} className={s.cardArt} />
                Página de obrigado
              </legend>
              <label className={s.field}>
                <span className={s.label}>Mensagem exibida depois do pagamento confirmado</span>
                <textarea className={s.textarea} value={f.thankYouText} maxLength={2000} onChange={(e) => set("thankYouText", e.target.value)} />
              </label>
            </fieldset>
            <button type="submit" hidden />
          </form>
          {offer ? (
            <section className={s.card} aria-labelledby="pixel-titulo">
              <div className={s.cardHead}>
                <h2 id="pixel-titulo">
                  <Art name="origem" size={24} className={s.cardArt} />
                  Pixel próprio
                </h2>
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
          {canWrite ? (
            <div className={s.saveBar} data-dirty={dirty ? "true" : undefined}>
              <span className={s.saveState}>{offer ? (dirty ? "Alterações não salvas" : "Tudo salvo") : "Oferta nova"}</span>
              <div className={s.headActions}>
                {offer && dirty ? (
                  <button type="button" className={s.btn} onClick={discard} disabled={save.pending}>
                    Descartar
                  </button>
                ) : null}
                <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={submit} disabled={save.pending}>
                  {save.pending ? "Salvando…" : offer ? "Salvar" : "Criar oferta"}
                </button>
              </div>
            </div>
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
                Produtos entregues: {namesOf(offer.productIds)} → <b>{namesOf(productIds)}</b>
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
