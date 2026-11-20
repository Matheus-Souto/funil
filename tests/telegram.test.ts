import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { runAction, type Actor } from "@/lib/actions/core";
import { connectionsStatus } from "@/lib/connections";
import { withStore } from "@/lib/db/client";
import { auditLog, integration } from "@/lib/db/schema";
import { loadTelegram, removeTelegram, saveTelegram, telegramSettings, testTelegram } from "@/lib/notify/telegram-connection";
import { createTestDb, seedStore, type TestDb } from "./db";
import {
  TELEGRAM_CHAT_RE,
  TELEGRAM_TOKEN_RE,
  TelegramError,
  setTelegramFetchForTests,
  telegramGetMe,
  telegramMessage,
  telegramSend,
} from "@/lib/notify/telegram";

// Token montado em tempo de execução (a varredura de segredos reconhece o formato literal).
const TOKEN = `${"123456"}:${"A".repeat(35)}`;

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(respond: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  setTelegramFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch);
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let out = "";
let stdout: ReturnType<typeof spyOn>;
beforeEach(() => {
  out = "";
  stdout = spyOn(process.stdout, "write").mockImplementation(((s: string) => ((out += String(s)), true)) as never);
});
afterEach(() => {
  stdout.mockRestore();
  setTelegramFetchForTests();
});

async function failure(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TelegramError);
    return e as TelegramError;
  }
  throw new Error("era para falhar");
}

describe("cliente da Bot API do Telegram", () => {
  test("sendMessage: POST na URL do bot com JSON de texto puro; devolve o message_id", async () => {
    const calls = fakeFetch(() => json(200, { ok: true, result: { message_id: 7 } }));
    const r = await telegramSend(TOKEN, "-1001", "Olá *x*");
    expect(r).toEqual({ messageId: 7 });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("content-type")).toContain("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ chat_id: "-1001", text: "Olá *x*", link_preview_options: { is_disabled: true } });
    expect(body.parse_mode).toBeUndefined();
  });

  test("getMe devolve o username", async () => {
    const calls = fakeFetch(() => json(200, { ok: true, result: { id: 1, username: "loja_bot" } }));
    expect(await telegramGetMe(TOKEN)).toEqual({ username: "loja_bot" });
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  const cases: [string, number, unknown, "token" | "chat" | "temporary"][] = [
    ["401", 401, { ok: false, error_code: 401, description: "Unauthorized" }, "token"],
    ["404", 404, { ok: false, error_code: 404, description: "Not Found" }, "token"],
    ["400 chat not found", 400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }, "chat"],
    [
      "400 supergrupo",
      400,
      { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -100 } },
      "chat",
    ],
    ["403", 403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "chat"],
    ["429", 429, { ok: false, error_code: 429, description: "Too Many Requests" }, "temporary"],
    ["502", 502, "<html>bad gateway</html>", "temporary"],
  ];
  for (const [name, status, body, kind] of cases) {
    test(`classifica ${name} como ${kind}`, async () => {
      fakeFetch(() => (typeof body === "string" ? new Response(body, { status }) : json(status, body)));
      const e = await failure(telegramSend(TOKEN, "-1001", "x"));
      expect(e.kind).toBe(kind);
      expect(e.httpStatus).toBe(status);
    });
  }

  test("mensagens fixas por tipo de falha", async () => {
    fakeFetch(() => json(401, { ok: false }));
    expect((await failure(telegramGetMe(TOKEN))).message).toBe("O Telegram recusou o token do bot. Confira o token no @BotFather.");
    fakeFetch(() => json(403, { ok: false }));
    expect((await failure(telegramSend(TOKEN, "1", "x"))).message).toBe(
      "O Telegram não encontrou o chat ou o bot não está nele. Adicione o bot ao grupo e confira o chat id.",
    );
    fakeFetch(() => json(503, { ok: false }));
    expect((await failure(telegramSend(TOKEN, "1", "x"))).message).toBe("Não foi possível falar com o Telegram agora. Tente de novo em instantes.");
  });

  test("fetch que lança vira temporário com httpStatus 0", async () => {
    fakeFetch(() => {
      throw new TypeError("falhou");
    });
    const e = await failure(telegramSend(TOKEN, "1", "x"));
    expect(e.kind).toBe("temporary");
    expect(e.httpStatus).toBe(0);
  });

  test("200 com ok false é temporário", async () => {
    fakeFetch(() => json(200, { ok: false }));
    const e = await failure(telegramSend(TOKEN, "1", "x"));
    expect(e.kind).toBe("temporary");
    expect(e.httpStatus).toBe(200);
  });

  test("o token nunca aparece no erro nem no log", async () => {
    fakeFetch(() => {
      throw new TypeError(`unable to connect to https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const a = await failure(telegramSend(TOKEN, "1", "x"));
    fakeFetch(() => json(401, { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` }));
    const b = await failure(telegramGetMe(TOKEN));
    for (const e of [a, b]) {
      expect(`${e.message} ${e.stack ?? ""} ${JSON.stringify(e)}`).not.toContain(TOKEN);
      expect(`${e.message} ${e.stack ?? ""}`).not.toContain("123456");
      expect(e.cause).toBeUndefined();
    }
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("123456");
    expect(out).toContain("Telegram recusou a requisição");
  });

  test("validação de token e chat id", () => {
    expect(TELEGRAM_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(TELEGRAM_TOKEN_RE.test("abc")).toBe(false);
    for (const c of ["123", "-1001234567890", "@meu_canal"]) expect(TELEGRAM_CHAT_RE.test(c)).toBe(true);
    for (const c of ["@ab", "abc", "1 2", "--1"]) expect(TELEGRAM_CHAT_RE.test(c)).toBe(false);
  });
});

describe("textos dos avisos", () => {
  const base = { productName: "Almanaque", bumpName: "5 Kits", totalCents: 2700, method: "pix_asaas" as const, orderCode: "AB12CD", abandonAfterMinutes: 30 };

  test("sale", () => {
    expect(telegramMessage("sale", base)).toBe("Venda: Almanaque + 5 Kits — R$ 27,00 — Pix — pedido #AB12CD");
  });
  test("pix_generated", () => {
    expect(telegramMessage("pix_generated", base)).toBe("Pix gerado: Almanaque + 5 Kits — R$ 27,00 — pedido #AB12CD");
  });
  test("card_declined", () => {
    expect(telegramMessage("card_declined", { ...base, method: "card_asaas" })).toBe("Cartão recusado: Almanaque + 5 Kits — R$ 27,00 — pedido #AB12CD");
  });
  test("abandoned", () => {
    expect(telegramMessage("abandoned", base)).toBe("Carrinho abandonado (30 min sem pagamento): Almanaque + 5 Kits — R$ 27,00 — Pix — pedido #AB12CD");
  });
  test("sem bump, cartão e Pix manual", () => {
    expect(telegramMessage("sale", { ...base, bumpName: null, method: "card_asaas" })).toBe("Venda: Almanaque — R$ 27,00 — Cartão — pedido #AB12CD");
    expect(telegramMessage("sale", { ...base, method: "pix_manual" })).toContain("— Pix manual —");
  });
  test("nome com quebra de linha e marcação sai em uma linha, como texto", () => {
    const m = telegramMessage("sale", { ...base, productName: "A\nB *x* <b>" });
    expect(m).toBe("Venda: A B *x* <b> + 5 Kits — R$ 27,00 — Pix — pedido #AB12CD");
    expect(m).not.toContain("\n");
  });
  test("nome de 500 caracteres sai com 100", () => {
    const m = telegramMessage("sale", { ...base, productName: "x".repeat(500), bumpName: null });
    expect(m).toBe(`Venda: ${"x".repeat(100)} — R$ 27,00 — Pix — pedido #AB12CD`);
    expect(m.length).toBeLessThanOrEqual(1000);
  });
});

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const BOT_TOKEN = `${"1234567"}:${"AbCdEfGh_ijklMNOP-qrstuv012345wXyZ"}`;
const BOT_TOKEN2 = `${"7654321"}:${"ZyXwVuTs_rqpoNMLK-jihgfe9876543210"}`;
const CHAT = "-1001234567890";

interface TgCall {
  url: string;
  body: Record<string, unknown>;
}
function fakeTg(respond: (c: TgCall) => Response): TgCall[] {
  const calls: TgCall[] = [];
  setTelegramFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    const call: TgCall = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    return respond(call);
  }) as typeof fetch);
  return calls;
}
const okFor = (c: TgCall) => (c.url.endsWith("/getMe") ? json(200, { ok: true, result: { username: "loja_bot" } }) : json(200, { ok: true, result: { message_id: 7 } }));


const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const support: Actor = { kind: "user", userId: "u2", role: "support" };
const traffic: Actor = { kind: "user", userId: "u3", role: "traffic" };
const panel = (storeId: string, actor: Actor = owner) => ({ storeId, actor, origin: "panel" as const });
const rowOf = async (storeId: string) =>
  (await t.ownerDb.select().from(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, "telegram"))))[0];
const DEFAULT_EVENTS = { sale: true, pixGenerated: false, cardDeclined: false, abandoned: false };

describe("conexão Telegram", () => {
  test("saveTelegram valida o token no getMe, sela o token, guarda só o final e os eventos padrão; auditoria sem o token", async () => {
    const { storeId } = await seedStore();
    const calls = fakeTg(okFor);
    const out1 = await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN });
    const config = { chatId: CHAT, botUsername: "loja_bot", tokenLast4: BOT_TOKEN.slice(-4), events: DEFAULT_EVENTS, abandonAfterMinutes: 30 };
    expect(out1).toEqual(config);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toEndWith("/getMe");
    const row = await rowOf(storeId);
    expect(row!.secret).toStartWith("v1.");
    expect(row!.config).toEqual(config);
    expect(JSON.stringify(row)).not.toContain(BOT_TOKEN);
    const audits = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "connections.saveTelegram")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(audits)).toContain("[novo]");
    expect(await withStore(storeId, (tx) => loadTelegram(tx, storeId))).toEqual({ token: BOT_TOKEN, chatId: CHAT, events: DEFAULT_EVENTS, abandonAfterMinutes: 30 });
    expect(await withStore(storeId, (tx) => telegramSettings(tx, storeId))).toEqual({ events: DEFAULT_EVENTS, abandonAfterMinutes: 30 });
    expect(out).not.toContain(BOT_TOKEN);
  });

  test("token recusado no getMe → provider_error com o texto fixo e nada salvo", async () => {
    const { storeId } = await seedStore();
    fakeTg(() => json(401, { ok: false, error_code: 401, description: `Unauthorized ${BOT_TOKEN}` }));
    const err = await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "provider_error", message: "O Telegram recusou o token do bot. Confira o token no @BotFather." });
    expect(JSON.stringify(err)).not.toContain(BOT_TOKEN);
    expect(await rowOf(storeId)).toBeUndefined();
    expect(out).not.toContain(BOT_TOKEN);
    expect(await withStore(storeId, (tx) => telegramSettings(tx, storeId))).toBeNull();
  });

  test("salvar de novo sem token mantém o guardado e não chama o getMe; só mudar eventos e prazo funciona; sem token nenhum → invalid_input", async () => {
    const { storeId } = await seedStore();
    const calls = fakeTg(okFor);
    await expect(runAction(saveTelegram, panel(storeId), { chatId: CHAT })).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
    expect(await rowOf(storeId)).toBeUndefined();
    await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN });
    expect(calls).toHaveLength(1);
    const out2 = await runAction(saveTelegram, panel(storeId), { chatId: "@meu_grupo", events: { abandoned: true, pixGenerated: true }, abandonAfterMinutes: 45 });
    expect(calls).toHaveLength(1);
    expect(out2).toEqual({
      chatId: "@meu_grupo",
      botUsername: "loja_bot",
      tokenLast4: BOT_TOKEN.slice(-4),
      events: { sale: true, pixGenerated: true, cardDeclined: false, abandoned: true },
      abandonAfterMinutes: 45,
    });
    // Só um evento: os demais ficam como estavam; o prazo também.
    const out3 = await runAction(saveTelegram, panel(storeId), { chatId: "@meu_grupo", events: { sale: false } });
    expect(out3.events).toEqual({ sale: false, pixGenerated: true, cardDeclined: false, abandoned: true });
    expect(out3.abandonAfterMinutes).toBe(45);
    expect((await withStore(storeId, (tx) => loadTelegram(tx, storeId)))!.token).toBe(BOT_TOKEN);
    // Token novo: valida de novo e troca o username.
    await runAction(saveTelegram, panel(storeId), { chatId: "@meu_grupo", token: BOT_TOKEN2 });
    expect(calls).toHaveLength(2);
    expect((await withStore(storeId, (tx) => loadTelegram(tx, storeId)))!.token).toBe(BOT_TOKEN2);
    const audits = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "connections.saveTelegram")));
    expect(JSON.stringify(audits)).toContain("[mantido]");
    for (const secret of [BOT_TOKEN, BOT_TOKEN2]) expect(JSON.stringify(audits)).not.toContain(secret);
  });

  test("token ilegível + salvar sem token novo → invalid_input pedindo o token de novo", async () => {
    const { storeId } = await seedStore();
    fakeTg(okFor);
    await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN });
    await t.ownerDb.update(integration).set({ secret: "v1.lixo" }).where(and(eq(integration.storeId, storeId), eq(integration.kind, "telegram")));
    const err = await runAction(saveTelegram, panel(storeId), { chatId: CHAT }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "invalid_input" });
    expect((err as Error).message).toContain("cole o token do bot de novo");
    expect(await withStore(storeId, (tx) => loadTelegram(tx, storeId))).toBeNull();
    expect(out).not.toContain("lixo");
    await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN });
    expect((await withStore(storeId, (tx) => loadTelegram(tx, storeId)))!.token).toBe(BOT_TOKEN);
  });

  test("chat id inválido (\"abc\", \"-\", \"@ab\"), token fora do formato e prazo fora de 10..1440 → invalid_input", async () => {
    const { storeId } = await seedStore();
    const calls = fakeTg(okFor);
    for (const chatId of ["abc", "-", "@ab", ""]) {
      await expect(runAction(saveTelegram, panel(storeId), { chatId, token: BOT_TOKEN })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: "token-errado" })).rejects.toMatchObject({ code: "invalid_input" });
    for (const abandonAfterMinutes of [9, 1441, 30.5]) {
      await expect(runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN, abandonAfterMinutes })).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const abandonAfterMinutes of [10, 1440]) {
      expect((await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN, abandonAfterMinutes })).abandonAfterMinutes).toBe(abandonAfterMinutes);
    }
    expect(calls).toHaveLength(2);
  });

  test("sensível: MCP/IA precisam de aprovação; support não pode", async () => {
    const { storeId } = await seedStore();
    const calls = fakeTg(okFor);
    await expect(runAction(saveTelegram, { storeId, actor: owner, origin: "mcp" }, { chatId: CHAT, token: BOT_TOKEN })).rejects.toMatchObject({ code: "approval_required" });
    await expect(runAction(saveTelegram, panel(storeId, support), { chatId: CHAT, token: BOT_TOKEN })).rejects.toMatchObject({ code: "forbidden" });
    expect(await rowOf(storeId)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("testTelegram envia o texto de teste ao chat salvo; sem conexão → provider_error", async () => {
    const { storeId } = await seedStore("Maná Kids");
    const calls = fakeTg(okFor);
    await expect(runAction(testTelegram, panel(storeId), {})).rejects.toMatchObject({ code: "provider_error", message: "Telegram não configurado" });
    expect(calls).toHaveLength(0);
    await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN });
    expect(await runAction(testTelegram, panel(storeId), {})).toEqual({ sent: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toEndWith("/sendMessage");
    expect(calls[1]!.body).toMatchObject({ chat_id: CHAT, text: "Teste do funil: os avisos da Maná Kids vão chegar aqui." });
    await expect(runAction(testTelegram, panel(storeId, support), {})).rejects.toMatchObject({ code: "forbidden" });
    fakeTg(() => json(403, { ok: false, error_code: 403, description: "Forbidden: bot was kicked" }));
    const err = await runAction(testTelegram, panel(storeId), {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "provider_error", message: "O Telegram não encontrou o chat ou o bot não está nele. Adicione o bot ao grupo e confira o chat id." });
    expect(out).not.toContain(BOT_TOKEN);
  });

  test("removeTelegram apaga a conexão (e só ela)", async () => {
    const { storeId } = await seedStore();
    fakeTg(okFor);
    expect(await runAction(removeTelegram, panel(storeId), {})).toEqual({ removed: false });
    await t.ownerDb.insert(integration).values({ storeId, kind: "smtp", config: {}, secret: null });
    await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN });
    await expect(runAction(removeTelegram, panel(storeId, support), {})).rejects.toMatchObject({ code: "forbidden" });
    expect(await runAction(removeTelegram, panel(storeId), {})).toEqual({ removed: true });
    expect(await rowOf(storeId)).toBeUndefined();
    expect(await t.ownerDb.select().from(integration).where(eq(integration.storeId, storeId))).toHaveLength(1);
    expect(await withStore(storeId, (tx) => loadTelegram(tx, storeId))).toBeNull();
  });

  test("connectionsStatus: owner vê last4; papel com connections.read sem write vê \"configured\"; resposta nunca contém o token; segredo ilegível → \"unreadable\"", async () => {
    const { storeId } = await seedStore();
    fakeTg(okFor);
    expect((await runAction(connectionsStatus, panel(storeId), {})).telegram).toBeNull();
    await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN });
    const status = await runAction(connectionsStatus, panel(storeId), {});
    expect(status.telegram).toEqual({ chatId: CHAT, botUsername: "loja_bot", token: { last4: BOT_TOKEN.slice(-4) }, events: DEFAULT_EVENTS, abandonAfterMinutes: 30 });
    expect(JSON.stringify(status)).not.toContain(BOT_TOKEN);
    const ro = await runAction(connectionsStatus, panel(storeId, traffic), {});
    expect(ro.telegram).toMatchObject({ token: "configured" });
    expect(JSON.stringify(ro.telegram)).not.toContain(BOT_TOKEN.slice(-4));
    await t.ownerDb.update(integration).set({ secret: "v1.lixo" }).where(and(eq(integration.storeId, storeId), eq(integration.kind, "telegram")));
    const broken = await runAction(connectionsStatus, panel(storeId), {});
    expect(broken.telegram).toMatchObject({ token: "unreadable", chatId: CHAT });
    expect(JSON.stringify(broken)).not.toContain(BOT_TOKEN);
  });

  test("isolamento: loja B não vê a conexão da loja A", async () => {
    const a = await seedStore("A");
    const b = await seedStore("B");
    fakeTg(okFor);
    await runAction(saveTelegram, panel(a.storeId), { chatId: CHAT, token: BOT_TOKEN });
    expect((await runAction(connectionsStatus, panel(b.storeId), {})).telegram).toBeNull();
    expect(await withStore(b.storeId, (tx) => loadTelegram(tx, b.storeId))).toBeNull();
    expect(await withStore(b.storeId, (tx) => telegramSettings(tx, b.storeId))).toBeNull();
    await expect(runAction(testTelegram, panel(b.storeId), {})).rejects.toMatchObject({ code: "provider_error" });
  });
});
