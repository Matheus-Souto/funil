const SENSITIVE_KEY = /^(number|ccv|cvv|cardNumber|creditCard|expiryMonth|expiryYear|card)$/i;
// 13+ dígitos separados por qualquer espaço (inclui tab, NBSP, quebra de linha), ponto ou hífen. Corridas longas são removidas inteiras.
const PAN = /\d(?:[\s.-]*\d){12,}/g;
const MASK = "[redacted]";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HASH_KEY = /hash$/i;
// UUID (RFC 9562: versão 1-8, variante 8-b) com ao menos uma letra hex: um id aleatório só de dígitos tem chance
// ~1e-6; um "UUID" só de dígitos é tratado como texto comum. Chave de id: `id` ou terminada em `Id` (orderId, storeId).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_KEY = /^(id|.*Id)$/;
const HAS_HEX_LETTER = /[a-f]/i;

const QUERY_FAILED = "falha na consulta ao banco";

/** Código SQLSTATE (5 caracteres) de um erro do Postgres, se houver. */
function sqlState(v: unknown): string | null {
  const code = (v as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * Erro de consulta ao banco: DrizzleQueryError (mensagem com a SQL e os `params` — CPF, e-mail, nome...) ou erro do
 * Postgres (mensagem e `detail` podem ecoar valores). Nunca vai para log, auditoria ou fila como veio.
 */
function queryErrorCode(v: unknown): string | null | undefined {
  if (!(v instanceof Error)) return undefined;
  const e = v as Error & { params?: unknown; query?: unknown; cause?: unknown; severity?: unknown };
  if (Array.isArray(e.params) || typeof e.query === "string") return sqlState(e.cause) ?? sqlState(e);
  if (typeof e.severity === "string" && sqlState(e)) return sqlState(e);
  return undefined;
}

/**
 * Mensagem de erro segura para log, auditoria e `job.last_error`: erro de consulta ao banco vira só o código do
 * Postgres + texto genérico; os demais passam pela máscara de cartão.
 */
export function safeErrorMessage(e: unknown): string {
  const code = queryErrorCode(e);
  if (code !== undefined) return code ? `${QUERY_FAILED} (${code})` : QUERY_FAILED;
  return String(walk(e instanceof Error ? e.message : String(e), new WeakSet()));
}

const IDENT = /^[A-Za-z0-9_.:-]{1,64}$/;
const ident = (v: unknown): string | undefined => (typeof v === "string" && IDENT.test(v) ? v : undefined);

/**
 * Identificação de um erro para log quando a mensagem pode trazer dados do comprador (nome impresso, CVV, validade:
 * a máscara só reconhece PAN). Nunca inclui texto livre do erro:
 * - consulta ao banco (drizzle/Postgres, inclusive pelo `cause`): nome e SQLSTATE (ou o `code` da causa, ex. rede);
 * - `ActionError` nosso: code, mensagem e `details.status`; `provider_error` (erro de um provedor, ex. o Asaas, cuja
 *   descrição pode ecoar o que foi enviado): só code e `details.status`, nunca a mensagem;
 * - demais: nome, `code` e `cause.code` (ECONNRESET, ETIMEDOUT...).
 * Nome e códigos só entram com formato de identificador.
 */
export function errorFields(e: unknown): Record<string, string | number> {
  // Classes que não definem `name` (ex.: DrizzleQueryError) ficam com "Error": vale o nome da classe.
  const name = e instanceof Error ? (e.name === "Error" ? ident(e.constructor?.name) : ident(e.name)) : typeof e;
  const out: Record<string, string | number> = { errorName: name ?? "Error" };
  const obj = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; cause?: unknown; details?: unknown; message?: unknown };
  const causeCode = ident((obj.cause as { code?: unknown } | null | undefined)?.code);
  const query = queryErrorCode(e);
  if (query !== undefined) {
    if (query) out.sqlState = query;
    else if (causeCode) out.causeCode = causeCode;
    return out;
  }
  if (e instanceof Error && e.name === "ActionError" && ident(obj.code)) {
    out.errorCode = obj.code as string;
    if (obj.code !== "provider_error") out.errorMessage = e.message.slice(0, 200);
    const status = (obj.details as { status?: unknown } | null | undefined)?.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 999) out.status = status;
    return out;
  }
  const code = ident(obj.code);
  if (code) out.errorCode = code;
  if (causeCode) out.causeCode = causeCode;
  return out;
}

function walk(v: unknown, seen: WeakSet<object>): unknown {
  if (typeof v === "string") return v.replace(PAN, MASK);
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (seen.has(v)) return "[circular]";
  seen.add(v);
  const query = queryErrorCode(v);
  if (query !== undefined) return { name: "DatabaseError", ...(query ? { code: query } : {}), message: QUERY_FAILED };
  if (v instanceof Error) return { name: v.name, message: walk(v.message, seen) };
  if (Array.isArray(v)) return v.map((x) => walk(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (SENSITIVE_KEY.test(k)) out[k] = MASK;
    // Digest sha256 hex (emailHash, toHash, tokenHash) tem 13+ dígitos seguidos em ~11% dos casos e não é PAN: poupado
    // SÓ sob uma chave *Hash, com o valor inteiro no formato. Formato sozinho não basta (PAN repetido também tem 64
    // caracteres hex); em qualquer outra chave o valor é texto comum e passa pela máscara.
    else if (HASH_KEY.test(k) && typeof val === "string" && SHA256_HEX.test(val)) out[k] = val;
    // UUID de id (orderId, storeId...): ~2% dos UUIDs aleatórios têm 13+ dígitos entre hífens e a máscara os
    // corrompia (auditoria sem `input.orderId` legível, logs com ids quebrados). Poupado SÓ sob chave de id, com o valor
    // inteiro no formato e ao menos uma letra hex; em texto livre ou outra chave continua mascarado.
    else if (ID_KEY.test(k) && typeof val === "string" && UUID.test(val) && HAS_HEX_LETTER.test(val)) out[k] = val;
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
