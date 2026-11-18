// Asaas falso em memória, sem rede: `fetch` injetável (testes unitários) e reaproveitado pelo servidor do smoke
// (e2e/fakes/asaas-server.ts). Sem espera real. Não importa nada de src/.
export interface FakePayment {
  id: string;
  status: string;
  value: number;
  externalReference: string | null;
  customer: string;
  billingType: string;
  dueDate: string;
  [k: string]: unknown;
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

// Contador global: ids únicos entre instâncias (o banco de teste é compartilhado e provider_id é único).
let seq = 0;

export function createFakeAsaas(opts: { apiKey?: string } = {}) {
  const apiKey = opts.apiKey ?? "test-key-123456";
  const payments = new Map<string, FakePayment>();
  const customers = new Map<string, Record<string, unknown>>();
  const calls: FakeCall[] = [];
  // Erros programados: "METHOD /path" (prefixo) -> resposta de erro.
  const failures = new Map<string, { status: number; description: string }>();

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, description: string, code = "invalid_action") => json(status, { errors: [{ code, description }] });

  async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^.*\/v3(?=\/)/, "").replace(/^\/fake-asaas/, "");
    const raw = req.method === "GET" ? "" : await req.text();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    calls.push({ method: req.method, path, body, headers: req.headers });

    if (req.headers.get("access_token") !== apiKey) return err(401, "A chave de API fornecida é inválida", "invalid_access_token");
    const key = `${req.method} ${path}`;
    for (const [prefix, f] of failures) if (key.startsWith(prefix)) return err(f.status, f.description);

    if (key === "GET /finance/balance") return json(200, { balance: 123.45 });

    if (key === "POST /customers") {
      for (const f of ["name", "email", "cpfCnpj"]) if (!body?.[f]) return err(400, `O campo ${f} é obrigatório`);
      const id = `cus_${String(++seq).padStart(6, "0")}`;
      customers.set(id, { id, ...body });
      return json(200, { id, object: "customer", ...body });
    }

    if (key === "POST /payments") {
      if (!customers.has(String(body?.customer))) return err(400, "Customer inválido ou não informado");
      if (typeof body?.value !== "number" || body.value <= 0) return err(400, "Valor inválido");
      const id = `pay_${String(++seq).padStart(6, "0")}`;
      const p: FakePayment = {
        id,
        status: "PENDING",
        value: body.value,
        externalReference: (body.externalReference as string) ?? null,
        customer: String(body.customer),
        billingType: String(body.billingType),
        dueDate: String(body.dueDate ?? ""),
      };
      payments.set(id, p);
      return json(200, { object: "payment", ...p });
    }

    const m = /^(GET|POST) \/payments\/([^/]+)(\/pixQrCode|\/refund)?$/.exec(key);
    if (m) {
      const p = payments.get(decodeURIComponent(m[2]!));
      if (!p) return err(404, "Cobrança não encontrada", "not_found");
      if (m[1] === "GET" && !m[3]) return json(200, { object: "payment", ...p });
      if (m[1] === "GET" && m[3] === "/pixQrCode") {
        return json(200, { success: true, encodedImage: png, payload: `00020126fake${p.id}`, expirationDate: "2099-12-31 23:59:59" });
      }
      if (m[1] === "POST" && m[3] === "/refund") {
        if (p.status !== "RECEIVED" && p.status !== "CONFIRMED") return err(400, "Cobrança não pode ser estornada");
        p.status = "REFUNDED";
        return json(200, { object: "payment", ...p });
      }
    }
    return err(404, `Rota não encontrada: ${key}`, "not_found");
  }

  return {
    fetch: fakeFetch as typeof fetch,
    apiKey,
    payments,
    customers,
    calls,
    /** Muda o estado "real" da cobrança no Asaas (o que a reconsulta devolve). */
    setStatus(id: string, status: string) {
      const p = payments.get(id);
      if (!p) throw new Error(`cobrança desconhecida: ${id}`);
      p.status = status;
    },
    setValue(id: string, value: number) {
      const p = payments.get(id);
      if (!p) throw new Error(`cobrança desconhecida: ${id}`);
      p.value = value;
    },
    fail(prefix: string, status: number, description: string) {
      failures.set(prefix, { status, description });
    },
    clearFailures: () => failures.clear(),
  };
}
export type FakeAsaas = ReturnType<typeof createFakeAsaas>;
