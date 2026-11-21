// API de Conversões do Meta falsa (Graph API): usada pelos testes (como `fetch` injetado) e pelo smoke E2E
// (e2e/fakes/asaas-server.ts a serve em /meta). Só o que o app usa:
//   POST /<versão>/<pixelId>/events  { data, test_event_code? } -> { events_received }
//     Evento sem `event_time` -> 400, código 100, subcódigo 2804019 (como o Meta; o app usa isso para testar o token).
//   GET  /<versão>/<pixelId> -> 400 "(#100) Missing Permission": como o token padrão da API de Conversões (gerado no
//     Gerenciador de Eventos), que envia eventos mas não pode ler o Pixel.
// Pixel negado (`denyPixel`): o token não tem permissão nele -> 400 "(#100) Missing Permission".
// Token SÓ no header `Authorization: Bearer` (token na query ou no corpo é recusado: nunca em URL/log).
// Token errado: 400 com o formato de erro do Graph (code 190).

export interface MetaReceived {
  version: string;
  pixelId: string;
  testEventCode?: string;
  event: Record<string, unknown> & { event_name: string; event_id?: string; custom_data?: Record<string, unknown>; user_data?: Record<string, unknown> };
}

export interface FakeMeta {
  token: string;
  /** Eventos recebidos (um por item de `data`). */
  events: MetaReceived[];
  /** Todas as requisições (método e caminho, sem query). */
  requests: { method: string; path: string }[];
  /** URLs completas recebidas (com query) e corpos crus: para conferir que o token nunca vai neles. */
  rawUrls: string[];
  rawBodies: string[];
  /** Próximas N respostas falham com este status/código do Graph (status 0 = falha de rede). */
  failNext(times: number, status?: number, code?: number): void;
  /** O token deixa de ter permissão neste Pixel (eventos recusados com "(#100) Missing Permission"). */
  denyPixel(pixelId: string): void;
  fetch: typeof fetch;
}

const graphError = (status: number, code: number, message: string, subcode?: number) =>
  Response.json({ error: { message, type: "OAuthException", code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), fbtrace_id: "AfakeTrace" } }, { status });

export function createFakeMeta(opts: { token?: string; prefix?: string } = {}): FakeMeta {
  const token = opts.token ?? "fake-meta-token";
  const prefix = opts.prefix ?? "";
  const events: MetaReceived[] = [];
  const requests: { method: string; path: string }[] = [];
  const rawUrls: string[] = [];
  const rawBodies: string[] = [];
  let failures: { times: number; status: number; code: number } = { times: 0, status: 500, code: 2 };
  const denied = new Set<string>();

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    requests.push({ method: req.method, path });
    rawUrls.push(req.url);
    const raw = req.method === "POST" ? await req.text() : "";
    rawBodies.push(raw);
    const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (url.searchParams.has("access_token") || raw.includes("access_token")) return graphError(400, 100, "Token fora do header");
    if (failures.times > 0) {
      failures.times--;
      if (failures.status === 0) throw new TypeError("fetch failed"); // rede
      return graphError(failures.status, failures.code, "Falha simulada");
    }
    const m = /^\/(v\d+\.\d+)\/(\d+)(\/events)?$/.exec(path);
    if (!m) return graphError(404, 803, "Unknown path");
    const [, version, pixelId, events_] = m as unknown as [string, string, string, string | undefined];
    if (req.method === "GET" && !events_) {
      if (bearer !== token) return graphError(400, 190, "Invalid OAuth access token");
      return graphError(400, 100, "(#100) Missing Permission");
    }
    if (req.method === "POST" && events_) {
      if (bearer !== token) return graphError(400, 190, "Invalid OAuth access token");
      if (denied.has(pixelId)) return graphError(400, 100, "(#100) Missing Permission");
      type Body = { data?: unknown; test_event_code?: unknown };
      const body = ((): Body | null => {
        try {
          return JSON.parse(raw) as Body;
        } catch {
          return null;
        }
      })();
      if (!body || !Array.isArray(body.data) || body.data.length === 0) return graphError(400, 100, "Invalid parameter");
      // Como o Meta: o lote inteiro é recusado se algum evento não tem event_time.
      if ((body.data as Record<string, unknown>[]).some((ev) => typeof ev?.event_time !== "number")) {
        return graphError(400, 100, "Invalid parameter", 2804019);
      }
      for (const ev of body.data as MetaReceived["event"][]) {
        events.push({ version, pixelId, event: ev, ...(typeof body.test_event_code === "string" ? { testEventCode: body.test_event_code } : {}) });
      }
      return Response.json({ events_received: body.data.length, messages: [], fbtrace_id: "AfakeTrace" });
    }
    return graphError(405, 100, "Unsupported method");
  }

  return {
    token,
    events,
    requests,
    rawUrls,
    rawBodies,
    failNext(times, status = 500, code = 2) {
      failures = { times, status, code };
    },
    denyPixel(pixelId) {
      denied.add(pixelId);
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
      return handle(new Request(input, init));
    }) as typeof fetch,
  };
}
