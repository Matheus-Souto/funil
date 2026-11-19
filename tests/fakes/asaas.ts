// Asaas falso em memória, sem rede: `fetch` injetável (testes unitários) e reaproveitado pelo servidor do smoke
// (e2e/fakes/asaas-server.ts). Sem espera real. Não importa nada de src/.
import { createHash } from "node:crypto";

export interface FakePayment {
  id: string;
  status: string;
  value: number;
  externalReference: string | null;
  customer: string;
  billingType: string;
  dueDate: string;
  deleted?: boolean;
  [k: string]: unknown;
}

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

// Contador global: ids únicos entre instâncias (o banco de teste é compartilhado e provider_id é único).
let seq = 0;

/** Cartões de teste do sandbox do Asaas que simulam recusa (qualquer outro número é aprovado). */
export const DECLINED_CARDS = ["5184019740373151", "4916561358240741"];
const CARD_HOLDER_FIELDS = ["name", "email", "cpfCnpj", "postalCode", "addressNumber", "phone"];

export interface FakeInstallment {
  id: string;
  value: number;
  paymentValue: number;
  installmentCount: number;
  payments: string[];
}

export function createFakeAsaas(opts: { apiKey?: string; walletId?: string | null } = {}) {
  const apiKey = opts.apiKey ?? "test-key-123456";
  // Conta do Asaas (GET /wallets/). `null`: a conta não devolve carteira (lista vazia).
  // Padrão: derivado da chave (mesma chave = mesma conta), sem conter a chave.
  const walletId = opts.walletId === undefined ? `wal_${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}` : opts.walletId;
  const payments = new Map<string, FakePayment>();
  const customers = new Map<string, Record<string, unknown>>();
  const installments = new Map<string, FakeInstallment>();
  const calls: FakeCall[] = [];
  // "immediate": o estorno conclui na hora (status REFUNDED + refunds[DONE]). "pending": a cobrança continua paga e
  // ganha refunds[PENDING]; `setRefundStatus` depois leva a DONE ou CANCELLED (como o Asaas faz com cartão).
  let refundMode: "immediate" | "pending" = "immediate";
  const cents = (reais: number) => Math.round(reais * 100);
  const refundsOf = (p: FakePayment) => (Array.isArray(p.refunds) ? (p.refunds as { status: string; value: number }[]) : []);
  /** Quanto já foi estornado (DONE) da cobrança, em centavos. */
  const refundedCents = (p: FakePayment) => refundsOf(p).reduce((n, r) => n + (r.status === "DONE" ? cents(r.value) : 0), 0);
  /** Estorno total (`value` omitido: o que falta) ou parcial (`value` em reais). A cobrança só vira REFUNDED quando a soma cobre o valor. */
  const applyRefund = (p: FakePayment, value?: number) => {
    const list = refundsOf(p);
    const amount = value ?? (cents(p.value) - refundedCents(p)) / 100;
    if (refundMode === "immediate") {
      p.refunds = [...list, { status: "DONE", value: amount }];
      if (refundedCents(p) >= cents(p.value)) p.status = "REFUNDED";
    } else {
      p.refunds = [...list, { status: "PENDING", value: amount }];
    }
  };
  // "METHOD /path" (prefixo): processa normalmente e depois perde a resposta (simula timeout com efeito no Asaas).
  const lost = new Set<string>();
  // Erros programados: "METHOD /path" (prefixo) -> resposta de erro.
  const failures = new Map<string, { status: number; description: string; code?: string }>();

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, description: string, code = "invalid_action") => json(status, { errors: [{ code, description }] });

  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/v3(?=\/)/, "").replace(/^\/fake-asaas/, "");
    const raw = req.method === "GET" ? "" : await req.text();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    calls.push({ method: req.method, path, query: url.searchParams, body, headers: req.headers });

    if (req.headers.get("access_token") !== apiKey) return err(401, "A chave de API fornecida é inválida", "invalid_access_token");
    const key = `${req.method} ${path}`;
    // Falhas programadas casam por prefixo de "METHOD /path?query" (ex.: "GET /payments?" só pega a listagem).
    const full = `${key}${url.search}`;
    for (const [prefix, f] of failures) if (full.startsWith(prefix)) return err(f.status, f.description, f.code);
    const res = await handle(key, body, url.searchParams);
    for (const prefix of lost) if (full.startsWith(prefix)) throw new TypeError("fetch failed");
    return res;
  }

  async function handle(key: string, body: Record<string, unknown> | undefined, query: URLSearchParams): Promise<Response> {
    if (key === "GET /payments") {
      const ref = query.get("externalReference");
      const data = [...payments.values()].filter((p) => !p.deleted && (ref === null || p.externalReference === ref));
      return json(200, { object: "list", hasMore: false, totalCount: data.length, limit: 100, offset: 0, data });
    }


    if (key === "GET /finance/balance") return json(200, { balance: 123.45 });

    if (key === "GET /wallets/" || key === "GET /wallets") {
      const data = walletId ? [{ object: "wallet", id: walletId, walletId, status: "ACTIVE" }] : [];
      return json(200, { object: "list", hasMore: false, totalCount: data.length, limit: 10, offset: 0, data });
    }

    if (key === "POST /customers") {
      for (const f of ["name", "email", "cpfCnpj"]) if (!body?.[f]) return err(400, `O campo ${f} é obrigatório`);
      const id = `cus_${String(++seq).padStart(6, "0")}`;
      customers.set(id, { id, ...body });
      return json(200, { id, object: "customer", ...body });
    }

    if (key === "POST /payments") {
      if (!customers.has(String(body?.customer))) return err(400, "Customer inválido ou não informado");
      const count = typeof body?.installmentCount === "number" ? body.installmentCount : 1;
      const total = count > 1 ? body?.totalValue : body?.value;
      if (typeof total !== "number" || total <= 0) return err(400, "Valor inválido");
      const card = body?.billingType === "CREDIT_CARD";
      if (card) {
        const cc = body?.creditCard as Record<string, unknown> | undefined;
        const holder = body?.creditCardHolderInfo as Record<string, unknown> | undefined;
        for (const f of ["holderName", "number", "expiryMonth", "expiryYear", "ccv"]) if (!cc?.[f]) return err(400, `creditCard.${f} obrigatório`);
        for (const f of CARD_HOLDER_FIELDS) if (!holder?.[f]) return err(400, `creditCardHolderInfo.${f} obrigatório`);
        if (!body?.remoteIp) return err(400, "remoteIp obrigatório");
        // Como o Asaas real às vezes faz: a descrição do erro ecoa dados enviados.
        if (DECLINED_CARDS.includes(String(cc?.number))) {
          return err(400, `Transação não autorizada. Cartão ${String(cc?.number)} cvv ${String(cc?.ccv)}`, "invalid_creditCard");
        }
      }
      const base = {
        status: card ? "CONFIRMED" : "PENDING",
        externalReference: (body?.externalReference as string) ?? null,
        customer: String(body?.customer),
        billingType: String(body?.billingType),
        dueDate: String(body?.dueDate ?? ""),
      };
      if (count <= 1) {
        const id = `pay_${String(++seq).padStart(6, "0")}`;
        const p: FakePayment = { id, value: total, ...base };
        payments.set(id, p);
        return json(200, { object: "payment", ...p });
      }
      // Parcelado (totalValue): uma cobrança por parcela; a diferença de arredondamento vai na última.
      const instId = `ins_${String(++seq).padStart(6, "0")}`;
      const cents = Math.round(total * 100);
      const each = Math.floor(cents / count);
      const inst: FakeInstallment = { id: instId, value: total, paymentValue: each / 100, installmentCount: count, payments: [] };
      for (let n = 1; n <= count; n++) {
        const id = `pay_${String(++seq).padStart(6, "0")}`;
        const v = n === count ? cents - each * (count - 1) : each;
        payments.set(id, { id, value: v / 100, installment: instId, installmentNumber: n, ...base });
        inst.payments.push(id);
      }
      installments.set(instId, inst);
      return json(200, { object: "payment", ...payments.get(inst.payments[0]!)! });
    }

    const im = /^(GET|POST) \/installments\/([^/]+)(\/refund)?$/.exec(key);
    if (im) {
      const inst = installments.get(decodeURIComponent(im[2]!));
      if (!inst) return err(404, "Parcelamento não encontrado", "not_found");
      if (im[1] === "GET" && !im[3]) return json(200, { object: "installment", ...inst });
      if (im[1] === "POST" && im[3]) {
        for (const id of inst.payments) applyRefund(payments.get(id)!);
        return json(200, { object: "installment", ...inst, status: refundMode === "immediate" ? "REFUNDED" : "RECEIVED" });
      }
    }

    const m = /^(GET|POST|DELETE) \/payments\/([^/]+)(\/pixQrCode|\/refund)?$/.exec(key);
    if (m) {
      const p = payments.get(decodeURIComponent(m[2]!));
      if (!p) return err(404, "Cobrança não encontrada", "not_found");
      if (m[1] === "DELETE" && !m[3]) {
        p.deleted = true;
        return json(200, { deleted: true, id: p.id });
      }
      if (m[1] === "GET" && !m[3]) return json(200, { object: "payment", ...p });
      if (m[1] === "GET" && m[3] === "/pixQrCode") {
        return json(200, { success: true, encodedImage: png, payload: `00020126fake${p.id}`, expirationDate: "2099-12-31 23:59:59" });
      }
      if (m[1] === "POST" && m[3] === "/refund") {
        if (p.status !== "RECEIVED" && p.status !== "CONFIRMED") return err(400, "Cobrança não pode ser estornada");
        const value = typeof body?.value === "number" ? body.value : undefined;
        if (value !== undefined && (value <= 0 || cents(value) > cents(p.value) - refundedCents(p))) {
          return err(400, "Valor do estorno maior que o disponível", "invalid_value");
        }
        applyRefund(p, value);
        return json(200, { object: "payment", ...p });
      }
    }
    return err(404, `Rota não encontrada: ${key}`, "not_found");
  }

  return {
    fetch: fakeFetch as typeof fetch,
    apiKey,
    walletId,
    payments,
    customers,
    installments,
    calls,
    /** Muda o estado "real" da cobrança no Asaas (o que a reconsulta devolve). */
    setStatus(id: string, status: string) {
      const p = payments.get(id);
      if (!p) throw new Error(`cobrança desconhecida: ${id}`);
      p.status = status;
    },
    setRefundMode(mode: "immediate" | "pending") {
      refundMode = mode;
    },
    /** Muda o status do último estorno da cobrança (PENDING -> DONE/CANCELLED); a cobrança em si não muda. */
    setRefundStatus(id: string, status: string) {
      const p = payments.get(id);
      const list = p && Array.isArray(p.refunds) ? (p.refunds as { status: string }[]) : [];
      if (list.length === 0) throw new Error(`cobrança sem estorno: ${id}`);
      list[list.length - 1]!.status = status;
    },
    /** Estorno parcial feito por fora (painel do Asaas): refunds[DONE] com `value` (reais); a cobrança continua paga. */
    partialRefund(id: string, value: number) {
      const p = payments.get(id);
      if (!p) throw new Error(`cobrança desconhecida: ${id}`);
      p.refunds = [...refundsOf(p), { status: "DONE", value }];
    },
    setValue(id: string, value: number) {
      const p = payments.get(id);
      if (!p) throw new Error(`cobrança desconhecida: ${id}`);
      p.value = value;
    },
    /** Erro programado; `code` padrão "invalid_action" (recusa de cartão real: "invalid_creditCard"). */
    fail(prefix: string, status: number, description: string, code?: string) {
      failures.set(prefix, { status, description, code });
    },
    clearFailures: () => {
      failures.clear();
      lost.clear();
    },
    /** A chamada tem efeito no Asaas, mas a resposta se perde (erro de rede no cliente). */
    loseResponse(prefix: string) {
      lost.add(prefix);
    },
  };
}
export type FakeAsaas = ReturnType<typeof createFakeAsaas>;
