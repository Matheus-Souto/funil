import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import { connectionsStatus } from "@/lib/connections";
import { withStore } from "@/lib/db/client";
import { auditLog, emailLog, integration, store } from "@/lib/db/schema";
import { RESEND_ERRORS, loadResend, resendFrom, resendIdempotencyKey, saveResend, sendViaResend, setEmailProvider, setResendFetchForTests, testResend } from "@/lib/delivery/resend";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

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
    expect(h.get("idempotency-key")).toBe(resendIdempotencyKey("job-1", msg));
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

  test("chave de idempotência: <jobId>:<64 hex>, determinística e diferente quando a mensagem muda", async () => {
    const id = crypto.randomUUID();
    const key = resendIdempotencyKey(id, msg);
    expect(key).toMatch(new RegExp(`^${id}:[0-9a-f]{64}$`));
    expect(key.length).toBeLessThanOrEqual(256);
    expect(resendIdempotencyKey(id, { ...msg })).toBe(key);
    for (const changed of [{ subject: "Outro" }, { text: "outro" }, { html: "<p>outro</p>" }]) {
      expect(resendIdempotencyKey(id, { ...msg, ...changed })).not.toBe(key);
    }
    const calls = fakeFetch(() => json(200, { id: "msg_1" }));
    await sendViaResend(settings, "Loja", msg, { idempotencyKey: id });
    expect(new Headers(calls[0]!.init.headers).get("idempotency-key")).toBe(key);
  });

  test("409 (chave repetida com corpo diferente, ou envio ainda em andamento) -> provider_error 'unreachable'", async () => {
    fakeFetch(() => json(409, { message: "idempotency conflict" }));
    const err = await failure(sendViaResend(settings, "Loja", msg, { idempotencyKey: "job-1" }));
    expect(err).toMatchObject({ code: "provider_error", message: RESEND_ERRORS.unreachable });
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

  test("id com mais de 100 caracteres: inacessível; id de 100 caracteres passa", async () => {
    fakeFetch(() => json(200, { id: "a".repeat(101) }));
    const e = await failure(sendViaResend(settings, "Loja", msg));
    expect(e).toMatchObject({ code: "provider_error", message: RESEND_ERRORS.unreachable });
    fakeFetch(() => json(200, { id: "a".repeat(100) }));
    expect(await sendViaResend(settings, "Loja", msg)).toEqual({ id: "a".repeat(100) });
  });

  test("não segue redirecionamento (redirect: 'error')", async () => {
    const calls = fakeFetch(() => json(200, { id: "msg_1" }));
    await sendViaResend(settings, "Loja", msg);
    expect(calls[0]!.init.redirect).toBe("error");
  });

  test("resposta de erro: o corpo é descartado (cancelado), não lido", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    fakeFetch(() => new Response(stream, { status: 500 }));
    await failure(sendViaResend(settings, "Loja", msg));
    expect(cancelled).toBe(true);
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

describe("conexão Resend", () => {
  const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
  const support: Actor = { kind: "user", userId: "u2", role: "support" };
  const panel = (storeId: string, actor: Actor = owner) => ({ storeId, actor, origin: "panel" as const });
  const API_KEY = "re_AbCdEfGh_1234";
  // Montado em tempo de execução: um literal no formato whsec_ dispara a varredura de segredos do GitHub.
  const WHSEC = `whsec_${Buffer.from("segredo-de-teste-do-webhook").toString("base64")}`;
  const INPUT = { fromEmail: "Vendas@Loja.com", fromName: "  Loja Kids  ", apiKey: API_KEY, webhookSecret: WHSEC };
  const SMTP_CONFIG = { host: "smtp.loja.com", port: 587, secure: false, user: null, from: "vendas@loja.com" };
  const providerOf = async (storeId: string) => (await t.ownerDb.select({ p: store.emailProvider }).from(store).where(eq(store.id, storeId)))[0]!.p;
  const breakSecret = (storeId: string, kind: "resend" | "smtp" = "resend") =>
    t.ownerDb.update(integration).set({ secret: "v1.lixo" }).where(and(eq(integration.storeId, storeId), eq(integration.kind, kind)));
  const rowOf = async (storeId: string, kind = "resend") =>
    (await t.ownerDb.select().from(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, kind))))[0];

  test("saveResend sela a chave e o segredo; config só com os últimos 4; auditoria sem segredos", async () => {
    const { storeId } = await seedStore();
    const out = await runAction(saveResend, panel(storeId), INPUT);
    const config = { fromEmail: "vendas@loja.com", fromName: "Loja Kids", apiKeyLast4: "1234", webhookSecretLast4: WHSEC.slice(-4) };
    expect(out).toEqual({ ...config, activated: true });
    const row = await rowOf(storeId);
    expect(row!.secret).toStartWith("v1.");
    expect(row!.config).toEqual(config);
    for (const secret of [API_KEY, WHSEC]) expect(JSON.stringify(row)).not.toContain(secret);
    const audits = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "connections.saveResend")));
    expect(audits).toHaveLength(1);
    for (const secret of [API_KEY, WHSEC]) expect(JSON.stringify(audits)).not.toContain(secret);
    expect(JSON.stringify(audits)).toContain("[novo]");
    const loaded = await withStore(storeId, (tx) => loadResend(tx, storeId));
    expect(loaded).toEqual({ apiKey: API_KEY, fromEmail: "vendas@loja.com", fromName: "Loja Kids", webhookSecret: WHSEC });
  });

  test("salvar de novo sem chave mantém a chave e o segredo; sem chave nenhuma -> invalid_input", async () => {
    const { storeId } = await seedStore();
    await expect(runAction(saveResend, panel(storeId), { fromEmail: "a@loja.com" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await rowOf(storeId)).toBeUndefined();
    await runAction(saveResend, panel(storeId), INPUT);
    const out = await runAction(saveResend, panel(storeId), { fromEmail: "outro@loja.com", fromName: "" });
    expect(out).toEqual({ fromEmail: "outro@loja.com", fromName: null, apiKeyLast4: "1234", webhookSecretLast4: WHSEC.slice(-4), activated: false });
    expect(await withStore(storeId, (tx) => loadResend(tx, storeId))).toEqual({ apiKey: API_KEY, fromEmail: "outro@loja.com", fromName: null, webhookSecret: WHSEC });
    const audits = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "connections.saveResend")));
    expect(JSON.stringify(audits)).toContain("[mantido]");
  });

  test("chave e segredo do webhook com formato inválido -> invalid_input", async () => {
    const { storeId } = await seedStore();
    await expect(runAction(saveResend, panel(storeId), { ...INPUT, apiKey: "chave-errada" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runAction(saveResend, panel(storeId), { ...INPUT, webhookSecret: "whsec_curto" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runAction(saveResend, panel(storeId), { ...INPUT, fromEmail: "nao-e-email" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("sensível: MCP/IA precisam de aprovação; support não pode", async () => {
    const { storeId } = await seedStore();
    await expect(runAction(saveResend, { storeId, actor: owner, origin: "mcp" }, INPUT)).rejects.toMatchObject({ code: "approval_required" });
    await expect(runAction(saveResend, panel(storeId, support), INPUT)).rejects.toMatchObject({ code: "forbidden" });
    expect(await rowOf(storeId)).toBeUndefined();
  });

  test("setEmailProvider: resend sem conexão -> invalid_input; com conexão -> ativa; sensível pelo MCP", async () => {
    const { storeId } = await seedStore();
    const provider = async () => (await t.ownerDb.select({ p: store.emailProvider }).from(store).where(eq(store.id, storeId)))[0]!.p;
    expect(await provider()).toBe("smtp");
    const err = await runAction(setEmailProvider, panel(storeId), { provider: "resend" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err).toMatchObject({ code: "invalid_input", message: "Configure o Resend antes de ativá-lo." });
    await expect(runAction(setEmailProvider, panel(storeId), { provider: "smtp" })).rejects.toMatchObject({
      code: "invalid_input",
      message: "Configure o SMTP antes de ativá-lo.",
    });
    await runAction(saveResend, panel(storeId), INPUT);
    await expect(runAction(setEmailProvider, { storeId, actor: owner, origin: "mcp" }, { provider: "resend" })).rejects.toMatchObject({ code: "approval_required" });
    await expect(runAction(setEmailProvider, panel(storeId, support), { provider: "resend" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await runAction(setEmailProvider, panel(storeId), { provider: "resend" })).toEqual({ provider: "resend" });
    expect(await provider()).toBe("resend");
    await t.ownerDb.insert(integration).values({ storeId, kind: "smtp", config: {}, secret: null });
    await expect(runAction(setEmailProvider, panel(storeId), { provider: "smtp" })).rejects.toMatchObject({ code: "invalid_input", message: "Configure o SMTP antes de ativá-lo." });
    await t.ownerDb.update(integration).set({ config: SMTP_CONFIG }).where(and(eq(integration.storeId, storeId), eq(integration.kind, "smtp")));
    expect(await runAction(setEmailProvider, panel(storeId), { provider: "smtp" })).toEqual({ provider: "smtp" });
    expect(await provider()).toBe("smtp");
  });

  test("connectionsStatus mostra só last4 e a URL do webhook; segredo ilegível -> apiKey 'unreadable'", async () => {
    const { storeId } = await seedStore();
    const empty = await runAction(connectionsStatus, panel(storeId), {});
    expect(empty.resend).toBeNull();
    expect(empty.emailProvider).toBe("smtp");
    await runAction(saveResend, panel(storeId), INPUT);
    const status = await runAction(connectionsStatus, panel(storeId), {});
    expect(status.resend).toEqual({
      fromEmail: "vendas@loja.com",
      fromName: "Loja Kids",
      apiKey: { last4: "1234" },
      webhookSecret: { last4: WHSEC.slice(-4) },
      webhookUrl: expect.stringMatching(new RegExp(`/api/webhooks/resend/${storeId}$`)),
    });
    for (const secret of [API_KEY, WHSEC, "re_"]) expect(JSON.stringify(status)).not.toContain(secret);

    await t.ownerDb.update(integration).set({ secret: "v1.lixo" }).where(and(eq(integration.storeId, storeId), eq(integration.kind, "resend")));
    const broken = await runAction(connectionsStatus, panel(storeId), {});
    expect(broken.resend).toMatchObject({ apiKey: "unreadable", webhookSecret: { last4: WHSEC.slice(-4) } });
    expect(JSON.stringify(broken)).not.toContain("re_");
    // loadResend não lança para o envio: segredo ilegível = sem conexão utilizável, e o log leva só a loja e o tipo.
    expect(await withStore(storeId, (tx) => loadResend(tx, storeId))).toBeNull();
    expect(out).not.toContain("lixo");
  });

  test("saveResend ativa o Resend quando a loja não tem SMTP; com SMTP, não troca o provedor", async () => {
    const semSmtp = await seedStore();
    expect((await runAction(saveResend, panel(semSmtp.storeId), INPUT)).activated).toBe(true);
    expect(await providerOf(semSmtp.storeId)).toBe("resend");

    const comSmtp = await seedStore();
    await t.ownerDb.insert(integration).values({ storeId: comSmtp.storeId, kind: "smtp", config: SMTP_CONFIG, secret: null });
    expect((await runAction(saveResend, panel(comSmtp.storeId), INPUT)).activated).toBe(false);
    expect(await providerOf(comSmtp.storeId)).toBe("smtp");
  });

  test("setEmailProvider recusa conexão com segredo ilegível (Resend e SMTP)", async () => {
    const { storeId } = await seedStore();
    await t.ownerDb.insert(integration).values({ storeId, kind: "smtp", config: SMTP_CONFIG, secret: null });
    await runAction(saveResend, panel(storeId), INPUT);
    await breakSecret(storeId);
    await expect(runAction(setEmailProvider, panel(storeId), { provider: "resend" })).rejects.toMatchObject({
      code: "invalid_input",
      message: "A conexão Resend não pode ser lida: salve as credenciais de novo antes de ativá-la.",
    });
    expect(await providerOf(storeId)).toBe("smtp");

    const b = await seedStore();
    await runAction(saveResend, panel(b.storeId), INPUT);
    expect(await providerOf(b.storeId)).toBe("resend");
    await t.ownerDb.insert(integration).values({ storeId: b.storeId, kind: "smtp", config: SMTP_CONFIG, secret: "v1.lixo" });
    await expect(runAction(setEmailProvider, panel(b.storeId), { provider: "smtp" })).rejects.toMatchObject({
      code: "invalid_input",
      message: "A conexão SMTP não pode ser lida: salve as credenciais de novo antes de ativá-la.",
    });
    expect(await providerOf(b.storeId)).toBe("resend");
  });

  test("saveResend com segredo ilegível e webhook configurado: exige colar o segredo do webhook de novo", async () => {
    const { storeId } = await seedStore();
    await runAction(saveResend, panel(storeId), INPUT);
    await breakSecret(storeId);
    const err = await failure(runAction(saveResend, panel(storeId), { fromEmail: "vendas@loja.com", apiKey: API_KEY }));
    const message = "O segredo guardado não pode ser lido: cole de novo o segredo do webhook (whsec_…).";
    expect(err).toMatchObject({ code: "invalid_input", message });
    expect(err.details).toEqual([{ path: ["webhookSecret"], message }]);
    // Colando o segredo de novo, salva.
    expect(await runAction(saveResend, panel(storeId), { fromEmail: "vendas@loja.com", apiKey: API_KEY, webhookSecret: WHSEC })).toMatchObject({
      webhookSecretLast4: WHSEC.slice(-4),
    });
    // Sem webhook configurado, a chave nova basta.
    const b = await seedStore();
    await runAction(saveResend, panel(b.storeId), { fromEmail: "vendas@loja.com", apiKey: API_KEY });
    await breakSecret(b.storeId);
    expect(await runAction(saveResend, panel(b.storeId), { fromEmail: "vendas@loja.com", apiKey: API_KEY })).toMatchObject({ webhookSecretLast4: null });
  });

  test("connectionsStatus.emailUsable: loja nova false; Resend ativo legível true; Resend ativo ilegível false; SMTP ativo configurado true", async () => {
    const { storeId } = await seedStore();
    expect((await runAction(connectionsStatus, panel(storeId), {})).emailUsable).toBe(false);
    await runAction(saveResend, panel(storeId), INPUT);
    expect((await runAction(connectionsStatus, panel(storeId), {})).emailUsable).toBe(true);
    await breakSecret(storeId);
    expect((await runAction(connectionsStatus, panel(storeId), {})).emailUsable).toBe(false);

    const b = await seedStore();
    await t.ownerDb.insert(integration).values({ storeId: b.storeId, kind: "smtp", config: SMTP_CONFIG, secret: null });
    expect((await runAction(connectionsStatus, panel(b.storeId), {})).emailUsable).toBe(true);
  });

  test("connectionsStatus: finais da chave e do segredo do webhook só para quem tem connections.write", async () => {
    const { storeId } = await seedStore();
    await runAction(saveResend, panel(storeId), INPUT);
    const traffic: Actor = { kind: "user", userId: "u3", role: "traffic" };
    const st = await runAction(connectionsStatus, panel(storeId, traffic), {});
    expect(st.resend).toMatchObject({ apiKey: "configured", webhookSecret: "configured" });
    // Sem as URLs (o storeId pode conter "1234" por acaso), nada da resposta leva os finais.
    const withoutUrls = { ...st, resend: { ...st.resend!, webhookUrl: "" }, asaas: null };
    for (const v of ["1234", WHSEC.slice(-4)]) expect(JSON.stringify(withoutUrls)).not.toContain(v);
    expect((await runAction(connectionsStatus, panel(storeId), {})).resend).toMatchObject({ apiKey: { last4: "1234" }, webhookSecret: { last4: WHSEC.slice(-4) } });
  });

  test("isolamento: loja B não vê a conexão Resend da loja A", async () => {
    const a = await seedStore("A");
    const b = await seedStore("B");
    await runAction(saveResend, panel(a.storeId), INPUT);
    expect((await runAction(connectionsStatus, panel(b.storeId), {})).resend).toBeNull();
    expect(await withStore(b.storeId, (tx) => loadResend(tx, b.storeId))).toBeNull();
    await expect(runAction(setEmailProvider, panel(b.storeId), { provider: "resend" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("testResend", () => {
  const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
  const support: Actor = { kind: "user", userId: "u2", role: "support" };
  const panel = (storeId: string, actor: Actor = owner) => ({ storeId, actor, origin: "panel" as const });
  const INPUT = { fromEmail: "vendas@loja.com", apiKey: "re_AbCdEfGh_1234" };

  test("envia ao endereço informado, com assunto e texto fixos, e registra test/sent/resend com o id", async () => {
    const { storeId } = await seedStore("Maná Kids");
    await runAction(saveResend, panel(storeId), INPUT);
    const calls = fakeFetch(() => json(200, { id: "msg_teste" }));
    expect(await runAction(testResend, panel(storeId), { to: "Eu@Exemplo.com" })).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.to).toEqual(["eu@exemplo.com"]);
    expect(body.subject).toBe("E-mail de teste da Maná Kids");
    expect(body.text).toBe("Este é um e-mail de teste. Se chegou, as entregas da sua loja vão sair pelo Resend.");
    const logs = await withStore(storeId, (tx) => tx.select().from(emailLog));
    expect(logs.map((l) => [l.kind, l.status, l.provider, l.providerMessageId])).toEqual([["test", "sent", "resend", "msg_teste"]]);
    expect(JSON.stringify(logs)).not.toContain("re_AbCdEfGh_1234");
  });

  test("sem conexão -> provider_error 'E-mail não configurado'; Resend recusando -> mensagem fixa; support não pode", async () => {
    const { storeId } = await seedStore();
    const calls = fakeFetch(() => json(200, { id: "x" }));
    await expect(runAction(testResend, panel(storeId), { to: "eu@exemplo.com" })).rejects.toMatchObject({ code: "provider_error", message: "E-mail não configurado" });
    expect(calls).toHaveLength(0);
    await runAction(saveResend, panel(storeId), INPUT);
    fakeFetch(() => json(401, { message: "invalid key re_AbCdEfGh_1234" }));
    const err = await failure(runAction(testResend, panel(storeId), { to: "eu@exemplo.com" }));
    expect(err).toMatchObject({ code: "provider_error", message: RESEND_ERRORS.key });
    await expect(runAction(testResend, panel(storeId, support), { to: "eu@exemplo.com" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await withStore(storeId, (tx) => tx.select().from(emailLog))).toHaveLength(0);
  });
});
