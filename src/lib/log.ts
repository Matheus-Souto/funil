const SENSITIVE_KEY = /^(number|ccv|cvv|cardNumber|creditCard|expiryMonth|expiryYear|card)$/i;
// 13+ dígitos separados por qualquer espaço (inclui tab, NBSP, quebra de linha), ponto ou hífen. Corridas longas são removidas inteiras.
const PAN = /\d(?:[\s.-]*\d){12,}/g;
const MASK = "[redacted]";
const SHA256_HEX = /^[0-9a-f]{64}$/;

function walk(v: unknown, seen: WeakSet<object>): unknown {
  // Um digest sha256 inteiro em hex (emailHash da auditoria, hashes de token) tem 13+ dígitos seguidos em ~11% dos casos:
  // não é PAN e mutilá-lo quebra a auditoria. Só a string INTEIRA nesse formato é poupada.
  if (typeof v === "string") return SHA256_HEX.test(v) ? v : v.replace(PAN, MASK);
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
