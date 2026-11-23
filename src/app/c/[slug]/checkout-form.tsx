"use client";

// Formulário do checkout (frames 01–04 e 08 do canvas Doop). Valida no navegador o mesmo que o servidor valida
// (src/lib/validation/br.ts) e chama:
//   - Pix: server action `startCheckoutAction` -> página do pedido;
//   - Cartão: não há campo de cartão nem de titular aqui. O bloco do cartão é o iframe do serviço isolado
//     (`cardFrame`, card-frame.ts) e o "Pagar" valida os dados pessoais, o iframe, cria o pedido e manda `pay`.
// Os dados do cartão nunca passam por este componente.
// Envio nativo (sem JS, ou antes de hidratar) não vaza nada: nenhum campo tem `name` (só o rádio do método), o form é
// `method="post"` para a própria página sem query, e o botão fica desabilitado até o componente hidratar.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { fieldsMessage } from "@/lib/card-frame/protocol";
import type { CheckoutMethod as Method, CheckoutOffer } from "@/lib/catalog/checkout-offer";
import { brl } from "@/lib/format";
import { normalizeBrMobile, onlyDigits, validCpf, validEmail } from "@/lib/validation/br";
import s from "../../(design)/buyer.module.css";
import { Icon, type IconName } from "../../(design)/icons";
import { TrustSeals } from "../../(design)/shell";
import { forgetLeadAction, previewCouponAction, recordCheckoutViewAction, renewCardTicketAction, saveLeadAction, startCheckoutAction, type StartResult } from "./actions";
import {
  FRAME_UNAVAILABLE_MESSAGE,
  createCardFrameController,
  createSubmitGate,
  frameFieldNames,
  newFrameMsgId,
  payWithFrame,
  type CardFrameController,
  type CardOrder,
  type FrameConfig,
  type FrameStatus,
} from "./card-frame";
import {
  afterStartFailure,
  applyCoupon,
  closeCoupon,
  couponLine,
  displayTotal,
  initialCouponState,
  openCoupon,
  refreshCoupon,
  submitCoupon,
  type CouponState,
  type PreviewFn,
} from "./coupon-logic";
import { forgetLeadInput, nextLeadSend, readLeadOptOut, writeLeadOptOut } from "./lead-capture";
import { checkoutTracking } from "./tracking";

type Touch = { first: Record<string, string> | null; last: Record<string, string> | null };

type FieldKey = "name" | "email" | "phone" | "cpf";

const FIELD_ORDER: FieldKey[] = ["name", "email", "phone", "cpf"];

// ---- máscaras ----
const maskPhone = (v: string) => {
  const d = onlyDigits(v).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};
const maskCpf = (v: string) => {
  const d = onlyDigits(v).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, "$1.$2").replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
};
/** Caminho de erro do servidor (zod do checkout) -> campo do formulário. */
function fieldFromPath(path: string): FieldKey | null {
  const map: Record<string, FieldKey> = {
    "customer.name": "name",
    "customer.email": "email",
    "customer.phone": "phone",
    "customer.cpf": "cpf",
  };
  return map[path] ?? null;
}

// ---- peças visuais ----
function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  error?: string;
  hint?: string;
  inputMode?: "text" | "email" | "tel" | "numeric";
  autoComplete?: string;
  placeholder?: string;
  mono?: boolean;
  maxLength?: number;
}) {
  const { id, label, value, onChange, onBlur, onKeyDown, error, hint, inputMode, autoComplete, placeholder, maxLength } = props;
  const msg = error ?? hint;
  return (
    <div className={s.field} data-invalid={error ? "true" : undefined}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      <div className={s.box}>
        <input
          id={id}
          className={s.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          inputMode={inputMode}
          autoComplete={autoComplete}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={msg ? `${id}-msg` : undefined}
        />
        <Icon name="circle-alert" className={s.errIcon} />
      </div>
      {msg ? (
        <p id={`${id}-msg`} className={s.hint}>
          {msg}
        </p>
      ) : null}
    </div>
  );
}

function MethodOption({ value, current, onSelect, icon, title, sub }: { value: Method; current: Method; onSelect: (m: Method) => void; icon: IconName; title: string; sub: string }) {
  const selected = value === current;
  return (
    <label className={s.method} data-selected={selected ? "true" : undefined}>
      <input type="radio" name="method" value={value} checked={selected} onChange={() => onSelect(value)} className={s.srOnly} />
      <span className={s.radio} aria-hidden="true" />
      <Icon name={icon} size={22} className={s.methodIcon} />
      <span className={s.methodText}>
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </label>
  );
}

function ProductCover({ small }: { small?: boolean }) {
  return (
    <div className={`${s.cover} ${small ? s.coverSm : ""}`} aria-hidden="true">
      <Icon name="book-open" size={20} />
      <span className={s.coverTag}>PDF</span>
    </div>
  );
}

// ---- Turnstile (só quando o servidor pede; aqui no checkout, nunca dentro do iframe do cartão) ----
declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void }) => void };
  }
}
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const render = () => window.turnstile?.render(el, { sitekey: siteKey, callback: onToken });
    if (window.turnstile) return void render();
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [siteKey, onToken]);
  return <div ref={ref} className={s.turnstile} />;
}

// ---- formulário ----
const noop = () => () => {};
/** `false` no HTML do servidor e antes de hidratar; `true` depois (sem setState em efeito). */
const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);

export function CheckoutForm(props: {
  storeName: string;
  offer: CheckoutOffer;
  initialMethod: Method;
  touch: Touch;
  /** Cupom da URL (`?cupom=`) já conferido no servidor; `null` = recolhido. */
  initialCoupon: CouponState | null;
  refCode?: string;
  eventId: string;
  /** Captura do contato ligada na loja: chave desta visita e e-mail de privacidade do aviso; `null` = desligada. */
  lead: { key: string; privacyEmail: string } | null;
  turnstileSiteKey: string | null;
  /** Cor da loja (#RRGGBB): vai no `config` do iframe do cartão, que a aplica nos campos dele. */
  brandColor: string | null;
  /** Iframe do cartão (`${CARD_ORIGIN}/form/${storeId}`); `null` = sem cartão (a oferta não tem, ou falta o serviço). */
  cardFrame: { origin: string; src: string } | null;
}) {
  const { offer, storeName, touch, refCode, eventId, lead, turnstileSiteKey, cardFrame } = props;
  const router = useRouter();
  const hydrated = useHydrated();
  const [method, setMethod] = useState<Method>(props.initialMethod);
  const [withBump, setWithBump] = useState(false);
  // Cupom (D7): estado e regras em coupon-logic.ts. `couponBusy` trava o envio enquanto a prévia está no ar; `couponSeq`
  // descarta resposta de prévia que chegou depois de outra mais nova (bump marcado e desmarcado em sequência).
  const [coupon, setCoupon] = useState<CouponState>(() => initialCouponState(props.initialCoupon));
  const [couponText, setCouponText] = useState(() => (props.initialCoupon && props.initialCoupon.kind !== "closed" ? props.initialCoupon.code : ""));
  const [couponBusy, setCouponBusy] = useState(false);
  const couponSeq = useRef(0);
  const [v, setV] = useState({ name: "", email: "", phone: "", cpf: "" });
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [needsCpf, setNeedsCpf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState<{ last4: string } | null>(null);
  const [captcha, setCaptcha] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  // Remonta o widget depois de usar o token (ele vale uma vez): o próximo captcha pede um desafio novo.
  const [turnstileKey, setTurnstileKey] = useState(0);
  const viewed = useRef(false);
  // Captura do contato: o que já foi enviado, se a pessoa pediu para não salvar e uma fila para as chamadas irem em
  // ordem (um "Não salvar" nunca é ultrapassado por uma gravação que ainda estava no ar).
  const leadSent = useRef<{ email: string | null; phone: string | null }>({ email: null, phone: null });
  const leadQueue = useRef<Promise<void>>(Promise.resolve());
  const [optedOutNow, setOptedOut] = useState(false);
  // "Não salvar" de uma visita anterior neste navegador (localStorage). No servidor e na hidratação vale `false`; a
  // leitura do navegador entra logo depois, sem divergir do HTML do servidor.
  const optedOutBefore = useSyncExternalStore(noop, () => readLeadOptOut(), () => false);
  const optedOut = optedOutNow || optedOutBefore;
  const [leadMore, setLeadMore] = useState(false);
  // Pedido de cartão com o bilhete atual (nova tentativa reaproveita o pedido); iframe (remontado ao trocar
  // `frameKey`) e o seu estado.
  const cardOrder = useRef<CardOrder | null>(null);
  const frameCtrl = useRef<CardFrameController | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [frameStatus, setFrameStatus] = useState<FrameStatus>("loading");
  // Sem iframe (oferta só de cartão numa instalação sem o serviço de cartão): o cartão aparece indisponível.
  const frameState: FrameStatus = cardFrame ? frameStatus : "unavailable";
  // Enter num campo do iframe (`submit`): o mesmo que o botão "Pagar". Atualizado a cada render (ver o efeito abaixo).
  const submitFromFrame = useRef<() => void>(() => {});
  // Um "Pagar" por vez, mesmo antes de o `busy` chegar ao render (Enter no iframe + clique juntos).
  const [submitGate] = useState(createSubmitGate);

  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    void recordCheckoutViewAction({ slug: offer.slug, touch });
  }, [offer.slug, touch]);

  function captureLead(field: "email" | "phone") {
    if (!lead) return;
    const send = nextLeadSend({ optedOut, sent: leadSent.current }, field, { email: v.email, phone: v.phone });
    if (!send) return;
    leadSent.current = { email: send.email ?? leadSent.current.email, phone: send.phone ?? leadSent.current.phone };
    leadQueue.current = leadQueue.current.then(() => saveLeadAction({ slug: offer.slug, leadKey: lead.key, ...send })).catch(() => {});
  }

  // Sempre chama o servidor (mesmo sem nada enviado nesta visita): com o e-mail digitado, apaga também o contato aberto
  // de uma visita anterior. Na fila: nunca ultrapassado por uma gravação ainda no ar.
  function optOutOfLead() {
    if (!lead) return;
    setOptedOut(true);
    setLeadMore(false);
    writeLeadOptOut();
    const input = forgetLeadInput(lead.key, v.email);
    leadQueue.current = leadQueue.current.then(() => forgetLeadAction(input)).catch(() => {});
  }

  const bumpCents = offer.bump?.priceCents ?? null;
  const total = displayTotal({ priceCents: offer.priceCents, bumpCents }, coupon, withBump);
  const line = couponLine(coupon);
  const preview: PreviewFn = (code, wb) => previewCouponAction({ slug: offer.slug, code, withBump: wb });

  /** Roda uma troca de estado do cupom; só a mais recente vale. */
  function runCoupon(next: Promise<CouponState>) {
    const id = ++couponSeq.current;
    setCouponBusy(true);
    void next.then((st) => {
      if (id !== couponSeq.current) return;
      setCoupon(st);
      if (st.kind === "open") setCouponText(st.code);
      setCouponBusy(false);
    });
  }
  function onApplyCoupon() {
    runCoupon(applyCoupon(preview, couponText, withBump));
  }
  function onRemoveCoupon() {
    couponSeq.current++;
    setCouponBusy(false);
    setCouponText("");
    setCoupon(closeCoupon());
  }
  function onToggleBump(checked: boolean) {
    setWithBump(checked);
    if (coupon.kind === "applied") runCoupon(refreshCoupon(preview, coupon, checked));
  }
  const brandColor = props.brandColor ?? undefined;
  const frameConfig = useRef<FrameConfig>({ totalCents: total, maxInstallments: offer.maxInstallments, brandColor });
  useEffect(() => {
    // Total novo (bump ligado ou desligado): o seletor de parcelas do iframe mostra o valor certo.
    frameConfig.current = { totalCents: total, maxInstallments: offer.maxInstallments, brandColor };
    frameCtrl.current?.setConfig(frameConfig.current);
  }, [total, offer.maxInstallments, brandColor]);

  // O iframe é criado aqui (não no JSX) para o listener existir ANTES de ele carregar: o `ready` sai assim que carrega.
  // Ref com limpeza (React 19): desmontar o bloco (ou trocar `frameKey`) tira o listener e o iframe.
  const frameOrigin = cardFrame?.origin;
  const frameSrc = cardFrame?.src;
  const frameBox = useCallback(
    (box: HTMLDivElement | null) => {
      if (!box || !frameOrigin || !frameSrc) return;
      const iframe = document.createElement("iframe");
      const ctrl = createCardFrameController({
        origin: frameOrigin,
        getWindow: () => iframe.contentWindow,
        post: (msg) => iframe.contentWindow?.postMessage(msg, frameOrigin),
        setTimer: (fn, ms) => {
          const t = window.setTimeout(fn, ms);
          return () => window.clearTimeout(t);
        },
        newId: newFrameMsgId,
        onStatus: setFrameStatus,
        onHeight: (px) => {
          iframe.style.height = `${px}px`;
        },
        onSubmit: () => submitFromFrame.current(),
      });
      const onMessage = (ev: MessageEvent) => ctrl.handle(ev);
      window.addEventListener("message", onMessage);
      frameCtrl.current = ctrl;
      setFrameStatus("loading");
      ctrl.setConfig(frameConfig.current);
      iframe.title = "Dados do cartão";
      iframe.className = s.cardFrame;
      iframe.src = frameSrc;
      box.appendChild(iframe);
      ctrl.start();
      return () => {
        window.removeEventListener("message", onMessage);
        ctrl.dispose();
        iframe.remove();
        if (frameCtrl.current === ctrl) frameCtrl.current = null;
      };
    },
    // `frameKey`: "Tentar outro cartão" remonta o iframe (formulário limpo). Hoje a tela de recusa já desmonta o
    // formulário (e o iframe com ele); a chave garante a remontagem se isso mudar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameOrigin, frameSrc, frameKey],
  );
  const asaasPix = offer.pixMode === "asaas";
  const showCpf = method === "card" || (method === "pix" && (asaasPix || needsCpf));
  const set = (k: FieldKey, mask?: (x: string) => string) => (x: string) => {
    setV((cur) => ({ ...cur, [k]: mask ? mask(x) : x }));
    if (errors[k]) setErrors((cur) => ({ ...cur, [k]: undefined }));
  };

  function validate(m: Method): Partial<Record<FieldKey, string>> {
    const e: Partial<Record<FieldKey, string>> = {};
    if (v.name.trim().length < 2) e.name = "Informe seu nome completo.";
    if (!validEmail(v.email)) e.email = "Confira o e-mail.";
    if (!normalizeBrMobile(v.phone)) e.phone = "Informe um celular com DDD, ex.: (11) 98765-4321.";
    const needCpf = m === "card" || asaasPix || needsCpf;
    if (needCpf) {
      if (!onlyDigits(v.cpf)) e.cpf = "Informe o CPF.";
      else if (!validCpf(onlyDigits(v.cpf))) e.cpf = "CPF inválido. Confira os 11 números.";
    }
    return e;
  }

  function showErrors(e: Partial<Record<FieldKey, string>>, message?: string) {
    setErrors(e);
    const keys = FIELD_ORDER.filter((k) => e[k]);
    const n = keys.length;
    setFormError(message ?? fieldsMessage(n));
    if (keys[0]) document.getElementById(keys[0])?.focus();
  }

  /** Assinatura dos dados pessoais e do bump: muda -> pedido novo (nova tentativa de cartão reaproveita o pedido). */
  const orderSig = () => JSON.stringify([v.name.trim(), v.email.trim().toLowerCase(), onlyDigits(v.phone), onlyDigits(v.cpf), withBump, coupon.kind === "applied" ? coupon.code : null, total]);

  const customerPayload = (m: Method) => ({
    name: v.name.trim(),
    email: v.email.trim(),
    phone: v.phone,
    ...(m === "card" || asaasPix || needsCpf ? { cpf: onlyDigits(v.cpf) } : {}),
  });

  function handleStartError(r: Extract<StartResult, { ok: false }>) {
    if (r.priceChanged || r.fields?.couponCode !== undefined) {
      // Valor ou cupom divergente: refaz a prévia e mostra o resumo novo. Nunca reenvia sozinho.
      const id = ++couponSeq.current;
      setCouponBusy(true);
      void afterStartFailure(preview, coupon, withBump, r).then((out) => {
        if (id !== couponSeq.current) return;
        setCoupon(out.coupon);
        if (out.coupon.kind === "open") setCouponText(out.coupon.code);
        setFormError(out.message);
        setCouponBusy(false);
      });
      if (r.priceChanged || Object.keys(r.fields ?? {}).every((k) => k === "couponCode")) return;
    }
    if (r.needsCpf) {
      setNeedsCpf(true);
      setErrors({ cpf: "Informe o CPF para continuar." });
      setFormError(r.message);
      return;
    }
    const e: Partial<Record<FieldKey, string>> = {};
    for (const [path, msg] of Object.entries(r.fields ?? {})) {
      const k = fieldFromPath(path);
      if (k) e[k] = msg;
    }
    if (Object.keys(e).length > 0) showErrors(e, r.message === "Confira os campos marcados." ? undefined : r.message);
    else setFormError(r.message);
  }

  async function payPix() {
    checkoutTracking.onAddPaymentInfo("pix", total);
    const r = await startCheckoutAction({ slug: offer.slug, withBump, method: "pix", customer: customerPayload("pix"), ...submitCoupon(coupon, total), touch, ref: refCode, eventId, ...(lead ? { leadKey: lead.key } : {}) });
    if (r.ok) {
      router.push(`/o/${r.publicId}`);
      return;
    }
    handleStartError(r);
    setBusy(false);
  }

  /** Cartão: pedido (novo ou reaproveitado) + `pay` ao iframe; dados do cartão nunca passam por aqui. */
  async function payCardInFrame() {
    const ctrl = frameCtrl.current;
    if (!ctrl) {
      setFormError(FRAME_UNAVAILABLE_MESSAGE);
      setBusy(false);
      return;
    }
    checkoutTracking.onAddPaymentInfo("card", total);
    const sig = orderSig();
    const buyerCpf = onlyDigits(v.cpf);
    // Token do Turnstile resolvido aqui no checkout (depois de um `captcha`): vai no `pay`, e o iframe o repassa.
    const sentToken = turnstileToken;
    const { outcome, order: next } = await payWithFrame({
      order: cardOrder.current,
      sig,
      ...(sentToken ? { turnstileToken: sentToken } : {}),
      now: () => Date.now(),
      start: () => startCheckoutAction({ slug: offer.slug, withBump, method: "card", customer: customerPayload("card"), ...submitCoupon(coupon, total), touch, ref: refCode, eventId, ...(lead ? { leadKey: lead.key } : {}) }),
      renew: (o) => renewCardTicketAction(o),
      pay: (a) => ctrl.pay({ ...a, buyerCpf }),
    });
    cardOrder.current = next;
    if (sentToken && outcome.kind !== "start_error") {
      setTurnstileToken(undefined);
      setTurnstileKey((k) => k + 1);
    }
    setCaptcha(outcome.kind === "failed" && outcome.captcha === true);
    if (outcome.kind === "go") {
      router.push(`/o/${outcome.publicId}`);
      return;
    }
    setBusy(false);
    if (outcome.kind === "start_error") return handleStartError(outcome.result);
    if (outcome.kind === "declined") {
      setDeclined({ last4: outcome.last4 });
      window.scrollTo({ top: 0 });
      return;
    }
    if (outcome.marks.length > 0) {
      // Campos do comprador recusados pelo servidor, com as mensagens do fluxo de hoje.
      const e: Partial<Record<FieldKey, string>> = {};
      for (const k of outcome.marks) e[k] = k === "phone" ? "Confira o número de WhatsApp." : "Confira este campo.";
      setErrors(e);
      const first = FIELD_ORDER.find((k) => e[k]);
      if (first) document.getElementById(first)?.focus();
    }
    setFormError(outcome.message);
  }

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    void submitGate.run(submit);
  }

  /** O "Pagar" (botão, Enter num campo do checkout ou Enter num campo do iframe do cartão). */
  async function submit() {
    if (busy || couponBusy) return;
    const e = validate(method);
    if (method === "card") {
      const ctrl = frameCtrl.current;
      // Indisponível: o aviso já está no bloco do cartão (sem repetir no topo); nenhum pedido é criado.
      if (!ctrl || frameState !== "ready") return setFormError(frameState === "unavailable" ? null : FRAME_UNAVAILABLE_MESSAGE);
      // Dados pessoais aqui e os do cartão no iframe (que marca os dele); a contagem soma os dois.
      setBusy(true);
      const checked = await ctrl.validate().catch(() => null);
      if (!checked) {
        setBusy(false);
        return setFormError(FRAME_UNAVAILABLE_MESSAGE);
      }
      const n = Object.keys(e).length + (checked.ok ? 0 : Math.max(1, frameFieldNames(checked.fields).length));
      if (n > 0) {
        setBusy(false);
        return showErrors(e, fieldsMessage(n));
      }
    } else if (Object.keys(e).length > 0) return showErrors(e);
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await (method === "pix" ? payPix() : payCardInFrame());
    } catch {
      setFormError("Não foi possível continuar agora. Tente de novo em instantes.");
      setBusy(false);
    }
  }

  // Só com o cartão escolhido (o iframe fica escondido no Pix); `submit` confere o resto (ocupado, iframe pronto).
  useEffect(() => {
    submitFromFrame.current = () => {
      if (method === "card") void submitGate.run(submit);
    };
  });

  if (declined) {
    return (
      <Declined
        last4={declined.last4}
        total={total}
        pixAvailable={offer.methods.includes("pix")}
        busy={busy}
        onPix={() => {
          setDeclined(null);
          setMethod("pix");
          if (asaasPix) return; // Pix do Asaas pede CPF (já preenchido): o comprador confirma no formulário.
          setBusy(true);
          void payPix().catch(() => setBusy(false));
        }}
        onRetry={() => {
          setDeclined(null);
          setFrameKey((k) => k + 1);
        }}
      />
    );
  }

  const pixSub = asaasPix ? "Liberado na hora" : "Direto para a loja";
  const cardSub = offer.maxInstallments > 1 ? `Em até ${offer.maxInstallments}x` : "Crédito";
  const buttonLabel = busy ? (method === "pix" ? "Gerando Pix…" : "Processando pagamento…") : method === "pix" ? `Gerar Pix de ${brl(total)}` : `Pagar ${brl(total)}`;

  const productRow = (small?: boolean): ReactNode => (
    <>
      <ProductCover small={small} />
      <div className={s.productText}>
        <p className={`${s.p0} ${s.muted} ${s.small}`}>Você está comprando</p>
        <p className={s.productTitle}>{offer.name}</p>
        <p className={s.productSub}>{offer.includes ?? `${offer.productName} · PDF para baixar`}</p>
      </div>
      <p className={`${s.productPrice} ${s.money}`}>{brl(offer.priceCents)}</p>
    </>
  );

  return (
    <main>
      <form className={`${s.main} ${s.checkoutMain}`} method="post" action={`/c/${encodeURIComponent(offer.slug)}`} onSubmit={onSubmit} noValidate>
        <div className={s.intro}>
          <p className={`${s.p0} ${s.muted} ${s.small}`}>Finalize sua compra</p>
          <h1 className={s.introTitle}>{offer.name}</h1>
        </div>

        <section className={`${s.product} ${s.productMobile}`} aria-label="Produto">
          {productRow()}
        </section>

        <div className={s.colMain}>
          <section className={s.card}>
            <h2 className={s.sec}>Seus dados</h2>
            <div className={s.stack}>
              <Field id="name" label="Nome completo" value={v.name} onChange={set("name")} error={errors.name} autoComplete="name" maxLength={120} />
              <Field
                id="email"
                label="E-mail"
                value={v.email}
                onChange={set("email")}
                onBlur={() => captureLead("email")}
                error={errors.email}
                hint="É para este e-mail que enviamos o seu acesso."
                inputMode="email"
                autoComplete="email"
                maxLength={254}
              />
              {lead ? (
                <div className={s.leadNotice} data-done={optedOut ? "true" : undefined}>
                  {optedOut ? (
                    <p role="status">Pronto: seus dados não serão guardados antes da compra.</p>
                  ) : (
                    <>
                      <p>
                        A {storeName} guarda seu e-mail e celular por até 30 dias para falar com você se a compra não for concluída.
                      </p>
                      <p className={s.leadActions}>
                        {/* Sem roubar o foco no clique: o blur do e-mail não grava o contato antes do opt-out. */}
                        <button type="button" className={s.leadLink} onMouseDown={(e) => e.preventDefault()} onClick={optOutOfLead}>
                          Não salvar meus dados
                        </button>
                        <span aria-hidden="true"> · </span>
                        <button type="button" className={s.leadLink} aria-expanded={leadMore} aria-controls="lead-more" onClick={() => setLeadMore((x) => !x)}>
                          Saiba mais
                        </button>
                      </p>
                      {leadMore ? (
                        <p id="lead-more" className={s.leadMore}>
                          <b>Quem trata:</b> {storeName}. <b>Para quê:</b> só para lembrar você desta compra; seus dados não são vendidos nem compartilhados.{" "}
                          <b>Base legal:</b> legítimo interesse (LGPD, art. 7º, IX). <b>Por quanto tempo:</b> até 30 dias; se você concluir a compra, valem os
                          dados do pedido e este registro perde o contato na hora. <b>Seus direitos:</b> peça acesso ou exclusão a qualquer momento por{" "}
                          <a href={`mailto:${encodeURIComponent(lead.privacyEmail)}`}>{lead.privacyEmail}</a>, ou toque em &quot;Não salvar meus dados&quot;.
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
              <Field
                id="phone"
                label="WhatsApp"
                value={v.phone}
                onChange={set("phone", maskPhone)}
                onBlur={() => captureLead("phone")}
                error={errors.phone}
                hint="Só para avisos sobre este pedido."
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="(11) 98765-4321"
              />
            </div>
          </section>

          <section className={s.card}>
            <h2 className={s.sec}>Como você quer pagar?</h2>
            <div className={s.methods} role="radiogroup" aria-label="Forma de pagamento" data-count={offer.methods.length}>
              {offer.methods.includes("pix") ? <MethodOption value="pix" current={method} onSelect={setMethod} icon="pix" title="Pix" sub={pixSub} /> : null}
              {offer.methods.includes("card") ? <MethodOption value="card" current={method} onSelect={setMethod} icon="credit-card" title="Cartão" sub={cardSub} /> : null}
            </div>

            {formError ? (
              <p className={s.alert} role="alert">
                <Icon name="circle-alert" />
                <span>{formError}</span>
              </p>
            ) : null}

            {showCpf ? (
              <div className={s.stack} style={{ marginTop: 14 }}>
                <Field
                  id="cpf"
                  label="CPF"
                  value={v.cpf}
                  onChange={set("cpf", maskCpf)}
                  error={errors.cpf}
                  hint={method === "card" ? "Exigido para pagar com cartão." : "Exigido pelo Pix para gerar a cobrança no seu nome."}
                  inputMode="numeric"
                  placeholder="000.000.000-00"
                />
              </div>
            ) : null}

            {method === "pix" ? (
              <p className={s.note}>
                <Icon name={asaasPix || needsCpf ? "qr-code" : "info"} />
                {asaasPix || needsCpf ? (
                  <span>
                    Na próxima tela aparecem o QR Code e o código <b>copia e cola</b>. Assim que o banco confirmar, o acesso chega no seu e-mail.
                  </span>
                ) : (
                  <span>
                    O Pix vai direto para a {storeName}. O valor terá <b>alguns centavos diferentes</b> para identificar o seu pedido. O acesso é
                    enviado depois que a loja confirmar o pagamento.
                  </span>
                )}
              </p>
            ) : null}

            {cardFrame ? (
              // Carregando: esqueleto do tamanho aproximado do bloco (CSS), sem texto; `aria-busy` até o `ready`.
              <div ref={frameBox} className={s.cardFrameBox} aria-busy={frameState === "loading"} hidden={method !== "card" || frameState === "unavailable"} />
            ) : null}
            {/* Com o iframe, a nota "Os dados do cartão não ficam salvos." vem dentro dele. */}
            {method === "card" && frameState !== "unavailable" && captcha && turnstileSiteKey ? (
              <Turnstile key={turnstileKey} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
            ) : null}
            {method === "card" && frameState === "unavailable" ? (
              <p className={s.alert} role="alert">
                <Icon name="circle-alert" />
                <span>{FRAME_UNAVAILABLE_MESSAGE}</span>
              </p>
            ) : null}

          </section>
        </div>

        <aside className={s.aside}>
          <div className={s.asideCard}>
            <div className={s.productInAside}>{productRow(true)}</div>
            {offer.bump ? (
              <label className={s.bump} data-checked={withBump ? "true" : undefined}>
                <input type="checkbox" className={s.srOnly} checked={withBump} onChange={(e) => onToggleBump(e.target.checked)} />
                <span className={s.bumpTop}>
                  <span className={s.bumpBox} aria-hidden="true">
                    <Icon name="check" size={16} />
                  </span>
                  <span className={s.bumpTitle}>{offer.bump.label?.trim() || `Adicionar ${offer.bump.productName}`}</span>
                  <span className={`${s.bumpPrice} ${s.money}`}>+ {brl(offer.bump.priceCents)}</span>
                </span>
                <span className={s.bumpText}>
                  {offer.bump.contents ? `Leve também: ${offer.bump.contents}.` : `Leve também ${offer.bump.productName}.`} Tudo chega junto no seu e-mail.
                </span>
              </label>
            ) : null}
            <div className={s.coupon}>
              {coupon.kind === "closed" ? (
                <button type="button" className={s.leadLink} style={{ alignSelf: "flex-start" }} onClick={() => setCoupon(openCoupon(coupon))}>
                  Tenho um cupom
                </button>
              ) : null}
              {coupon.kind === "open" ? (
                <div className={s.couponRow}>
                  <Field
                    id="coupon"
                    label="Cupom"
                    value={couponText}
                    onChange={(x) => {
                      setCouponText(x);
                      if (coupon.message) setCoupon({ ...coupon, message: null });
                    }}
                    onKeyDown={(e) => {
                      // Enter no cupom aplica o cupom; nunca envia o pedido.
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (!couponBusy) onApplyCoupon();
                    }}
                    error={coupon.message ?? undefined}
                    autoComplete="off"
                    maxLength={64}
                  />
                  <button type="button" className={`${s.btn} ${s.btnSecondary} ${s.couponApply}`} onClick={onApplyCoupon} disabled={couponBusy || !hydrated}>
                    {couponBusy ? "Conferindo…" : "Aplicar"}
                  </button>
                </div>
              ) : null}
              {coupon.kind === "applied" ? (
                <div className={s.couponApplied} role="status">
                  <span>Cupom {coupon.code} aplicado</span>
                  <button type="button" className={s.leadLink} onClick={onRemoveCoupon} disabled={couponBusy}>
                    Remover
                  </button>
                </div>
              ) : null}
            </div>
            <section className={s.totals} aria-label="Total">
              <div className={s.line}>
                <span>{offer.productName}</span>
                <span className={s.money}>{brl(offer.priceCents)}</span>
              </div>
              {withBump && offer.bump ? (
                <div className={s.line}>
                  <span>{offer.bump.productName} (acréscimo)</span>
                  <span className={s.money}>{brl(offer.bump.priceCents)}</span>
                </div>
              ) : null}
              {line ? (
                <div className={`${s.line} ${s.lineCoupon}`}>
                  <span>Cupom {line.code}</span>
                  <span className={s.money}>−{brl(line.discountCents)}</span>
                </div>
              ) : null}
              <div className={s.divider} />
              <div className={s.totalRow}>
                <span className={s.totalLabel}>Total</span>
                <span className={`${s.totalValue} ${s.money}`} data-testid="total">
                  {brl(total)}
                </span>
              </div>
              <button type="submit" className={`${s.btn} ${s.btnLg} ${s.btnFull}`} disabled={busy || couponBusy || !hydrated || (method === "card" && frameState !== "ready")}>
                <Icon name={method === "pix" ? "pix" : "lock"} size={20} />
                {buttonLabel}
              </button>
            </section>
          </div>
          <TrustSeals />
        </aside>
      </form>
    </main>
  );
}

function Declined(props: { last4: string; total: number; pixAvailable: boolean; busy: boolean; onPix: () => void; onRetry: () => void }) {
  return (
    <main className={`${s.main} ${s.mainCenter}`}>
      <div className={s.hero}>
        <div className={s.heroIcon} data-tone="danger">
          <Icon name="credit-card" size={30} />
        </div>
        <h1 className={`${s.heroTitle} ${s.heroTitleSm}`}>Pagamento não aprovado</h1>
        <p className={s.heroText}>
          O banco recusou o cartão final <b>{props.last4}</b>. <b>Nenhum valor foi cobrado.</b>
        </p>
      </div>
      <section className={`${s.card} ${s.actions}`}>
        {props.pixAvailable ? (
          <button type="button" className={`${s.btn} ${s.btnLg} ${s.btnFull}`} onClick={props.onPix} disabled={props.busy}>
            <Icon name="pix" size={20} />
            Pagar {brl(props.total)} com Pix
          </button>
        ) : null}
        <button type="button" className={`${s.btn} ${s.btnLg} ${s.btnFull} ${s.btnSecondary}`} onClick={props.onRetry}>
          Tentar outro cartão
        </button>
        <p className={`${s.foot}`}>Seus dados continuam preenchidos.</p>
      </section>
      <section className={`${s.card} ${s.actions}`}>
        <h2 className={s.summaryTitle}>O que pode ter acontecido</h2>
        <p className={`${s.tip} ${s.p0}`}>
          <Icon name="wallet" />
          <span>Limite insuficiente ou cartão bloqueado para compras online.</span>
        </p>
        <p className={`${s.tip} ${s.p0}`}>
          <Icon name="smartphone" />
          <span>Alguns bancos pedem para liberar a compra no app. Confira as notificações.</span>
        </p>
      </section>
    </main>
  );
}
