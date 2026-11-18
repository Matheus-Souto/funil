const SENSITIVE_KEY = /^(number|ccv|cvv|cardNumber|creditCard|expiryMonth|expiryYear|card)$/i;
// 13+ dígitos, com um espaço ou hífen opcional entre eles. Corridas longas são removidas inteiras.
const PAN = /\d(?:[ -]?\d){12,}/g;
const MASK = "[redacted]";

function walk(v: unknown, seen: WeakSet<object>): unknown {
  if (typeof v === "string") return v.replace(PAN, MASK);
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (seen.has(v)) return "[circular]";
  seen.add(v);
  if (v instanceof Error) return { name: v.name, message: walk(v.message, seen) };
  if (Array.isArray(v)) return v.map((x) => walk(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE_KEY.test(k) ? MASK : walk(val, seen);
  return out;
}

/** Remove dados de cartão: chaves sensíveis viram "[redacted]" e sequências de 13+ dígitos em textos também. */
export function redact(v: unknown): unknown {
  return walk(v, new WeakSet());
}

function write(level: "info" | "warn" | "error", msg: string, data?: unknown): void {
  const row: Record<string, unknown> = { level, time: new Date().toISOString(), msg: redact(msg) };
  if (data !== undefined) row.data = redact(data);
  process.stdout.write(JSON.stringify(row) + "\n");
}

export const log = {
  info: (msg: string, data?: unknown) => write("info", msg, data),
  warn: (msg: string, data?: unknown) => write("warn", msg, data),
  error: (msg: string, data?: unknown) => write("error", msg, data),
};
