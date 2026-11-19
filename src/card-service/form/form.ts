// Formulário do cartão dentro do iframe (pagar.<domínio>/form/<storeId>). Empacotado para o navegador como /form.js.
//
// - Monta os campos (mesmos rótulos e máscaras do checkout) só com DOM: nada de innerHTML, estilo inline, eval.
// - Mensagens: só aceita `event.origin` em `cfg.allowedOrigins` E `event.source === window.parent`; responde só à
//   origem que mandou. `ready` e `height` vão a cada origem permitida (o navegador descarta as que não batem).
// - `pay`: um por vez (o que chega durante outro recebe erro genérico); id repetido é ignorado. Depois de um
//   `result`, `pay` para OUTRO pedido só passa se o comprador mexeu no iframe desde então: um pai comprometido não
//   reusa sozinho o cartão que ficou nos campos. POST relativo /api/card (mesma origem), com prazo; leva o `storeId`
//   da página, que o servidor confere com a loja do bilhete.
//
// DADOS DO CARTÃO: número, validade e CVV só existem nos inputs e, durante o POST, em variáveis locais que são soltas
// logo após a resposta. Nunca vão para postMessage, console, storage, URL ou atributo `name`; os inputs não têm
// `name` e o <form> não tem `action` (sem JS, ou com JS, nada é enviado pelo navegador).
import { parseFrameMsg, parseParentMsg, type FrameMsg } from "@/lib/card-frame/protocol";
import {
  attemptKey,
  attemptSig,
  buildCardBody,
  fieldErrors,
  fieldsMessage,
  GENERIC_MESSAGE,
  installmentOptions,
  mapApiResponse,
  maskCard,
  maskCep,
  maskCpf,
  maskCvv,
  maskExpiry,
  maskHolderName,
  NETWORK_MESSAGE,
  serverFieldMessage,
  type CardBody,
  type CardFields,
  type FieldName,
  type ResultBody,
} from "./logic";

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SVG_NS = "http://www.w3.org/2000/svg";

interface TurnstileApi {
  render(el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void; "error-callback"?: () => void }): string | undefined | null;
  reset(widgetId?: string): void;
}

export interface FormDeps {
  /** A janela do iframe. */
  win: Window & typeof globalThis;
  /** `window.parent`: o checkout da loja (o único `source` aceito e o único destino). */
  parent: { postMessage(msg: FrameMsg, targetOrigin: string): void };
  fetch: typeof fetch;
  /** Gera a chave de idempotência (`crypto.randomUUID`). */
  newKey: () => string;
  now?: () => Date;
  /** Prazo do POST /api/card (padrão 75 s, acima do prazo da cobrança no servidor). Estourar = queda de rede. */
  payTimeoutMs?: number;
}

export const PAY_TIMEOUT_MS = 75_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Cfg {
  allowedOrigins: string[];
  turnstileSiteKey: string | null;
  /** Loja da página (`/form/<storeId>`), em minúsculas; sem ela, o iframe não envia o cartão. */
  storeId: string | null;
}

function readCfg(doc: Document): Cfg {
  try {
    const raw = JSON.parse(doc.getElementById("cfg")?.textContent ?? "") as { allowedOrigins?: unknown; turnstileSiteKey?: unknown; storeId?: unknown };
    const origins = Array.isArray(raw.allowedOrigins)
      ? raw.allowedOrigins.filter((o): o is string => typeof o === "string" && /^https?:\/\/[^/*\s]+$/.test(o))
      : [];
    const site = typeof raw.turnstileSiteKey === "string" && raw.turnstileSiteKey.length > 0 ? raw.turnstileSiteKey : null;
    const storeId = typeof raw.storeId === "string" && UUID.test(raw.storeId) ? raw.storeId : null;
    return { allowedOrigins: origins, turnstileSiteKey: site, storeId };
  } catch {
    return { allowedOrigins: [], turnstileSiteKey: null, storeId: null };
  }
}

// ---- ícones (mesmos traçados de src/app/(design)/icons.tsx) ----
const ICONS = {
  "circle-alert": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["line", { x1: "12", x2: "12", y1: "8", y2: "12" }],
    ["line", { x1: "12", x2: "12.01", y1: "16", y2: "16" }],
  ],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  lock: [
    ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2" }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ],
} as const satisfies Record<string, readonly (readonly [string, Record<string, string>])[]>;

function icon(doc: Document, name: keyof typeof ICONS, cls: string, size = 18): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const attrs: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: cls,
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, a] of ICONS[name]) {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

interface FieldUi {
  wrap: HTMLDivElement;
  control: HTMLInputElement | HTMLSelectElement;
  msg: HTMLParagraphElement;
  hint: string;
}

function makeField(
  doc: Document,
  id: string,
  label: string,
  opts: { inputMode?: string; autoComplete?: string; placeholder?: string; maxLength?: number; hint?: string; select?: boolean } = {},
): FieldUi {
  const control = opts.select ? el(doc, "select", { id, class: "input" }) : el(doc, "input", { id, class: "input", type: "text", autocapitalize: "off", spellcheck: "false" });
  if (control instanceof doc.defaultView!.HTMLInputElement) {
    if (opts.inputMode) control.setAttribute("inputmode", opts.inputMode);
    control.setAttribute("autocomplete", opts.autoComplete ?? "off");
    if (opts.placeholder) control.setAttribute("placeholder", opts.placeholder);
    if (opts.maxLength) control.setAttribute("maxlength", String(opts.maxLength));
  }
  const hint = opts.hint ?? "";
  const msg = el(doc, "p", { id: `${id}-msg`, class: "hint" }, hint);
  msg.hidden = hint === "";
  if (hint) control.setAttribute("aria-describedby", msg.id);
  const box = el(doc, "div", { class: "box" }, control, opts.select ? icon(doc, "chevron-down", "muted") : icon(doc, "circle-alert", "errIcon"));
  const wrap = el(doc, "div", { class: "field" }, el(doc, "label", { class: "label", for: id }, label), box, msg);
  return { wrap, control, msg, hint };
}

function setInvalid(f: FieldUi, message: string | null): void {
  if (message === null) {
    f.wrap.removeAttribute("data-invalid");
    f.control.removeAttribute("aria-invalid");
    f.msg.textContent = f.hint;
    f.msg.hidden = f.hint === "";
    if (f.hint === "") f.control.removeAttribute("aria-describedby");
    return;
  }
  f.wrap.setAttribute("data-invalid", "true");
  f.control.setAttribute("aria-invalid", "true");
  f.msg.textContent = message;
  f.msg.hidden = false;
  f.control.setAttribute("aria-describedby", f.msg.id);
}

export function mountCardForm(deps: FormDeps): void {
  const { win, parent } = deps;
  const doc = win.document;
  const now = deps.now ?? (() => new Date());
  const cfg = readCfg(doc);
  const allowed = new Set(cfg.allowedOrigins);
  const root = doc.getElementById("card-form");
  if (!root) return;

  // ---- campos ----
  const f = {
    cardNumber: makeField(doc, "cardNumber", "Número do cartão", { inputMode: "numeric", autoComplete: "cc-number", placeholder: "0000 0000 0000 0000" }),
    holderName: makeField(doc, "holderName", "Nome impresso no cartão", { autoComplete: "cc-name", maxLength: 100 }),
    expiry: makeField(doc, "expiry", "Validade", { inputMode: "numeric", autoComplete: "cc-exp", placeholder: "MM/AA" }),
    cvv: makeField(doc, "cvv", "CVV", { inputMode: "numeric", autoComplete: "cc-csc", hint: "3 números no verso." }),
    holderCpf: makeField(doc, "holderCpf", "CPF do titular do cartão", { inputMode: "numeric", placeholder: "000.000.000-00" }),
    cep: makeField(doc, "cep", "CEP", { inputMode: "numeric", autoComplete: "postal-code", placeholder: "00000-000" }),
    addressNumber: makeField(doc, "addressNumber", "Número", { maxLength: 20 }),
    installments: makeField(doc, "installments", "Parcelas", { select: true }),
  } satisfies Record<FieldName, FieldUi>;
  const masks: Partial<Record<FieldName, (v: string) => string>> = {
    cardNumber: maskCard,
    holderName: maskHolderName,
    expiry: maskExpiry,
    cvv: maskCvv,
    holderCpf: maskCpf,
    cep: maskCep,
  };
  for (const [name, ui] of Object.entries(f) as [FieldName, FieldUi][]) {
    const mask = masks[name];
    ui.control.addEventListener(ui.control instanceof win.HTMLSelectElement ? "change" : "input", () => {
      if (mask && ui.control instanceof win.HTMLInputElement) {
        const masked = mask(ui.control.value);
        if (masked !== ui.control.value) ui.control.value = masked;
      }
      setInvalid(ui, null);
    });
  }

  const holderOther = el(doc, "input", { id: "holderOther", type: "checkbox" });
  f.holderCpf.wrap.hidden = true;
  holderOther.addEventListener("change", () => {
    f.holderCpf.wrap.hidden = !holderOther.checked;
    if (!holderOther.checked) setInvalid(f.holderCpf, null);
  });
  f.installments.wrap.hidden = true;
  const select = f.installments.control as HTMLSelectElement;

  const turnstileBox = el(doc, "div", { class: "turnstile" });
  turnstileBox.hidden = true;
  const alertBox = el(doc, "p", { class: "alert", role: "alert" });
  alertBox.hidden = true;

  const form = el(
    doc,
    "form",
    { class: "stack", novalidate: "" },
    f.cardNumber.wrap,
    f.holderName.wrap,
    el(doc, "div", { class: "grid2" }, f.expiry.wrap, f.cvv.wrap),
    el(doc, "label", { class: "checkLine" }, holderOther, "O cartão está no nome de outra pessoa"),
    f.holderCpf.wrap,
    el(doc, "div", { class: "grid2Wide" }, f.cep.wrap, f.addressNumber.wrap),
    f.installments.wrap,
  );
  form.addEventListener("submit", (e) => e.preventDefault());
  root.replaceChildren(form, el(doc, "p", { class: "lockNote" }, icon(doc, "lock", "lockIcon", 15), "Os dados do cartão não ficam salvos."), turnstileBox, alertBox);

  // ---- estado ----
  let installments = 1;
  let busy = false;
  const seenPays = new Set<string>();
  /** Chave da tentativa: sobrevive só a uma queda de rede (mesmos dados), nunca a uma resposta. */
  let attempt: { key: string; sig: string } | null = null;
  let turnstileToken: string | undefined;
  let turnstileWidget: string | undefined;
  let turnstileLoading = false;
  let turnstileFailed = false;
  /** Pedido do último `result` de um `pay` processado, e se o comprador editou algum campo desde então. */
  let lastOrder: string | null = null;
  let editedSinceResult = false;
  form.addEventListener("input", () => (editedSinceResult = true));

  select.addEventListener("change", () => {
    installments = Number(select.value) || 1;
  });

  const readFields = (): CardFields => ({
    cardNumber: (f.cardNumber.control as HTMLInputElement).value,
    holderName: (f.holderName.control as HTMLInputElement).value,
    expiry: (f.expiry.control as HTMLInputElement).value,
    cvv: (f.cvv.control as HTMLInputElement).value,
    holderCpf: (f.holderCpf.control as HTMLInputElement).value,
    cep: (f.cep.control as HTMLInputElement).value,
    addressNumber: (f.addressNumber.control as HTMLInputElement).value,
  });

  function showErrors(errors: Partial<Record<FieldName, string>>): FieldName[] {
    const names = (Object.keys(f) as FieldName[]).filter((k) => errors[k] !== undefined);
    for (const k of Object.keys(f) as FieldName[]) setInvalid(f[k], errors[k] ?? null);
    return names;
  }

  function broadcast(msg: FrameMsg): void {
    for (const o of allowed) {
      try {
        parent.postMessage(msg, o);
      } catch {
        /* origem malformada: o navegador recusa; as demais seguem */
      }
    }
  }

  // ---- Turnstile (só quando a resposta pede captcha e a loja tem a chave do site) ----
  const turnstile = (): TurnstileApi | undefined => (win as unknown as { turnstile?: TurnstileApi }).turnstile;
  function showTurnstile(): void {
    const siteKey = cfg.turnstileSiteKey;
    if (!siteKey) return;
    turnstileBox.hidden = false;
    alertBox.hidden = true;
    const api = turnstile();
    if (api) {
      if (turnstileWidget === undefined) {
        turnstileWidget =
          api.render(turnstileBox, {
            sitekey: siteKey,
            callback: (t) => (turnstileToken = t),
            "expired-callback": () => (turnstileToken = undefined),
            "error-callback": () => {
              // Desafio não carregou ou falhou: some a caixa e fica a mensagem genérica (o próximo captcha tenta de novo).
              turnstileToken = undefined;
              turnstileFailed = true;
              turnstileBox.hidden = true;
              alertBox.textContent = GENERIC_MESSAGE;
              alertBox.hidden = false;
            },
          }) ?? undefined;
      } else if (turnstileFailed) {
        turnstileFailed = false;
        api.reset(turnstileWidget);
      }
      return;
    }
    if (turnstileLoading) return;
    turnstileLoading = true;
    const s = el(doc, "script", { src: TURNSTILE_SRC, async: "" });
    s.addEventListener("load", () => showTurnstile());
    s.addEventListener("error", () => (turnstileLoading = false));
    doc.head.appendChild(s);
  }

  // ---- pagamento ----
  async function pay(msg: { orderPublicId: string; ticket: string; buyerCpf: string }): Promise<ResultBody> {
    if (cfg.storeId === null) return { status: "error", message: GENERIC_MESSAGE };
    const v = readFields();
    const other = holderOther.checked;
    const local = showErrors(fieldErrors(v, other, now()));
    if (local.length > 0) {
      (f[local[0]!].control as HTMLElement).focus();
      return { status: "error", message: fieldsMessage(local.length), fields: local.map((n) => [n]) };
    }
    attempt = attemptKey(attempt, attemptSig(msg.orderPublicId, v, other, installments), deps.newKey);
    const sentToken = turnstileToken;
    let body: CardBody | null = buildCardBody(v, other, msg.buyerCpf, installments, msg.ticket, msg.orderPublicId, attempt.key, sentToken);
    const last4 = body.card.number.slice(-4);
    let payload: string | null = JSON.stringify({ storeId: cfg.storeId, ...body });
    body = null;
    const signal = AbortSignal.timeout(deps.payTimeoutMs ?? PAY_TIMEOUT_MS);
    // O prazo vale mesmo se o fetch ignorar o sinal: a corrida termina no aborto.
    const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    aborted.catch(() => {}); // o prazo pode estourar depois da resposta: rejeição esperada, sem ninguém ouvindo
    let res: Response;
    let json: unknown;
    try {
      const call = deps.fetch("/api/card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal,
      });
      payload = null;
      res = await Promise.race([call, aborted]);
      json = await Promise.race([res.json(), aborted]).catch((e: unknown) => {
        if (signal.aborted) throw e;
        return {};
      });
    } catch {
      // Sem resposta (rede caiu ou estourou o prazo): a mesma chave fica para a próxima tentativa com os mesmos dados
      // (se a cobrança chegou ao Asaas, não cobra de novo).
      return { status: "error", message: NETWORK_MESSAGE };
    } finally {
      payload = null;
    }
    const out = mapApiResponse(res.status, json, last4);
    // Bilhete recusado (vencido ou não): o servidor parou antes de qualquer cobrança e do Turnstile, então a chave e o
    // token continuam valendo para a tentativa com o bilhete novo.
    if (out.ticketExpired === undefined) {
      attempt = null;
      if (sentToken !== undefined) {
        turnstileToken = undefined; // o token vale uma vez
        if (turnstileWidget !== undefined) turnstile()?.reset(turnstileWidget);
      }
    }
    if (out.fields) {
      const errors: Partial<Record<FieldName, string>> = {};
      for (const [n] of out.fields) errors[n as FieldName] = serverFieldMessage(n as FieldName);
      // "titular é outra pessoa" desligado: o CPF do titular é o do comprador, campo do app (o app marca o dele).
      if (!other) delete errors.holderCpf;
      const names = showErrors(errors);
      if (names[0]) (f[names[0]].control as HTMLElement).focus();
    }
    if (out.captcha) showTurnstile();
    return out;
  }

  function sendResult(id: string, origin: string, out: ResultBody): void {
    const msg = parseFrameMsg({ t: "funil-card:result", id, ...out }) ?? { t: "funil-card:result", id, status: "error", message: GENERIC_MESSAGE };
    parent.postMessage(msg, origin);
  }

  // ---- mensagens do checkout ----
  win.addEventListener("message", (ev) => {
    const e = ev as MessageEvent;
    if ((parent as unknown) === (win as unknown) || e.source !== (parent as unknown) || !allowed.has(e.origin)) return;
    const msg = parseParentMsg(e.data);
    if (!msg) return;
    const origin = e.origin;
    switch (msg.t) {
      case "funil-card:config": {
        const keep = installments;
        const opts = installmentOptions(msg.totalCents, msg.maxInstallments);
        select.replaceChildren(...opts.map((o) => el(doc, "option", { value: String(o.n) }, o.label)));
        installments = keep <= opts.length ? keep : 1;
        select.value = String(installments);
        f.installments.wrap.hidden = opts.length <= 1;
        return;
      }
      case "funil-card:validate": {
        const names = showErrors(fieldErrors(readFields(), holderOther.checked, now()));
        parent.postMessage({ t: "funil-card:validated", id: msg.id, ok: names.length === 0, fields: names }, origin);
        return;
      }
      case "funil-card:pay": {
        if (seenPays.has(msg.id)) return;
        // Outro em andamento: responde (o app não fica esperando) e não guarda o id, que pode voltar depois.
        if (busy) return sendResult(msg.id, origin, { status: "error", message: GENERIC_MESSAGE });
        seenPays.add(msg.id);
        if (lastOrder !== null && msg.orderPublicId !== lastOrder && !editedSinceResult) {
          // Outro pedido com o cartão que ficou nos campos, sem gesto do comprador no iframe: pede para conferir.
          showErrors({ cardNumber: serverFieldMessage("cardNumber") });
          return sendResult(msg.id, origin, { status: "error", message: fieldsMessage(1), fields: [["cardNumber"]] });
        }
        busy = true;
        pay(msg)
          .catch((): ResultBody => ({ status: "error", message: GENERIC_MESSAGE }))
          .then((out) => {
            busy = false;
            lastOrder = msg.orderPublicId;
            editedSinceResult = false;
            sendResult(msg.id, origin, out);
          });
        return;
      }
    }
  });

  // ---- altura ----
  let lastHeight = -1;
  const sendHeight = () => {
    const px = Math.min(4000, Math.max(0, Math.ceil(doc.body.getBoundingClientRect().height)));
    if (px === lastHeight) return;
    lastHeight = px;
    broadcast({ t: "funil-card:height", px });
  };
  if (typeof win.ResizeObserver === "function") new win.ResizeObserver(sendHeight).observe(doc.body);

  broadcast({ t: "funil-card:ready" });
  sendHeight();
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById("cfg")) {
  mountCardForm({ win: window, parent: window.parent, fetch: window.fetch.bind(window), newKey: () => crypto.randomUUID() });
}
