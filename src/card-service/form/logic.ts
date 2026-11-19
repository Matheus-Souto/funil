// Lógica pura do formulário do cartão no iframe: validação, máscaras, chave de idempotência, corpo do POST /api/card,
// parcelas e a tradução da resposta do servidor para o `result` do protocolo. Sem DOM e sem imports do servidor: vai
// no bundle do navegador (form.js). Rótulos e mensagens são os do checkout de hoje (src/app/c/[slug]/checkout-form.tsx).
import {
  CARD_FORM_FIELDS,
  CARD_GENERIC_MESSAGE,
  RESULT_FIELDS,
  fieldsMessage as protocolFieldsMessage,
  randomUuid,
  type FrameMsg,
  type ResultStatus,
} from "@/lib/card-frame/protocol";
import { brl } from "@/lib/format";
import { cardExpiryValid, onlyDigits, validCpf } from "@/lib/validation/br";
import { luhnValid, SANDBOX_TEST_CARD } from "@/lib/validation/card-number";

/** Valores dos campos como estão na tela (com máscara). */
export interface CardFields {
  cardNumber: string;
  holderName: string;
  expiry: string;
  cvv: string;
  holderCpf: string;
  cep: string;
  addressNumber: string;
}

/** Campos do formulário do iframe, na ordem da tela (lista única em protocol.ts). */
export const FIELD_NAMES = CARD_FORM_FIELDS;
export type FieldName = (typeof FIELD_NAMES)[number];
/**
 * Os únicos nomes que saem em `result.fields`: os do iframe mais os do comprador (campos do app: `name`, `email`,
 * `phone`, `cpf`). Com "titular é outra pessoa" desligado, o CPF do titular é o do comprador e sai como `cpf`.
 */
export const RESULT_FIELD_NAMES = RESULT_FIELDS;
export type ResultFieldName = (typeof RESULT_FIELD_NAMES)[number];

export const NETWORK_MESSAGE = "Sem conexão. Confira a internet e toque em pagar de novo.";
export const GENERIC_MESSAGE = CARD_GENERIC_MESSAGE;
/** Mensagem genérica do servidor para erro de campos: o checkout troca pela contagem de campos marcados. */
const SERVER_FIELDS_MESSAGE = "Dados de pagamento inválidos";
const MAX_MESSAGE = 300; // teto do protocolo (parseFrameMsg)

// ---- máscaras (iguais às do checkout) ----
export const maskCard = (v: string): string =>
  onlyDigits(v)
    .slice(0, 19)
    .replace(/(\d{4})(?=\d)/g, "$1 ");
export const maskExpiry = (v: string): string => {
  const d = onlyDigits(v).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};
export const maskCvv = (v: string): string => onlyDigits(v).slice(0, 4);
export const maskCpf = (v: string): string => {
  const d = onlyDigits(v).slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, "$1.$2").replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
};
export const maskCep = (v: string): string => {
  const d = onlyDigits(v).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
};
export const maskHolderName = (v: string): string => v.toUpperCase();

/** Erros por campo, com as mensagens do checkout, na ordem do formulário. */
export function fieldErrors(v: CardFields, holderOther: boolean, now: Date = new Date()): Partial<Record<FieldName, string>> {
  const e: Partial<Record<FieldName, string>> = {};
  const num = onlyDigits(v.cardNumber);
  // O cartão de teste do sandbox falha no Luhn: passa aqui e o servidor decide (só a conexão sandbox o aceita).
  if (num.length < 13 || num.length > 19 || (!luhnValid(num) && num !== SANDBOX_TEST_CARD)) e.cardNumber = "Confira o número do cartão.";
  if (v.holderName.trim().length < 2) e.holderName = "Informe o nome como está no cartão.";
  const [mm, yy] = v.expiry.split("/");
  if (!mm || !yy || !cardExpiryValid(mm, yy, now)) {
    e.expiry = mm && yy && /^\d{2}$/.test(yy) && Number(mm) >= 1 && Number(mm) <= 12 ? "Cartão vencido." : "Use o formato MM/AA.";
  }
  if (!/^\d{3,4}$/.test(v.cvv)) e.cvv = "3 ou 4 números no verso.";
  if (holderOther && !validCpf(onlyDigits(v.holderCpf))) e.holderCpf = "CPF do titular inválido.";
  if (onlyDigits(v.cep).length !== 8) e.cep = "Confira o CEP.";
  if (!v.addressNumber.trim()) e.addressNumber = "Informe o número.";
  return e;
}

/** Nomes dos campos com erro, na ordem do formulário. */
export function validateCardFields(v: CardFields, holderOther: boolean, now: Date = new Date()): string[] {
  const e = fieldErrors(v, holderOther, now);
  return FIELD_NAMES.filter((k) => e[k] !== undefined);
}

/** Mensagem geral do checkout para N campos marcados. */
export const fieldsMessage = protocolFieldsMessage;

/** Filtra para os nomes conhecidos de `result.fields`, sem repetir, na ordem recebida. */
export function safeFieldNames(names: readonly unknown[]): ResultFieldName[] {
  const out: ResultFieldName[] = [];
  for (const n of names) {
    if (typeof n === "string" && (RESULT_FIELD_NAMES as readonly string[]).includes(n) && !out.includes(n as ResultFieldName)) out.push(n as ResultFieldName);
  }
  return out;
}

/** Caminho de erro do servidor (zod / payWithCard) -> campo do formulário do iframe (`holder.cpf`: ver `fieldFromPath`). */
const PATHS: Record<string, ResultFieldName> = {
  // Dados do comprador recusados pelo servidor (ex.: celular que o Asaas não aceita): campos do app, que os marca.
  "customer.name": "name",
  "customer.email": "email",
  "customer.phone": "phone",
  "customer.cpf": "cpf",
  "card.number": "cardNumber",
  "card.holderName": "holderName",
  "card.expiryMonth": "expiry",
  "card.expiryYear": "expiry",
  "card.ccv": "cvv",
  "holder.postalCode": "cep",
  "holder.addressNumber": "addressNumber",
  installments: "installments",
};
/** `holder.cpf` vira `holderCpf` com "titular é outra pessoa" ligado e `cpf` (o do comprador, no app) com ele desligado. */
export function fieldFromPath(path: unknown, holderOther: boolean): ResultFieldName | null {
  if (!Array.isArray(path) || !path.every((p) => typeof p === "string" || typeof p === "number")) return null;
  const key = path.join(".");
  if (key === "holder.cpf") return holderOther ? "holderCpf" : "cpf";
  return Object.prototype.hasOwnProperty.call(PATHS, key) ? PATHS[key]! : null;
}

/** Mensagem do campo para um erro vindo do servidor (a mesma do checkout). */
export const serverFieldMessage = (f: FieldName): string => (f === "expiry" ? "Cartão vencido ou validade inválida." : "Confira este campo.");

/**
 * Assinatura da tentativa: muda quando muda qualquer dado enviado (pedido, cartão, parcelas, titular). É um resumo
 * (hash de 53 bits), não o cartão: fica guardada só enquanto a chave precisa sobreviver a uma queda de rede.
 */
export function attemptSig(orderPublicId: string, v: CardFields, holderOther: boolean, installments: number): string {
  const s = JSON.stringify([
    orderPublicId,
    onlyDigits(v.cardNumber),
    v.holderName.trim(),
    v.expiry,
    v.cvv,
    holderOther ? onlyDigits(v.holderCpf) : null,
    onlyDigits(v.cep),
    v.addressNumber.trim(),
    installments,
  ]);
  // cyrb53 (domínio público): resumo rápido, não criptográfico, só para comparar.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Chave de idempotência: a mesma para a mesma assinatura (rede caiu no meio), nova se qualquer dado mudou. */
export function attemptKey(prev: { key: string; sig: string } | null, sig: string, newKey: () => string): { key: string; sig: string } {
  return prev !== null && prev.sig === sig ? prev : { key: newKey(), sig };
}

export interface CardBody {
  ticket: string;
  orderPublicId: string;
  idempotencyKey: string;
  installments: number;
  card: { holderName: string; number: string; expiryMonth: string; expiryYear: string; ccv: string };
  holder: { cpf: string; postalCode: string; addressNumber: string };
  turnstileToken?: string;
}

/** Corpo do POST /api/card. Sem "titular é outra pessoa", o CPF do titular é o do comprador (vem no `pay`). */
export function buildCardBody(
  v: CardFields,
  holderOther: boolean,
  buyerCpf: string | null,
  installments: number,
  ticket: string,
  orderPublicId: string,
  key: string,
  turnstileToken?: string,
): CardBody {
  const [mm = "", yy = ""] = v.expiry.split("/");
  return {
    ticket,
    orderPublicId,
    idempotencyKey: key,
    installments,
    card: { holderName: v.holderName.trim(), number: onlyDigits(v.cardNumber), expiryMonth: mm, expiryYear: yy, ccv: v.cvv },
    holder: { cpf: onlyDigits(holderOther ? v.holderCpf : (buyerCpf ?? "")), postalCode: onlyDigits(v.cep), addressNumber: v.addressNumber.trim() },
    ...(turnstileToken ? { turnstileToken } : {}),
  };
}

/** Opções do seletor de parcelas, com os rótulos do checkout (1 a 12). */
export function installmentOptions(totalCents: number, max: number): { n: number; label: string }[] {
  const top = Math.min(12, Math.max(1, Math.trunc(max)));
  return Array.from({ length: top }, (_, i) => {
    const n = i + 1;
    return { n, label: n === 1 ? `1x de ${brl(totalCents)} sem juros` : `${n}x (total ${brl(totalCents)})` };
  });
}

export type ResultBody = Omit<Extract<FrameMsg, { t: "funil-card:result" }>, "t" | "id">;

const own = (o: unknown, k: string): unknown =>
  typeof o === "object" && o !== null && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;
const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, MAX_MESSAGE) : undefined);
const PAID_STATUSES: readonly string[] = ["approved", "declined", "unknown", "unavailable"];

/** Resposta do POST /api/card -> corpo do `result` (sem dados do cartão; os 4 últimos só na recusa). */
export function mapApiResponse(httpStatus: number, body: unknown, last4: string, holderOther: boolean): ResultBody {
  const message = text(own(body, "message"));
  if (httpStatus === 200) {
    const status = own(body, "status");
    if (typeof status === "string" && PAID_STATUSES.includes(status)) {
      return { status: status as ResultStatus, ...(message ? { message } : {}), ...(status === "declined" ? { last4 } : {}) };
    }
    return { status: "error", message: GENERIC_MESSAGE };
  }
  if (httpStatus === 403 && own(body, "error") === "ticket") {
    return { status: "error", ticketExpired: own(body, "ticketExpired") === true, message: GENERIC_MESSAGE };
  }
  const captcha = own(body, "captcha") === true ? { captcha: true } : {};
  const paths = own(body, "fields");
  if (httpStatus === 400 && Array.isArray(paths)) {
    const names = safeFieldNames(paths.map((p) => fieldFromPath(p, holderOther)));
    if (names.length > 0) {
      return { status: "error", message: !message || message === SERVER_FIELDS_MESSAGE ? fieldsMessage(names.length) : message, fields: names.map((n) => [n]), ...captcha };
    }
  }
  return { status: "error", ...captcha, message: message ?? GENERIC_MESSAGE };
}

/**
 * Total (centavos) e parcelas máximas que o app gravou no bilhete do pedido. Lê só o corpo (base64url de um JSON), sem
 * conferir a assinatura (a chave é do servidor, que confere de qualquer forma): serve para o iframe recusar pagar
 * quando o checkout mostrou ao comprador outro total. `null` para qualquer defeito.
 */
export function ticketTerms(ticket: string): { totalCents: number; maxInstallments: number } | null {
  const payload = ticket.split(".")[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const body = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4))) as unknown;
    const t = own(body, "t");
    const m = own(body, "m");
    const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
    if (!isInt(t, 1, 100_000_000) || !isInt(m, 1, 12)) return null;
    return { totalCents: t, maxInstallments: m };
  } catch {
    return null;
  }
}

/** Chave de idempotência (UUID v4; sem `randomUUID` antes do iOS 15.4). Implementação única em protocol.ts. */
export const newAttemptKey = randomUuid;

/**
 * O servidor pode ter cobrado nesta resposta? Só então o iframe trava o cartão que ficou nos campos para outro pedido
 * (o comprador precisa mexer no iframe). Não cobram: nada enviado (`httpStatus` null: validação local ou sem
 * resposta da rede), erro de campo (400), bilhete (403), limite/captcha (429) e `unavailable` (o Asaas recusou sem
 * processar). Cobram ou podem ter cobrado: `approved`, `declined`, `unknown`, qualquer outra resposta 200 e erro
 * inesperado do servidor (5xx).
 */
export function mayHaveCharged(httpStatus: number | null, out: ResultBody): boolean {
  if (httpStatus === null) return false;
  if (httpStatus === 400 || httpStatus === 403 || httpStatus === 429) return false;
  if (httpStatus === 200) return out.status !== "unavailable";
  return true;
}
