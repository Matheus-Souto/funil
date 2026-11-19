import { createHash } from "node:crypto";
import { ActionError } from "@/lib/actions/core";
import { env as appEnv } from "@/lib/env";
import { getIntegration } from "@/lib/integrations";
import type { Tx } from "@/lib/db/client";
import { redact } from "@/lib/log";

export type AsaasEnv = "sandbox" | "production";

export interface AsaasPayment {
  id: string;
  status: string;
  /** Em reais (decimal), como o Asaas devolve. Converta para centavos com `reaisToCents`. */
  value: number;
  externalReference?: string | null;
  customer?: string;
  billingType?: string;
  [k: string]: unknown;
}

export interface CreatePaymentBody {
  customer: string;
  billingType: "PIX" | "CREDIT_CARD";
  /** Cobrança à vista. Parcelado: omitir e usar `installmentCount` + `totalValue`. */
  value?: number;
  dueDate: string;
  externalReference: string;
  description?: string;
  [k: string]: unknown;
}

export const BASE_URLS: Record<AsaasEnv, string> = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};
const USER_AGENT = "funil/0.1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE = 300;

/** Conversão na borda: centavos inteiros -> reais do Asaas. */
export const centsToReais = (cents: number): number => cents / 100;
export const reaisToCents = (reais: number): number => Math.round(reais * 100);

const SP_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

/** `dueDate` do Asaas (YYYY-MM-DD): data do calendário de America/Sao_Paulo em `now`, mais `addDays`. */
export function asaasDueDate(now: Date = new Date(), addDays = 0): string {
  const [y, m, d] = SP_DATE.format(now).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + addDays)).toISOString().slice(0, 10);
}

/** Erro do cliente Asaas: `details.status` (0 = rede/timeout) e `details.errorCodes` (só códigos, nunca descrições). */
export interface AsaasErrorDetails {
  status: number;
  errorCodes: string[];
}

function baseUrl(e: AsaasEnv): string {
  return (appEnv.ASAAS_BASE_URL ?? BASE_URLS[e]).replace(/\/+$/, "");
}

function providerError(message: string, details?: unknown): ActionError {
  return new ActionError("provider_error", String(redact(message)).slice(0, MAX_MESSAGE), details);
}

function errorCodes(body: unknown): string[] {
  const errors = (body as { errors?: { code?: unknown }[] } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => (typeof e?.code === "string" ? e.code.replace(/[^\w.-]/g, "").slice(0, 64) : ""))
    .filter(Boolean)
    .slice(0, 5);
}

function errorMessage(status: number, body: unknown): string {
  const errors = (body as { errors?: { description?: string }[] } | null)?.errors;
  const text = Array.isArray(errors) ? errors.map((e) => e?.description).filter(Boolean).join("; ") : "";
  return text || `Asaas respondeu ${status}`;
}

export function createAsaasClient(opts: { apiKey: string; env: AsaasEnv; fetch?: typeof fetch }) {
  const doFetch = opts.fetch ?? asaasFetchOverride ?? fetch;

  /** `opaque`: nunca usa o texto de erro do Asaas na mensagem (cobranças com cartão: o texto pode ecoar dados do cartão). */
  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    opaque = false,
  ): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl(opts.env)}${path}`, {
        method,
        headers: {
          access_token: opts.apiKey,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Nunca repassa a mensagem da rede (pode incluir a URL ou o corpo).
      throw providerError("Não foi possível falar com o Asaas", { status: 0, errorCodes: [] } satisfies AsaasErrorDetails);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* corpo vazio ou não JSON */
    }
    if (!res.ok) {
      const details: AsaasErrorDetails = { status: res.status, errorCodes: errorCodes(json) };
      throw providerError(opaque ? `Asaas respondeu ${res.status}` : errorMessage(res.status, json), details);
    }
    if (json === null || typeof json !== "object") {
      throw providerError("Resposta inválida do Asaas", { status: res.status, errorCodes: [] } satisfies AsaasErrorDetails);
    }
    return json as T;
  }

  return {
    // notificationDisabled: o Asaas não manda e-mail/SMS ao comprador (a loja cuida da comunicação).
    createCustomer: (c: { name: string; email: string; cpfCnpj: string; mobilePhone: string; externalReference: string }) =>
      call<{ id: string }>("POST", "/customers", { ...c, notificationDisabled: true }),
    createPayment: (body: CreatePaymentBody, o: { timeoutMs?: number } = {}) =>
      call<AsaasPayment>("POST", "/payments", body, o.timeoutMs, body.billingType === "CREDIT_CARD"),
    getPayment: (id: string) => call<AsaasPayment>("GET", `/payments/${encodeURIComponent(id)}`),
    /** GET /payments?externalReference=… (até 100; um pedido nunca tem tantas cobranças). */
    listPaymentsByExternalReference: async (ref: string): Promise<AsaasPayment[]> => {
      const r = await call<{ data?: unknown }>("GET", `/payments?externalReference=${encodeURIComponent(ref)}&limit=100`);
      if (!Array.isArray(r.data)) throw providerError("Resposta inválida do Asaas", { status: 200, errorCodes: [] } satisfies AsaasErrorDetails);
      return r.data as AsaasPayment[];
    },
    /** GET /payments?installment=… : as parcelas (cobranças) de um parcelamento (até 12; limite 100 por folga). */
    listInstallmentPayments: async (installment: string): Promise<AsaasPayment[]> => {
      const r = await call<{ data?: unknown }>("GET", `/payments?installment=${encodeURIComponent(installment)}&limit=100`);
      if (!Array.isArray(r.data)) throw providerError("Resposta inválida do Asaas", { status: 200, errorCodes: [] } satisfies AsaasErrorDetails);
      return r.data as AsaasPayment[];
    },
    getPixQrCode: (id: string) =>
      call<{ encodedImage: string; payload: string; expirationDate: string }>("GET", `/payments/${encodeURIComponent(id)}/pixQrCode`),
    deletePayment: (id: string) => call<{ deleted: boolean }>("DELETE", `/payments/${encodeURIComponent(id)}`),
    /** Estorno total (sem `valueCents`) ou só de `valueCents` (o restante depois de um estorno parcial). */
    refundPayment: (id: string, valueCents?: number) =>
      call<AsaasPayment>("POST", `/payments/${encodeURIComponent(id)}/refund`, valueCents === undefined ? {} : { value: centsToReais(valueCents) }),
    /** Parcelamento: `value` é o total (reais), `paymentValue` o de cada parcela. */
    getInstallment: (id: string) =>
      call<{ id: string; value: number; installmentCount: number }>("GET", `/installments/${encodeURIComponent(id)}`),
    refundInstallment: (id: string) => call<{ id: string }>("POST", `/installments/${encodeURIComponent(id)}/refund`, {}),
    getBalance: () => call<{ balance: number }>("GET", "/finance/balance"),
    /** GET /wallets/: carteira(s) da conta autenticada (`walletId` identifica a conta). */
    getWallets: async (): Promise<{ id?: string; walletId?: string }[]> => {
      const r = await call<{ data?: unknown }>("GET", "/wallets/");
      if (!Array.isArray(r.data)) throw providerError("Resposta inválida do Asaas", { status: 200, errorCodes: [] } satisfies AsaasErrorDetails);
      return r.data as { id?: string; walletId?: string }[];
    },
  };
}
export type AsaasClient = ReturnType<typeof createAsaasClient>;

let asaasFetchOverride: typeof fetch | undefined;
/** Só para testes: todos os clientes criados depois usam este fetch. Sem argumento, volta ao padrão. */
export function setAsaasFetchForTests(f?: typeof fetch): void {
  asaasFetchOverride = f;
}

/**
 * Identifica a conta Asaas da chave (fora de transação): `<env>:wallet:<walletId>` (GET /wallets/). Se a conta não
 * devolver carteira, `<env>:key:<sha256 da chave, 32 hex>`. Ids do Asaas (clientes, cobranças) só valem nessa conta.
 */
export async function asaasAccountKey(client: AsaasClient, env: AsaasEnv, apiKey: string): Promise<string> {
  const [w] = await client.getWallets();
  const id = String(w?.walletId ?? w?.id ?? "").replace(/[^\w.-]/g, "").slice(0, 100);
  if (id) return `${env}:wallet:${id}`;
  return `${env}:key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 32)}`;
}

/**
 * Cliente da conexão `asaas` da loja e a conta (`accountKey`) em que ela foi salva (`null` em conexões antigas).
 * `conflict` se a loja não conectou o Asaas.
 */
export async function asaasConnectionFor(tx: Tx, storeId: string): Promise<{ client: AsaasClient; accountKey: string | null }> {
  const conn = await getIntegration(tx, storeId, "asaas");
  if (!conn?.secret) throw new ActionError("conflict", "Asaas não está conectado nesta loja");
  const cfg = conn.config as { env?: AsaasEnv; accountKey?: string };
  const e = cfg.env === "production" ? "production" : "sandbox";
  return { client: createAsaasClient({ apiKey: conn.secret, env: e }), accountKey: cfg.accountKey ?? null };
}

/** Cliente da conexão `asaas` da loja. `conflict` se a loja não conectou o Asaas. */
export async function asaasClientFor(tx: Tx, storeId: string): Promise<AsaasClient> {
  return (await asaasConnectionFor(tx, storeId)).client;
}
