"use client";

// Formulário do checkout (frames 01–04 e 08 do canvas Doop). Valida no navegador o mesmo que o servidor valida
// (src/lib/validation/br.ts) e chama:
//   - Pix: server action `startCheckoutAction` -> página do pedido;
//   - Cartão: `startCheckoutAction` (cria o pedido) + POST /api/checkout/card (mesma origem, JSON) com uma chave de
//     idempotência por tentativa (reaproveitada se a rede cair no meio da mesma tentativa).
// Dados do cartão só ficam no estado deste componente e no corpo do POST; nunca vão para a server action.
// Com CARD_ISOLATED=1 (`cardFrame`), não há campo de cartão nem de titular aqui: o bloco do cartão é o iframe do
// serviço isolado (card-frame.ts) e o "Pagar" valida os dados pessoais, o iframe, cria o pedido e manda `pay`.
// Envio nativo (sem JS, ou antes de hidratar) não vaza nada: nenhum campo tem `name` (só o rádio do método), o form é
// `method="post"` para a própria página sem query, e o botão fica desabilitado até o componente hidratar.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CARD_GENERIC_MESSAGE, fieldsMessage } from "@/lib/card-frame/protocol";
import { brl } from "@/lib/format";
import { cardExpiryValid, normalizeBrMobile, onlyDigits, validCpf, validEmail } from "@/lib/validation/br";
import s from "../../(design)/buyer.module.css";
import { Icon, type IconName } from "../../(design)/icons";
import { TrustSeals } from "../../(design)/shell";
import { recordCheckoutViewAction, renewCardTicketAction, startCheckoutAction, type StartResult } from "./actions";
import {
  FRAME_UNAVAILABLE_MESSAGE,
  createCardFrameController,
  frameFieldNames,
  newFrameMsgId,
  payWithFrame,
  type CardFrameController,
  type CardOrder,
  type FrameStatus,
} from "./card-frame";
import { checkoutTracking } from "./tracking";

type Method = "pix" | "card";
type Touch = { first: Record<string, string> | null; last: Record<string, string> | null };

export interface CheckoutOffer {
  slug: string;
  name: string;
  productName: string;
  priceCents: number;
  methods: Method[];
  pixMode: "manual" | "asaas";
  maxInstallments: number;
  bump: { productName: string; priceCents: number; label: string | null } | null;
}

type FieldKey =
  | "name"
  | "email"
  | "phone"
  | "cpf"
  | "holderCpf"
  | "cardNumber"
  | "holderName"
  | "expiry"
  | "cvv"
  | "cep"
  | "addressNumber"
  | "installments";

const FIELD_ORDER: FieldKey[] = ["name", "email", "phone", "cpf", "cardNumber", "holderName", "expiry", "cvv", "holderCpf", "cep", "addressNumber", "installments"];

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
const maskCard = (v: string) =>
  onlyDigits(v)
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, "$1 ");
const maskExpiry = (v: string) => {
  const d = onlyDigits(v).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};
const maskCep = (v: string) => {
  const d = onlyDigits(v).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};

/** Caminho de erro do servidor (zod / payWithCard) -> campo do formulário. */
function fieldFromPath(path: string, holderOther: boolean): FieldKey | null {
  const map: Record<string, FieldKey> = {
    "customer.name": "name",
    "customer.email": "email",
    "customer.phone": "phone",
    "customer.cpf": "cpf",
    "card.number": "cardNumber",
    "card.holderName": "holderName",
    "card.expiryMonth": "expiry",
    "card.expiryYear": "expiry",
    "card.ccv": "cvv",
    "holder.cpf": holderOther ? "holderCpf" : "cpf",
    "holder.postalCode": "cep",
    "holder.addressNumber": "addressNumber",
    installments: "installments",
  };
  return map[path] ?? null;
}

// ---- peças visuais ----
function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  inputMode?: "text" | "email" | "tel" | "numeric";
  autoComplete?: string;
  placeholder?: string;
  mono?: boolean;
  maxLength?: number;
}) {
  const { id, label, value, onChange, error, hint, inputMode, autoComplete, placeholder, maxLength } = props;
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

// ---- Turnstile (só quando a API pede) ----
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
  refCode?: string;
  eventId: string;
  turnstileSiteKey: string | null;
  /** CARD_ISOLATED=1: o iframe do cartão (`${CARD_ORIGIN}/form/${storeId}`); `null` = formulário de hoje. */
  cardFrame: { origin: string; src: string } | null;
}) {
  const { offer, storeName, touch, refCode, eventId, turnstileSiteKey, cardFrame } = props;
  const isolated = cardFrame !== null;
  const router = useRouter();
  const hydrated = useHydrated();
  const [method, setMethod] = useState<Method>(props.initialMethod);
  const [withBump, setWithBump] = useState(false);
  const [v, setV] = useState({
    name: "",
    email: "",
    phone: "",
    cpf: "",
    holderCpf: "",
    cardNumber: "",
    holderName: "",
    expiry: "",
    cvv: "",
    cep: "",
    addressNumber: "",
    installments: "1",
  });
  const [holderOther, setHolderOther] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [needsCpf, setNeedsCpf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState<{ last4: string } | null>(null);
  const [captcha, setCaptcha] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  // Pedido de cartão já criado para estes dados (nova tentativa de cartão reaproveita o pedido).
  const order = useRef<{ publicId: string; sig: string } | null>(null);
  // Chave de idempotência da tentativa de cartão em andamento (mantida se a rede cair antes da resposta).
  const idemKey = useRef<{ key: string; sig: string } | null>(null);
  const viewed = useRef(false);
  // CARD_ISOLATED: pedido de cartão com o bilhete atual; iframe (remontado ao trocar `frameKey`) e o seu estado.
  const cardOrder = useRef<CardOrder | null>(null);
  const frameCtrl = useRef<CardFrameController | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [frameStatus, setFrameStatus] = useState<FrameStatus>("loading");

  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    void recordCheckoutViewAction({ slug: offer.slug, touch });
  }, [offer.slug, touch]);

  const total = offer.priceCents + (withBump && offer.bump ? offer.bump.priceCents : 0);
  const frameConfig = useRef({ totalCents: total, maxInstallments: offer.maxInstallments });
  useEffect(() => {
    // Total novo (bump ligado ou desligado): o seletor de parcelas do iframe mostra o valor certo.
    frameConfig.current = { totalCents: total, maxInstallments: offer.maxInstallments };
    frameCtrl.current?.setConfig(frameConfig.current);
  }, [total, offer.maxInstallments]);

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
    if (m === "card" && !isolated) {
      const num = onlyDigits(v.cardNumber);
      // Sem Luhn: o servidor e o Asaas decidem (cartões de teste do sandbox não passam no Luhn).
      if (num.length < 13 || num.length > 19) e.cardNumber = "Confira o número do cartão.";
      if (v.holderName.trim().length < 2) e.holderName = "Informe o nome como está no cartão.";
      const [mm, yy] = v.expiry.split("/");
      if (!mm || !yy || !cardExpiryValid(mm, yy)) e.expiry = mm && yy && /^\d{2}$/.test(yy) && Number(mm) >= 1 && Number(mm) <= 12 ? "Cartão vencido." : "Use o formato MM/AA.";
      if (!/^\d{3,4}$/.test(v.cvv)) e.cvv = "3 ou 4 números no verso.";
      if (holderOther && !validCpf(onlyDigits(v.holderCpf))) e.holderCpf = "CPF do titular inválido.";
      if (onlyDigits(v.cep).length !== 8) e.cep = "Confira o CEP.";
      if (!v.addressNumber.trim()) e.addressNumber = "Informe o número.";
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
  const orderSig = () => JSON.stringify([v.name.trim(), v.email.trim().toLowerCase(), onlyDigits(v.phone), onlyDigits(v.cpf), withBump]);

  const customerPayload = (m: Method) => ({
    name: v.name.trim(),
    email: v.email.trim(),
    phone: v.phone,
    ...(m === "card" || asaasPix || needsCpf ? { cpf: onlyDigits(v.cpf) } : {}),
  });

  function handleStartError(r: Extract<StartResult, { ok: false }>) {
    if (r.needsCpf) {
      setNeedsCpf(true);
      setErrors({ cpf: "Informe o CPF para continuar." });
      setFormError(r.message);
      return;
    }
    const e: Partial<Record<FieldKey, string>> = {};
    for (const [path, msg] of Object.entries(r.fields ?? {})) {
      const k = fieldFromPath(path, holderOther);
      if (k) e[k] = msg;
    }
    if (Object.keys(e).length > 0) showErrors(e, r.message === "Confira os campos marcados." ? undefined : r.message);
    else setFormError(r.message);
  }

  async function payPix() {
    checkoutTracking.onAddPaymentInfo("pix", total);
    const r = await startCheckoutAction({ slug: offer.slug, withBump, method: "pix", customer: customerPayload("pix"), touch, ref: refCode, eventId });
    if (r.ok) {
      router.push(`/o/${r.publicId}`);
      return;
    }
    handleStartError(r);
    setBusy(false);
  }

  async function payCard() {
    checkoutTracking.onAddPaymentInfo("card", total);
    const sig = orderSig();
    let publicId = order.current?.sig === sig ? order.current.publicId : null;
    if (!publicId) {
      const r = await startCheckoutAction({ slug: offer.slug, withBump, method: "card", customer: customerPayload("card"), touch, ref: refCode, eventId });
      if (!r.ok) {
        handleStartError(r);
        setBusy(false);
        return;
      }
      publicId = r.publicId;
      order.current = { publicId, sig };
    }
    const [mm, yy] = v.expiry.split("/");
    const cardNumber = onlyDigits(v.cardNumber);
    const attemptSig = JSON.stringify([publicId, cardNumber, v.expiry, v.cvv, v.installments]);
    if (idemKey.current?.sig !== attemptSig) idemKey.current = { key: crypto.randomUUID(), sig: attemptSig };
    let res: Response;
    try {
      res = await fetch("/api/checkout/card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderPublicId: publicId,
          idempotencyKey: idemKey.current.key,
          installments: Number(v.installments),
          card: { holderName: v.holderName.trim(), number: cardNumber, expiryMonth: mm, expiryYear: yy, ccv: v.cvv },
          holder: {
            cpf: onlyDigits(holderOther ? v.holderCpf : v.cpf),
            postalCode: onlyDigits(v.cep),
            addressNumber: v.addressNumber.trim(),
          },
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });
    } catch {
      // Mesma chave na próxima vez: se a cobrança chegou ao Asaas, não cobra de novo.
      setFormError("Sem conexão. Confira a internet e toque em pagar de novo.");
      setBusy(false);
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string; error?: string; fields?: string[][]; captcha?: boolean };
    idemKey.current = null;
    setTurnstileToken(undefined);
    if (res.ok && (body.status === "approved" || body.status === "unknown")) {
      router.push(`/o/${publicId}`);
      return;
    }
    setBusy(false);
    if (res.ok && body.status === "declined") {
      setDeclined({ last4: cardNumber.slice(-4) });
      window.scrollTo({ top: 0 });
      return;
    }
    if (res.status === 400 && Array.isArray(body.fields)) {
      const e: Partial<Record<FieldKey, string>> = {};
      for (const p of body.fields) {
        const k = fieldFromPath(p.join("."), holderOther);
        if (k) e[k] = k === "phone" ? "Confira o número de WhatsApp." : k === "expiry" ? "Cartão vencido ou validade inválida." : "Confira este campo.";
      }
      if (e.phone) order.current = null;
      if (Object.keys(e).length > 0) return showErrors(e, body.message === "Dados de pagamento inválidos" ? undefined : body.message);
    }
    if (body.captcha) setCaptcha(true);
    setFormError(body.message ?? CARD_GENERIC_MESSAGE);
  }

  /** CARD_ISOLATED: pedido (novo ou reaproveitado) + `pay` ao iframe; dados do cartão nunca passam por aqui. */
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
    const { outcome, order: next } = await payWithFrame({
      order: cardOrder.current,
      sig,
      now: () => Date.now(),
      start: () => startCheckoutAction({ slug: offer.slug, withBump, method: "card", customer: customerPayload("card"), touch, ref: refCode, eventId }),
      renew: (o) => renewCardTicketAction(o),
      pay: (a) => ctrl.pay({ ...a, buyerCpf }),
    });
    cardOrder.current = next;
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

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    const e = validate(method);
    if (method === "card" && isolated) {
      const ctrl = frameCtrl.current;
      // Indisponível: o aviso já está no bloco do cartão (sem repetir no topo); nenhum pedido é criado.
      if (!ctrl || frameStatus !== "ready") return setFormError(frameStatus === "unavailable" ? null : FRAME_UNAVAILABLE_MESSAGE);
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
      await (method === "pix" ? payPix() : isolated ? payCardInFrame() : payCard());
    } catch {
      setFormError("Não foi possível continuar agora. Tente de novo em instantes.");
      setBusy(false);
    }
  }

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
          setV((cur) => ({ ...cur, cardNumber: "", expiry: "", cvv: "", holderName: "" }));
          if (isolated) setFrameKey((k) => k + 1);
        }}
      />
    );
  }

  const installmentOptions = Array.from({ length: offer.maxInstallments }, (_, i) => i + 1);
  const pixSub = asaasPix ? "Liberado na hora" : "Direto para a loja";
  const cardSub = offer.maxInstallments > 1 ? `Em até ${offer.maxInstallments}x` : "Crédito";
  const buttonLabel = busy ? (method === "pix" ? "Gerando Pix…" : "Processando pagamento…") : method === "pix" ? `Gerar Pix de ${brl(total)}` : `Pagar ${brl(total)}`;

  const productRow = (small?: boolean): ReactNode => (
    <>
      <ProductCover small={small} />
      <div className={s.productText}>
        <p className={`${s.p0} ${s.muted} ${s.small}`}>Você está comprando</p>
        <p className={s.productTitle}>{offer.name}</p>
        <p className={s.productSub}>{offer.productName} · PDF para baixar</p>
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
                error={errors.email}
                hint="É para este e-mail que enviamos o seu acesso."
                inputMode="email"
                autoComplete="email"
                maxLength={254}
              />
              <Field
                id="phone"
                label="WhatsApp"
                value={v.phone}
                onChange={set("phone", maskPhone)}
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
              <div ref={frameBox} className={s.cardFrameBox} aria-busy={frameStatus === "loading"} hidden={method !== "card" || frameStatus === "unavailable"} />
            ) : null}
            {/* Com o iframe, a nota "Os dados do cartão não ficam salvos." vem dentro dele. */}
            {method === "card" && isolated && frameStatus === "unavailable" ? (
              <p className={s.alert} role="alert">
                <Icon name="circle-alert" />
                <span>{FRAME_UNAVAILABLE_MESSAGE}</span>
              </p>
            ) : null}

            {method === "card" && !isolated ? (
              <>
                <div className={s.stack} style={{ marginTop: 14 }}>
                  <Field id="cardNumber" label="Número do cartão" value={v.cardNumber} onChange={set("cardNumber", maskCard)} error={errors.cardNumber} inputMode="numeric" autoComplete="cc-number" placeholder="0000 0000 0000 0000" />
                  <Field id="holderName" label="Nome impresso no cartão" value={v.holderName} onChange={set("holderName", (x) => x.toUpperCase())} error={errors.holderName} autoComplete="cc-name" maxLength={100} />
                  <div className={s.grid2}>
                    <Field id="expiry" label="Validade" value={v.expiry} onChange={set("expiry", maskExpiry)} error={errors.expiry} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/AA" />
                    <Field id="cvv" label="CVV" value={v.cvv} onChange={set("cvv", (x) => onlyDigits(x).slice(0, 4))} error={errors.cvv} hint="3 números no verso." inputMode="numeric" autoComplete="cc-csc" />
                  </div>
                  <label className={s.checkLine}>
                    <input type="checkbox" checked={holderOther} onChange={(e) => setHolderOther(e.target.checked)} />O cartão está no nome de outra pessoa
                  </label>
                  {holderOther ? (
                    <Field id="holderCpf" label="CPF do titular do cartão" value={v.holderCpf} onChange={set("holderCpf", maskCpf)} error={errors.holderCpf} inputMode="numeric" placeholder="000.000.000-00" />
                  ) : null}
                  <div className={s.grid2Wide}>
                    <Field id="cep" label="CEP" value={v.cep} onChange={set("cep", maskCep)} error={errors.cep} inputMode="numeric" autoComplete="postal-code" placeholder="00000-000" />
                    <Field id="addressNumber" label="Número" value={v.addressNumber} onChange={set("addressNumber")} error={errors.addressNumber} maxLength={20} />
                  </div>
                  {offer.maxInstallments > 1 ? (
                    <div className={s.field}>
                      <label className={s.label} htmlFor="installments">
                        Parcelas
                      </label>
                      <div className={s.box}>
                        <select id="installments" className={s.input} value={v.installments} onChange={(e) => set("installments")(e.target.value)}>
                          {installmentOptions.map((n) => (
                            <option key={n} value={n}>
                              {n === 1 ? `1x de ${brl(total)} sem juros` : `${n}x (total ${brl(total)})`}
                            </option>
                          ))}
                        </select>
                        <Icon name="chevron-down" className={s.muted} />
                      </div>
                    </div>
                  ) : null}
                </div>
                <p className={s.lockNote}>
                  <Icon name="lock" size={15} />
                  Os dados do cartão não ficam salvos.
                </p>
                {captcha && turnstileSiteKey ? <Turnstile siteKey={turnstileSiteKey} onToken={setTurnstileToken} /> : null}
              </>
            ) : null}
          </section>
        </div>

        <aside className={s.aside}>
          <div className={s.asideCard}>
            <div className={s.productInAside}>{productRow(true)}</div>
            {offer.bump ? (
              <label className={s.bump} data-checked={withBump ? "true" : undefined}>
                <input type="checkbox" className={s.srOnly} checked={withBump} onChange={(e) => setWithBump(e.target.checked)} />
                <span className={s.bumpTop}>
                  <span className={s.bumpBox} aria-hidden="true">
                    <Icon name="check" size={16} />
                  </span>
                  <span className={s.bumpTitle}>{offer.bump.label?.trim() || `Adicionar ${offer.bump.productName}`}</span>
                  <span className={`${s.bumpPrice} ${s.money}`}>+ {brl(offer.bump.priceCents)}</span>
                </span>
                <span className={s.bumpText}>Leve também {offer.bump.productName}. Os dois arquivos chegam juntos no seu e-mail.</span>
              </label>
            ) : null}
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
              <div className={s.divider} />
              <div className={s.totalRow}>
                <span className={s.totalLabel}>Total</span>
                <span className={`${s.totalValue} ${s.money}`} data-testid="total">
                  {brl(total)}
                </span>
              </div>
              <button type="submit" className={`${s.btn} ${s.btnLg} ${s.btnFull}`} disabled={busy || !hydrated || (isolated && method === "card" && frameStatus !== "ready")}>
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
