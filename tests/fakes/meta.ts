// API de Conversões do Meta falsa (Graph API): usada pelos testes (como `fetch` injetado) e pelo smoke E2E
// (e2e/fakes/asaas-server.ts a serve em /meta). Só o que o app usa:
//   GET  /<versão>/<pixelId>?fields=id&access_token=...      -> { id } (validação do token ao salvar a conexão)
//   POST /<versão>/<pixelId>/events  { data, access_token, test_event_code? } -> { events_received }
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
  /** Próximas N respostas falham com este status/código do Graph. */
  failNext(times: number, status?: number, code?: number): void;
  fetch: typeof fetch;
}

const graphError = (status: number, code: number, message: string) =>
  Response.json({ error: { message, type: "OAuthException", code, fbtrace_id: "AfakeTrace" } }, { status });

export function createFakeMeta(opts: { token?: string; prefix?: string } = {}): FakeMeta {
  const token = opts.token ?? "fake-meta-token";
  const prefix = opts.prefix ?? "";
  const events: MetaReceived[] = [];
  const requests: { method: string; path: string }[] = [];
  let failures: { times: number; status: number; code: number } = { times: 0, status: 500, code: 2 };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    requests.push({ method: req.method, path });
    if (failures.times > 0) {
      failures.times--;
      return graphError(failures.status, failures.code, "Falha simulada");
    }
    const m = /^\/(v\d+\.\d+)\/(\d+)(\/events)?$/.exec(path);
    if (!m) return graphError(404, 803, "Unknown path");
    const [, version, pixelId, events_] = m as unknown as [string, string, string, string | undefined];
    if (req.method === "GET" && !events_) {
      if (url.searchParams.get("access_token") !== token) return graphError(400, 190, "Invalid OAuth access token");
      return Response.json({ id: pixelId });
    }
    if (req.method === "POST" && events_) {
      const body = (await req.json().catch(() => null)) as { data?: unknown; access_token?: unknown; test_event_code?: unknown } | null;
      if (body?.access_token !== token) return graphError(400, 190, "Invalid OAuth access token");
      if (!Array.isArray(body.data) || body.data.length === 0) return graphError(400, 100, "Invalid parameter");
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
    failNext(times, status = 500, code = 2) {
      failures = { times, status, code };
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason ?? new Error("aborted");
      return handle(new Request(input, init));
    }) as typeof fetch,
  };
}
