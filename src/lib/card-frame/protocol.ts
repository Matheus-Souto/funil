// Protocolo postMessage entre o checkout do app e o iframe do cartão.
// Módulo puro, sem imports: vai no bundle do iframe. Nenhuma mensagem carrega dados de cartão; os parsers montam
// um objeto NOVO só com as chaves do tipo e descartam o resto. Campo opcional inválido anula a mensagem inteira.

export const CARD_MSG_PREFIX = "funil-card:";

export type ResultStatus = "approved" | "declined" | "unknown" | "unavailable" | "error";

export type ParentMsg =
  | { t: "funil-card:config"; totalCents: number; maxInstallments: number }
  | { t: "funil-card:validate"; id: string }
  | { t: "funil-card:pay"; id: string; orderPublicId: string; ticket: string; buyerCpf: string };

export type FrameMsg =
  | { t: "funil-card:ready" }
  | { t: "funil-card:height"; px: number }
  | { t: "funil-card:validated"; id: string; ok: boolean; fields: string[] }
  | {
      t: "funil-card:result";
      id: string;
      status: ResultStatus;
      message?: string;
      last4?: string;
      fields?: string[][];
      captcha?: boolean;
      ticketExpired?: boolean;
    };

const STATUSES: readonly string[] = ["approved", "declined", "unknown", "unavailable", "error"];

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length >= 1 && v.length <= max ? v : null;
}

function int(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return null;
  return v === 0 ? 0 : v; // normaliza -0
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const item: unknown = Object.prototype.hasOwnProperty.call(v, i) ? v[i] : undefined; // array esparso falha aqui
    if (typeof item !== "string" || item.length > maxLen) return null;
    out.push(item);
  }
  return out;
}

// Lê só propriedade própria (nunca a cadeia de protótipos), uma única vez por campo.
function get(o: object, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
}

export function parseParentMsg(data: unknown): ParentMsg | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data;
  switch (get(d, "t")) {
    case "funil-card:config": {
      const totalCents = int(get(d, "totalCents"), 1, 100_000_000);
      const maxInstallments = int(get(d, "maxInstallments"), 1, 12);
      if (totalCents === null || maxInstallments === null) return null;
      return { t: "funil-card:config", totalCents, maxInstallments };
    }
    case "funil-card:validate": {
      const id = str(get(d, "id"), 64);
      return id === null ? null : { t: "funil-card:validate", id };
    }
    case "funil-card:pay": {
      const id = str(get(d, "id"), 64);
      const orderPublicId = str(get(d, "orderPublicId"), 64);
      const ticket = str(get(d, "ticket"), 2048);
      const cpf = get(d, "buyerCpf");
      const buyerCpf = typeof cpf === "string" && /^[0-9]{11}$/.test(cpf) ? cpf : null;
      if (id === null || orderPublicId === null || ticket === null || buyerCpf === null) return null;
      return { t: "funil-card:pay", id, orderPublicId, ticket, buyerCpf };
    }
    default:
      return null;
  }
}

export function parseFrameMsg(data: unknown): FrameMsg | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data;
  switch (get(d, "t")) {
    case "funil-card:ready":
      return { t: "funil-card:ready" };
    case "funil-card:height": {
      const px = int(get(d, "px"), 0, 4000);
      return px === null ? null : { t: "funil-card:height", px };
    }
    case "funil-card:validated": {
      const id = str(get(d, "id"), 64);
      const fields = strList(get(d, "fields"), 20, 64);
      const ok = get(d, "ok");
      if (id === null || fields === null || typeof ok !== "boolean") return null;
      return { t: "funil-card:validated", id, ok, fields };
    }
    case "funil-card:result": {
      const id = str(get(d, "id"), 64);
      const status = get(d, "status");
      if (id === null || typeof status !== "string" || !STATUSES.includes(status)) return null;
      const out: Extract<FrameMsg, { t: "funil-card:result" }> = {
        t: "funil-card:result",
        id,
        status: status as ResultStatus,
      };
      const message = get(d, "message");
      if (message !== undefined) {
        if (typeof message !== "string" || message.length > 300) return null;
        out.message = message;
      }
      const last4 = get(d, "last4");
      if (last4 !== undefined) {
        if (typeof last4 !== "string" || !/^[0-9]{4}$/.test(last4)) return null;
        out.last4 = last4;
      }
      const fields = get(d, "fields");
      if (fields !== undefined) {
        if (!Array.isArray(fields) || fields.length > 20) return null;
        const groups: string[][] = [];
        for (let i = 0; i < fields.length; i++) {
          const list = strList(Object.prototype.hasOwnProperty.call(fields, i) ? fields[i] : undefined, 5, 64);
          if (list === null) return null;
          groups.push(list);
        }
        out.fields = groups;
      }
      const captcha = get(d, "captcha");
      if (captcha !== undefined) {
        if (typeof captcha !== "boolean") return null;
        out.captcha = captcha;
      }
      const ticketExpired = get(d, "ticketExpired");
      if (ticketExpired !== undefined) {
        if (typeof ticketExpired !== "boolean") return null;
        out.ticketExpired = ticketExpired;
      }
      return out;
    }
    default:
      return null;
  }
}
