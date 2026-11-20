import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ActionError } from "@/lib/actions/core";
import { RESEND_ERRORS, resendFrom, sendViaResend, setResendFetchForTests } from "@/lib/delivery/resend";

const KEY = "re_teste_1234";
const settings = { apiKey: KEY, fromEmail: "vendas@loja.com", fromName: null };
const msg = { to: "c@x.com", subject: "Assunto", html: "<p>oi</p>", text: "oi" };

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(respond: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  setResendFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch);
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// O log vai para o stdout: captura em todos os testes (saída limpa) e o teste da chave confere o conteúdo.
let out = "";
let stdout: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = "";
  stdout = spyOn(process.stdout, "write").mockImplementation(((s: string) => ((out += String(s)), true)) as never);
});
afterEach(() => {
  stdout.mockRestore();
  setResendFetchForTests();
});

async function failure(p: Promise<unknown>): Promise<ActionError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    return e as ActionError;
  }
  throw new Error("era para falhar");
}

describe("cliente do Resend", () => {
  test("envia POST /emails com Bearer, JSON e Idempotency-Key; devolve o id", async () => {
    const calls = fakeFetch(() => json(200, { id: "msg_1" }));
    const r = await sendViaResend({ ...settings, fromName: "Loja" }, "Outra", msg, { idempotencyKey: "job-1" });
    expect(r).toEqual({ id: "msg_1" });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(h.get("idempotency-key")).toBe("job-1");
    expect(h.get("content-type")).toContain("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Loja <vendas@loja.com>",
      to: ["c@x.com"],
      subject: "Assunto",
      html: "<p>oi</p>",
      text: "oi",
    });
  });

  test("sem fromName usa o nome da loja", async () => {
    const calls = fakeFetch(() => json(200, { id: "msg_1" }));
    await sendViaResend(settings, "Minha Loja", msg);
    expect(JSON.parse(String(calls[0]!.init.body)).from).toBe("Minha Loja <vendas@loja.com>");
  });

  test("sem Idempotency-Key quando não informada", async () => {
    const calls = fakeFetch(() => json(200, { id: "msg_1" }));
    await sendViaResend(settings, "Loja", msg);
    expect(new Headers(calls[0]!.init.headers).has("idempotency-key")).toBe(false);
  });

  test.each([
    [401, RESEND_ERRORS.key],
    [403, RESEND_ERRORS.key],
    [400, RESEND_ERRORS.rejected],
    [422, RESEND_ERRORS.rejected],
    [429, RESEND_ERRORS.rateLimited],
    [503, RESEND_ERRORS.unreachable],
  ])("status %i vira provider_error com a mensagem da tabela", async (status, message) => {
    fakeFetch(() => json(status, { message: "texto do Resend" }));
    const e = await failure(sendViaResend(settings, "Loja", msg));
    expect(e.code).toBe("provider_error");
    expect(e.message).toBe(message);
    expect(e.details).toEqual({ status });
  });

  test("fetch lança: inacessível", async () => {
    setResendFetchForTests((async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch);
    const e = await failure(sendViaResend(settings, "Loja", msg));
    expect(e.code).toBe("provider_error");
    expect(e.message).toBe(RESEND_ERRORS.unreachable);
  });

  test("resposta 200 sem id: inacessível", async () => {
    fakeFetch(() => json(200, { ok: true }));
    const e = await failure(sendViaResend(settings, "Loja", msg));
    expect(e.message).toBe(RESEND_ERRORS.unreachable);
  });

  test("a chave nunca aparece no erro nem no log", async () => {
    fakeFetch(() => json(401, { message: `invalid ${KEY}` }));
    const e = await failure(sendViaResend(settings, "Loja", msg));
    expect(out).toContain("Resend recusou o envio");
    expect(out).not.toContain(KEY);
    expect(`${e.message} ${JSON.stringify(e.details)}`).not.toContain(KEY);
  });

  test("abort cancela o envio sem chamar o fetch", async () => {
    const calls = fakeFetch(() => json(200, { id: "msg_1" }));
    const ac = new AbortController();
    ac.abort(new Error("cancelado"));
    await expect(sendViaResend(settings, "Loja", msg, { signal: ac.signal })).rejects.toThrow("cancelado");
    expect(calls).toHaveLength(0);
  });
});

describe("resendFrom", () => {
  test("limpa o nome", () => {
    expect(resendFrom('A\r\nBcc: x <y> "z"\\', "v@l.com")).toBe("A Bcc: x y z <v@l.com>");
  });
  test("limita o nome a 100 caracteres", () => {
    expect(resendFrom("a".repeat(300), "v@l.com")).toBe(`${"a".repeat(100)} <v@l.com>`);
  });
  test("nome vazio após a limpeza: só o e-mail", () => {
    expect(resendFrom('<>"\\ \n', "v@l.com")).toBe("v@l.com");
  });
});
