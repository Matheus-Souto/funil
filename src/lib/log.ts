const SENSITIVE_KEY = /^(number|ccv|cvv|cardNumber|creditCard|expiryMonth|expiryYear|card)$/i;
// 13+ dígitos separados por qualquer espaço (inclui tab, NBSP, quebra de linha), ponto ou hífen. Corridas longas são removidas inteiras.
const PAN = /\d(?:[\s.-]*\d){12,}/g;
const MASK = "[redacted]";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HASH_KEY = /hash$/i;

function walk(v: unknown, seen: WeakSet<object>): unknown {
  if (typeof v === "string") return v.replace(PAN, MASK);
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (seen.has(v)) return "[circular]";
  seen.add(v);
  if (v instanceof Error) return { name: v.name, message: walk(v.message, seen) };
  if (Array.isArray(v)) return v.map((x) => walk(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (SENSITIVE_KEY.test(k)) out[k] = MASK;
    // Digest sha256 hex (emailHash, toHash, tokenHash) tem 13+ dígitos seguidos em ~11% dos casos e não é PAN: poupado
    // SÓ sob uma chave *Hash, com o valor inteiro no formato. Formato sozinho não basta (PAN repetido também tem 64
    // caracteres hex); em qualquer outra chave o valor é texto comum e passa pela máscara.
    else if (HASH_KEY.test(k) && typeof val === "string" && SHA256_HEX.test(val)) out[k] = val;
    else out[k] = walk(val, seen);
  }
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
