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
  value: number;
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

function baseUrl(e: AsaasEnv): string {
  return (appEnv.ASAAS_BASE_URL ?? BASE_URLS[e]).replace(/\/+$/, "");
}

function providerError(message: string, details?: unknown): ActionError {
  return new ActionError("provider_error", String(redact(message)).slice(0, MAX_MESSAGE), details);
}

function errorMessage(status: number, body: unknown): string {
  const errors = (body as { errors?: { description?: string }[] } | null)?.errors;
  const text = Array.isArray(errors) ? errors.map((e) => e?.description).filter(Boolean).join("; ") : "";
  return text || `Asaas respondeu ${status}`;
}

export function createAsaasClient(opts: { apiKey: string; env: AsaasEnv; fetch?: typeof fetch }) {
  const doFetch = opts.fetch ?? asaasFetchOverride ?? fetch;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
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
      throw providerError("Não foi possível falar com o Asaas");
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* corpo vazio ou não JSON */
    }
    if (!res.ok) throw providerError(errorMessage(res.status, json), { status: res.status });
    if (json === null || typeof json !== "object") throw providerError("Resposta inválida do Asaas");
    return json as T;
  }

  return {
    createCustomer: (c: { name: string; email: string; cpfCnpj: string; mobilePhone: string; externalReference: string }) =>
      call<{ id: string }>("POST", "/customers", c),
    createPayment: (body: CreatePaymentBody, o: { timeoutMs?: number } = {}) =>
      call<AsaasPayment>("POST", "/payments", body, o.timeoutMs),
    getPayment: (id: string) => call<AsaasPayment>("GET", `/payments/${encodeURIComponent(id)}`),
    getPixQrCode: (id: string) =>
      call<{ encodedImage: string; payload: string; expirationDate: string }>("GET", `/payments/${encodeURIComponent(id)}/pixQrCode`),
    refundPayment: (id: string) => call<AsaasPayment>("POST", `/payments/${encodeURIComponent(id)}/refund`, {}),
    getBalance: () => call<{ balance: number }>("GET", "/finance/balance"),
  };
}
export type AsaasClient = ReturnType<typeof createAsaasClient>;

let asaasFetchOverride: typeof fetch | undefined;
/** Só para testes: todos os clientes criados depois usam este fetch. Sem argumento, volta ao padrão. */
export function setAsaasFetchForTests(f?: typeof fetch): void {
  asaasFetchOverride = f;
}

/** Cliente da conexão `asaas` da loja. `conflict` se a loja não conectou o Asaas. */
export async function asaasClientFor(tx: Tx, storeId: string): Promise<AsaasClient> {
  const conn = await getIntegration(tx, storeId, "asaas");
  if (!conn?.secret) throw new ActionError("conflict", "Asaas não está conectado nesta loja");
  const e = (conn.config as { env?: AsaasEnv }).env === "production" ? "production" : "sandbox";
  return createAsaasClient({ apiKey: conn.secret, env: e });
}
