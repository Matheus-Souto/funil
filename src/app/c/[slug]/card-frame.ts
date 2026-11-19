// Lado do app da conversa com o iframe do cartão (CARD_ISOLATED=1). Lógica pura, sem DOM e sem React: o componente
// do checkout liga isto ao <iframe> e ao `window.addEventListener("message")`.
//
// - `acceptFrameMessage`: só aceita mensagem com `origin === CARD_ORIGIN` E `source === iframe.contentWindow`, e só se
//   `parseFrameMsg` reconhecer o formato.
// - `createCardFrameController`: estado do iframe (carregando / pronto / indisponível), `config` no `ready` e quando o
//   total muda, e as pendências: `validated` e `result` só valem se o `id` bate com um `validate`/`pay` que o app mandou
//   e ainda espera (o resto é ignorado: uma página hostil não injeta "approved").
// - `payWithFrame`: o fluxo do "Pagar" depois da validação (pedido novo ou reaproveitado, bilhete, `pay`, renovação
//   única do bilhete vencido) e o desfecho para a tela.
// Nada aqui vê dados do cartão: eles ficam no iframe; o app só manda o bilhete do pedido e o CPF do comprador.
import { parseFrameMsg, type FrameMsg, type ParentMsg } from "@/lib/card-frame/protocol";

/** Sem `ready` neste prazo, o cartão fica indisponível (DNS do `pagar.` faltando, serviço fora). */
export const FRAME_READY_TIMEOUT_MS = 10_000;
/** Prazo da resposta ao `validate` (só validação local no iframe). */
export const FRAME_VALIDATE_TIMEOUT_MS = 10_000;
/** Prazo da resposta ao `pay`: acima do prazo do POST no iframe (75 s), que sempre responde antes. */
export const FRAME_PAY_TIMEOUT_MS = 90_000;
/** Pedido reaproveitado com bilhete mais velho que isto ganha bilhete novo antes do `pay` (o bilhete vale 30 min). */
export const TICKET_RENEW_AFTER_MS = 25 * 60 * 1000;

export const FRAME_UNAVAILABLE_MESSAGE = "Pagamento com cartão indisponível agora. Tente de novo em instantes ou pague com Pix.";
/** Mensagem genérica do pagamento com cartão (a mesma do checkout de hoje). */
export const CARD_GENERIC_MESSAGE = "Não foi possível processar o pagamento. Tente de novo em instantes.";

export type FrameStatus = "loading" | "ready" | "unavailable";
export type FrameValidated = Extract<FrameMsg, { t: "funil-card:validated" }>;
export type FrameResult = Extract<FrameMsg, { t: "funil-card:result" }>;

/** Mensagem do iframe se veio da origem do cartão E da janela do iframe montado, no formato do protocolo; senão `null`. */
export function acceptFrameMessage(ev: { origin: string; source: unknown; data: unknown }, frame: { origin: string; window: unknown }): FrameMsg | null {
  if (frame.window === null || frame.window === undefined) return null;
  if (ev.origin !== frame.origin || ev.source !== frame.window) return null;
  return parseFrameMsg(ev.data);
}

/** Nomes de campo que o app aceita do iframe: os do formulário do cartão mais `cpf` (o CPF do comprador, no app). */
export const FRAME_FIELD_NAMES = ["cardNumber", "holderName", "expiry", "cvv", "holderCpf", "cep", "addressNumber", "installments", "cpf"] as const;
export type FrameFieldName = (typeof FRAME_FIELD_NAMES)[number];

/** Filtra `fields` (lista simples ou grupos do `result`) para os nomes conhecidos, sem repetir, na ordem recebida. */
export function frameFieldNames(fields: readonly (string | readonly string[])[]): FrameFieldName[] {
  const out: FrameFieldName[] = [];
  for (const f of fields) {
    const name = typeof f === "string" ? f : f[0];
    if (typeof name === "string" && (FRAME_FIELD_NAMES as readonly string[]).includes(name) && !out.includes(name as FrameFieldName)) {
      out.push(name as FrameFieldName);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Controlador do iframe

export interface FrameConfig {
  totalCents: number;
  maxInstallments: number;
}

export interface FrameControllerDeps {
  /** CARD_ORIGIN: a única origem aceita e o único destino das mensagens. */
  origin: string;
  /** `iframe.contentWindow` do iframe montado agora (o único `source` aceito). */
  getWindow: () => unknown;
  /** Manda ao iframe (`contentWindow.postMessage(msg, origin)`). */
  post: (msg: ParentMsg) => void;
  setTimer: (fn: () => void, ms: number) => () => void;
  newId: () => string;
  onStatus: (s: FrameStatus) => void;
  onHeight: (px: number) => void;
}

export interface CardFrameController {
  readonly status: FrameStatus;
  /** Começa a contar o prazo do `ready`. Chamar depois de registrar o listener e montar o iframe. */
  start(): void;
  /** Total e parcelas atuais; manda `config` se o iframe está pronto e mudou algo (bump ligado ou desligado). */
  setConfig(c: FrameConfig): void;
  handle(ev: { origin: string; source: unknown; data: unknown }): void;
  /** `validated` do iframe, ou `null` (indisponível ou sem resposta no prazo). */
  validate(): Promise<FrameValidated | null>;
  /** `result` do iframe, ou `null` (indisponível ou sem resposta no prazo). */
  pay(args: { orderPublicId: string; ticket: string; buyerCpf: string }): Promise<FrameResult | null>;
  /** Iframe desmontado: pendências resolvem `null` e nada mais é aceito. */
  dispose(): void;
}

type Pending = { kind: "validate" | "pay"; resolve: (m: FrameMsg | null) => void; cancel: () => void };

export function createCardFrameController(d: FrameControllerDeps): CardFrameController {
  let status: FrameStatus = "loading";
  let config: FrameConfig | null = null;
  let sentConfig: string | null = null;
  let cancelReady: (() => void) | null = null;
  let disposed = false;
  const pending = new Map<string, Pending>();

  const setStatus = (s: FrameStatus) => {
    if (s === status) return;
    status = s;
    d.onStatus(s);
  };
  const sendConfig = (force: boolean) => {
    if (status !== "ready" || config === null) return;
    const key = `${config.totalCents}/${config.maxInstallments}`;
    if (!force && key === sentConfig) return;
    sentConfig = key;
    d.post({ t: "funil-card:config", totalCents: config.totalCents, maxInstallments: config.maxInstallments });
  };
  const wait = (kind: Pending["kind"], msg: Extract<ParentMsg, { id: string }>, ms: number): Promise<FrameMsg | null> => {
    if (disposed || status !== "ready") return Promise.resolve(null);
    return new Promise((resolve) => {
      const cancel = d.setTimer(() => {
        if (pending.get(msg.id)?.resolve !== resolve) return;
        pending.delete(msg.id);
        resolve(null);
      }, ms);
      pending.set(msg.id, { kind, resolve, cancel });
      d.post(msg);
    });
  };

  return {
    get status() {
      return status;
    },
    start() {
      cancelReady = d.setTimer(() => {
        cancelReady = null;
        if (status === "loading") setStatus("unavailable");
      }, FRAME_READY_TIMEOUT_MS);
    },
    setConfig(c) {
      config = { totalCents: c.totalCents, maxInstallments: c.maxInstallments };
      sendConfig(false);
    },
    handle(ev) {
      if (disposed) return;
      const msg = acceptFrameMessage(ev, { origin: d.origin, window: d.getWindow() });
      if (!msg) return;
      switch (msg.t) {
        case "funil-card:ready":
          // Também num recarregamento do iframe (ou um `ready` atrasado depois do prazo): o formulário novo precisa do total.
          cancelReady?.();
          cancelReady = null;
          setStatus("ready");
          sendConfig(true);
          return;
        case "funil-card:height":
          d.onHeight(msg.px);
          return;
        case "funil-card:validated":
        case "funil-card:result": {
          const p = pending.get(msg.id);
          if (!p || p.kind !== (msg.t === "funil-card:validated" ? "validate" : "pay")) return;
          pending.delete(msg.id);
          p.cancel();
          p.resolve(msg);
          return;
        }
      }
    },
    validate() {
      return wait("validate", { t: "funil-card:validate", id: d.newId() }, FRAME_VALIDATE_TIMEOUT_MS) as Promise<FrameValidated | null>;
    },
    pay(args) {
      const msg: ParentMsg = { t: "funil-card:pay", id: d.newId(), orderPublicId: args.orderPublicId, ticket: args.ticket, buyerCpf: args.buyerCpf };
      return wait("pay", msg, FRAME_PAY_TIMEOUT_MS) as Promise<FrameResult | null>;
    },
    dispose() {
      disposed = true;
      cancelReady?.();
      cancelReady = null;
      for (const p of pending.values()) {
        p.cancel();
        p.resolve(null);
      }
      pending.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fluxo do "Pagar" (depois de validar os dados pessoais e o iframe)

/** Pedido de cartão já criado para estes dados, com o bilhete atual e quando foi emitido. */
export interface CardOrder {
  publicId: string;
  /** Assinatura dos dados pessoais e do bump: muda -> pedido novo (como hoje). */
  sig: string;
  ticket: string;
  ticketAt: number;
}

export type StartFailure = { ok: false; message: string; fields?: Record<string, string>; needsCpf?: boolean };
type StartLike = { ok: true; publicId: string; cardTicket?: string } | StartFailure;
type Renewal = { ok: true; ticket: string } | { ok: false; message: string };

export type PayOutcome =
  | { kind: "start_error"; result: StartFailure }
  | { kind: "go"; publicId: string }
  | { kind: "declined"; last4: string }
  /** `cpf`: o servidor recusou o CPF do comprador (titular = comprador): o app marca o campo dele. */
  | { kind: "failed"; message: string; cpf: boolean };

const failed = (message: string, cpf = false): PayOutcome => ({ kind: "failed", message, cpf });

function outcomeOf(r: FrameResult | null, publicId: string): PayOutcome {
  if (r === null) return failed(CARD_GENERIC_MESSAGE);
  if (r.status === "approved" || r.status === "unknown") return { kind: "go", publicId };
  if (r.status === "declined") return { kind: "declined", last4: r.last4 ?? "" };
  return failed(r.message ?? CARD_GENERIC_MESSAGE, frameFieldNames(r.fields ?? []).includes("cpf"));
}

/**
 * Cria (ou reaproveita) o pedido, paga pelo iframe e diz o desfecho. Devolve também o pedido a guardar para a próxima
 * tentativa (`null` = esquecer: a próxima cria outro).
 * - Pedido reaproveitado com bilhete de mais de 25 min: bilhete novo antes do `pay`.
 * - `ticketExpired`: bilhete novo e o `pay` de novo uma única vez, mesmo pedido. Renovação recusada: mensagem genérica.
 */
export async function payWithFrame(d: {
  order: CardOrder | null;
  sig: string;
  now: () => number;
  start: () => Promise<StartLike>;
  renew: (publicId: string) => Promise<Renewal>;
  pay: (args: { orderPublicId: string; ticket: string }) => Promise<FrameResult | null>;
}): Promise<{ outcome: PayOutcome; order: CardOrder | null }> {
  let order = d.order !== null && d.order.sig === d.sig ? d.order : null;
  const renew = async (o: CardOrder): Promise<CardOrder | string> => {
    const r = await d.renew(o.publicId);
    return r.ok ? { ...o, ticket: r.ticket, ticketAt: d.now() } : r.message;
  };

  if (order !== null && d.now() - order.ticketAt > TICKET_RENEW_AFTER_MS) {
    const r = await renew(order);
    if (typeof r === "string") return { outcome: failed(r), order: null };
    order = r;
  }
  if (order === null) {
    const r = await d.start();
    if (!r.ok) return { outcome: { kind: "start_error", result: r }, order: d.order };
    if (!r.cardTicket) return { outcome: failed(CARD_GENERIC_MESSAGE), order: d.order };
    order = { publicId: r.publicId, sig: d.sig, ticket: r.cardTicket, ticketAt: d.now() };
  }

  let res = await d.pay({ orderPublicId: order.publicId, ticket: order.ticket });
  if (res?.status === "error" && res.ticketExpired === true) {
    const r = await renew(order);
    if (typeof r === "string") return { outcome: failed(r), order: null };
    order = r;
    res = await d.pay({ orderPublicId: order.publicId, ticket: order.ticket });
    if (res?.status === "error" && res.ticketExpired === true) return { outcome: failed(CARD_GENERIC_MESSAGE), order };
  }
  return { outcome: outcomeOf(res, order.publicId), order };
}
