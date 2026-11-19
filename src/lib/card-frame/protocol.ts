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
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item.length > maxLen) return null;
    out.push(item);
  }
  return out;
}

function has(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}

export function parseParentMsg(data: unknown): ParentMsg | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  switch (d.t) {
    case "funil-card:config": {
      const totalCents = int(d.totalCents, 1, 100_000_000);
      const maxInstallments = int(d.maxInstallments, 1, 12);
      if (totalCents === null || maxInstallments === null) return null;
      return { t: "funil-card:config", totalCents, maxInstallments };
    }
    case "funil-card:validate": {
      const id = str(d.id, 64);
      return id === null ? null : { t: "funil-card:validate", id };
    }
    case "funil-card:pay": {
      const id = str(d.id, 64);
      const orderPublicId = str(d.orderPublicId, 64);
      const ticket = str(d.ticket, 2048);
      const buyerCpf = typeof d.buyerCpf === "string" && /^[0-9]{11}$/.test(d.buyerCpf) ? d.buyerCpf : null;
      if (id === null || orderPublicId === null || ticket === null || buyerCpf === null) return null;
      return { t: "funil-card:pay", id, orderPublicId, ticket, buyerCpf };
    }
    default:
      return null;
  }
}

export function parseFrameMsg(data: unknown): FrameMsg | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  switch (d.t) {
    case "funil-card:ready":
      return { t: "funil-card:ready" };
    case "funil-card:height": {
      const px = int(d.px, 0, 4000);
      return px === null ? null : { t: "funil-card:height", px };
    }
    case "funil-card:validated": {
      const id = str(d.id, 64);
      const fields = strList(d.fields, 20, 64);
      if (id === null || fields === null || typeof d.ok !== "boolean") return null;
      return { t: "funil-card:validated", id, ok: d.ok, fields };
    }
    case "funil-card:result": {
      const id = str(d.id, 64);
      if (id === null || typeof d.status !== "string" || !STATUSES.includes(d.status)) return null;
      const out: Extract<FrameMsg, { t: "funil-card:result" }> = {
        t: "funil-card:result",
        id,
        status: d.status as ResultStatus,
      };
      if (has(d, "message")) {
        if (typeof d.message !== "string" || d.message.length > 300) return null;
        out.message = d.message;
      }
      if (has(d, "last4")) {
        if (typeof d.last4 !== "string" || !/^[0-9]{4}$/.test(d.last4)) return null;
        out.last4 = d.last4;
      }
      if (has(d, "fields")) {
        if (!Array.isArray(d.fields) || d.fields.length > 20) return null;
        const groups: string[][] = [];
        for (const g of d.fields) {
          const list = strList(g, 5, 64);
          if (list === null) return null;
          groups.push(list);
        }
        out.fields = groups;
      }
      if (has(d, "captcha")) {
        if (typeof d.captcha !== "boolean") return null;
        out.captcha = d.captcha;
      }
      if (has(d, "ticketExpired")) {
        if (typeof d.ticketExpired !== "boolean") return null;
        out.ticketExpired = d.ticketExpired;
      }
      return out;
    }
    default:
      return null;
  }
}
