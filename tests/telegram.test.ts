import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ackAlert, alertText } from "@/lib/alerts";
import { runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { connectionsStatus } from "@/lib/connections";
import { withStore } from "@/lib/db/client";
import { noticeFor } from "@/lib/delivery/jobs";
import { orderCode } from "@/lib/format";
import { auditLog, integration, job, orders, storeAlert, telegramNotice } from "@/lib/db/schema";
import { runDueJobs, type Job } from "@/lib/jobs";
import { getHandlers } from "@/lib/jobs/handlers";
import { createOrder } from "@/lib/orders/create";
import { transitionOrder } from "@/lib/orders/state";
import { releaseOrder, savePixManual } from "@/lib/payments/manual";
import { notifyTelegramJob } from "@/lib/notify/telegram-job";
import { loadTelegram, removeTelegram, saveTelegram, telegramSettings, testTelegram } from "@/lib/notify/telegram-connection";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { payWithCard, type CardDeps, type CardPaymentInput } from "@/lib/payments/asaas/card";
import { resetCardFingerprintsForTests } from "@/lib/payments/ratelimit";
import { createTestDb, seedProduct, seedStore, type TestDb } from "./db";
import { createFakeAsaas, seedAsaasStore } from "./asaas-helpers";
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

  test("400 com migrate_to_chat_id: chat migrado, com a mensagem própria; o id novo não vai ao log", async () => {
    fakeFetch(() =>
      json(400, { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1009876543210 } }),
    );
    const e = await failure(telegramSend(TOKEN, "-4012345678", "x"));
    expect([e.kind, e.httpStatus, e.migrated]).toEqual(["chat", 400, true]);
    expect(e.message).toBe("O grupo virou supergrupo e mudou de id. Salve o id novo (começa com -100).");
    expect(`${e.message} ${JSON.stringify(e)}`).not.toContain("9876543210");
    expect(out).not.toContain("9876543210");
    fakeFetch(() => json(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    expect((await failure(telegramSend(TOKEN, "-4012345678", "x"))).migrated).toBe(false);
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
    fakeTg(() => json(400, { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1009876543210 } }));
    const migrated = await runAction(testTelegram, panel(storeId), {}).catch((e: unknown) => e);
    expect(migrated).toMatchObject({ code: "provider_error", message: "O grupo virou supergrupo e mudou de id. Salve o id novo (começa com -100)." });
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

// ---------------------------------------------------------------------------------------------------------------

const BUYER = { name: "Maria Teste", email: "maria.teste@example.com", phone: "11987654321", cpf: "52998224725" };
const systemCtx = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "system" }, origin: "system", tx });

async function seedShop(opts: { telegram?: boolean; events?: Record<string, boolean>; twoMains?: boolean; label?: string | null } = {}) {
  const { storeId } = await seedStore("Loja do Telegram");
  await runAction(savePixManual, panel(storeId), { key: "contato@loja.com.br", name: "Loja", city: "Sao Paulo" });
  if (opts.telegram !== false) {
    fakeTg(okFor);
    await runAction(saveTelegram, panel(storeId), { chatId: CHAT, token: BOT_TOKEN, ...(opts.events ? { events: opts.events } : {}) });
  }
  const main = await seedProduct(storeId, "Almanaque");
  const main2 = await seedProduct(storeId, "Caderno");
  const bump = await seedProduct(storeId, "Kit de adesivos");
  const offer = await runAction(createOffer, panel(storeId), {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Combo da loja",
    productIds: opts.twoMains ? [main.id, main2.id] : [main.id],
    priceCents: 2700,
    methods: ["pix"],
    pixMode: "manual",
    bump: { productIds: [bump.id], priceCents: 990, ...(opts.label === null ? {} : { label: opts.label ?? "5 Kits" }) },
  });
  return { storeId, offerId: offer.id };
}
type Shop = Awaited<ReturnType<typeof seedShop>>;

async function pendingOrder(shop: Shop, withBump = true) {
  return withStore(shop.storeId, (tx) =>
    createOrder(systemCtx(shop.storeId, tx), {
      offerId: shop.offerId,
      withBump,
      method: "pix_manual",
      customer: BUYER,
      touch: { first: null, last: {} },
      clientIp: "203.0.113.7",
      userAgent: "teste",
    }),
  );
}
async function paidOrder(shop: Shop, withBump = true) {
  const o = await pendingOrder(shop, withBump);
  await runAction(releaseOrder, panel(shop.storeId), { orderId: o.id });
  return o;
}
const tgJobs = (orderId: string) => t.ownerDb.select().from(job).where(and(eq(job.type, "notify_telegram"), sql`${job.payload}->>'orderId' = ${orderId}`));
const notices = (orderId: string) => t.ownerDb.select().from(telegramNotice).where(eq(telegramNotice.orderId, orderId));
const openAlerts = (storeId: string) =>
  t.ownerDb.select().from(storeAlert).where(and(eq(storeAlert.storeId, storeId), eq(storeAlert.kind, "telegram_falhou")));
async function runJob(shop: Shop, event: string, orderId: string, signal = new AbortController().signal) {
  const j = { id: crypto.randomUUID(), storeId: shop.storeId, type: "notify_telegram", payload: { event, orderId } } as unknown as Job;
  await notifyTelegramJob(j, signal);
}
const sendCalls = (calls: TgCall[]) => calls.filter((c) => c.url.endsWith("/sendMessage"));

describe("aviso de venda no Telegram", () => {
  test("pedido pago enfileira notify_telegram sale; disputed → paid não enfileira; loja sem Telegram: o job pula sem chamar o fetch", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const first = await tgJobs(o.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.payload).toEqual({ event: "sale", orderId: o.id });
    await withStore(shop.storeId, async (tx) => {
      await transitionOrder(systemCtx(shop.storeId, tx), o.id, "disputed", "teste");
      await transitionOrder(systemCtx(shop.storeId, tx), o.id, "paid", "teste");
    });
    expect(await tgJobs(o.id)).toHaveLength(1);

    const bare = await seedShop({ telegram: false });
    const o2 = await paidOrder(bare);
    const calls = fakeTg(okFor);
    await runJob(bare, "sale", o2.id);
    expect(calls).toHaveLength(0);
    expect(await notices(o2.id)).toHaveLength(0);
  });

  test("sale envia o texto exato e grava telegram_notice (sale) com o message_id", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const calls = fakeTg(okFor);
    await runJob(shop, "sale", o.id);
    const sent = sendCalls(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const [row] = await t.ownerDb.select({ publicId: orders.publicId }).from(orders).where(eq(orders.id, o.id));
    expect(sent[0]!.body.chat_id).toBe(CHAT);
    expect(sent[0]!.body.text).toBe(`Venda: Almanaque + 5 Kits — R$ 36,90 — Pix manual — pedido #${orderCode(row!.publicId)}`);
    const marks = await notices(o.id);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ event: "sale", messageId: 7, storeId: shop.storeId });
  });

  test("nenhuma mensagem contém nome, e-mail, CPF ou telefone do cliente", async () => {
    const shop = await seedShop({ events: { pixGenerated: true, cardDeclined: true, abandoned: true } });
    const paid = await paidOrder(shop);
    const pend = await pendingOrder(shop);
    // Abandono só depois do prazo (o pedido pago segue anterior a ele); card_declined num pedido Pix não sai (o de
    // cartão está em "outros avisos").
    await backdate(paid, 60 * MIN);
    await backdate(pend, 30 * MIN);
    const calls = fakeTg(okFor);
    await runJob(shop, "sale", paid.id);
    await runJob(shop, "pix_generated", pend.id);
    await runJob(shop, "card_declined", pend.id);
    await runJob(shop, "abandoned", pend.id);
    const sent = sendCalls(calls);
    expect(sent).toHaveLength(3);
    const all = JSON.stringify(sent.map((c) => c.body));
    for (const secret of ["Maria", "Teste", BUYER.email, BUYER.cpf, BUYER.phone, "maria.teste"]) expect(all).not.toContain(secret);
  });

  test("oferta com 2 produtos principais usa o nome da oferta", async () => {
    const shop = await seedShop({ twoMains: true });
    const o = await paidOrder(shop);
    const calls = fakeTg(okFor);
    await runJob(shop, "sale", o.id);
    expect(String(sendCalls(calls)[0]!.body.text)).toStartWith("Venda: Combo da loja + 5 Kits — ");
  });

  test("bump sem rótulo usa o nome do produto do bump", async () => {
    const shop = await seedShop({ label: null });
    const o = await paidOrder(shop);
    const calls = fakeTg(okFor);
    await runJob(shop, "sale", o.id);
    expect(String(sendCalls(calls)[0]!.body.text)).toStartWith("Venda: Almanaque + Kit de adesivos — ");
  });

  test("rodar o job duas vezes envia uma vez só; evento desligado na config → pula sem enviar", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const calls = fakeTg(okFor);
    await runJob(shop, "sale", o.id);
    await runJob(shop, "sale", o.id);
    expect(sendCalls(calls)).toHaveLength(1);
    expect(await notices(o.id)).toHaveLength(1);

    const off = await seedShop({ events: { sale: false } });
    const o2 = await paidOrder(off);
    const calls2 = fakeTg(okFor);
    await runJob(off, "sale", o2.id);
    expect(calls2).toHaveLength(0);
    expect(await notices(o2.id)).toHaveLength(0);
  });

  test("pedido reembolsado antes do envio: não envia", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), o.id, "refunded", "teste"));
    const calls = fakeTg(okFor);
    await runJob(shop, "sale", o.id);
    expect(calls).toHaveLength(0);
    expect(await notices(o.id)).toHaveLength(0);
  });

  test("regras dos outros eventos: Pix pago antes do envio, abandono com pagamento depois e cartão recusado", async () => {
    const shop = await seedShop({ events: { pixGenerated: true, cardDeclined: true, abandoned: true } });
    const calls = fakeTg(okFor);
    const first = await pendingOrder(shop);
    const second = await pendingOrder(shop);
    await runJob(shop, "pix_generated", first.id);
    expect(String(sendCalls(calls)[0]!.body.text)).toStartWith("Pix gerado: Almanaque + 5 Kits — R$ 36,90 — pedido #");
    // O mesmo cliente pagou o segundo Pix: o primeiro não é abandono.
    await runAction(releaseOrder, panel(shop.storeId), { orderId: second.id });
    await runJob(shop, "abandoned", first.id);
    await runJob(shop, "pix_generated", second.id);
    await runJob(shop, "card_declined", second.id);
    expect(sendCalls(calls)).toHaveLength(1);
    // Pedido pendente sem pagamento depois: abandono sai com o prazo configurado.
    const lone = await seedShop({ events: { abandoned: true } });
    const o = await pendingOrder(lone);
    await backdate(o, 30 * MIN);
    const calls2 = fakeTg(okFor);
    await runJob(lone, "abandoned", o.id);
    expect(String(sendCalls(calls2)[0]!.body.text)).toStartWith("Carrinho abandonado (30 min sem pagamento): Almanaque + 5 Kits — R$ 36,90 — Pix manual — pedido #");
  });

  test("falha definitiva (403): o job termina sem lançar e grava um aviso telegram_falhou com httpStatus 403; a segunda falha não cria outro; depois de alerts.ack, uma nova falha cria outro", async () => {
    const shop = await seedShop();
    const a = await paidOrder(shop);
    const b = await paidOrder(shop);
    const c = await paidOrder(shop);
    fakeTg(() => json(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked" }));
    await runJob(shop, "sale", a.id);
    const one = await openAlerts(shop.storeId);
    expect(one).toHaveLength(1);
    expect(one[0]!.detail).toEqual({ httpStatus: 403 });
    expect(await notices(a.id)).toHaveLength(0);
    await runJob(shop, "sale", b.id);
    expect(await openAlerts(shop.storeId)).toHaveLength(1);
    await runAction(ackAlert, panel(shop.storeId), { id: one[0]!.id });
    await runJob(shop, "sale", c.id);
    expect(await openAlerts(shop.storeId)).toHaveLength(2);
    // O e-mail ao vendedor leva os mesmos título e texto do painel.
    const mails = await t.ownerDb.select().from(job).where(and(eq(job.type, "notify_seller"), eq(job.storeId, shop.storeId), sql`${job.payload}->>'reason' = 'telegram_falhou'`));
    expect(mails).toHaveLength(2);
  });

  test("grupo que virou supergrupo (400 com migrate_to_chat_id): aviso telegram_falhou com code grupo_migrado e o texto do id novo", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    fakeTg(() =>
      json(400, { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1009876543210 } }),
    );
    await runJob(shop, "sale", o.id);
    const [alert] = await openAlerts(shop.storeId);
    expect(alert!.detail).toEqual({ httpStatus: 400, code: "grupo_migrado" });
    const text = {
      title: "O grupo do Telegram mudou de id",
      body: "O grupo virou supergrupo e ganhou um id novo (começa com -100). Veja o id novo com o @RawDataBot, salve em Conexões e use “Enviar teste”.",
    };
    expect(alertText("telegram_falhou", alert!.detail as object, null)).toEqual(text);
    const [mail] = await t.ownerDb.select().from(job).where(and(eq(job.type, "notify_seller"), eq(job.storeId, shop.storeId), sql`${job.payload}->>'reason' = 'telegram_falhou'`));
    expect(mail!.payload).toEqual({ reason: "telegram_falhou", httpStatus: 400, code: "grupo_migrado" });
    expect(noticeFor("telegram_falhou", mail!.payload as Parameters<typeof noticeFor>[1], null)).toEqual({ subject: text.title, heading: text.title, paragraphs: [text.body] });
    expect(JSON.stringify(alert)).not.toContain("9876543210");
    expect(out).not.toContain("9876543210");
  });

  test("falha temporária (502): o job lança e não grava aviso", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    fakeTg(() => json(502, { ok: false, error_code: 502, description: "Bad Gateway" }));
    await expect(runJob(shop, "sale", o.id)).rejects.toMatchObject({ kind: "temporary", httpStatus: 502 });
    expect(await openAlerts(shop.storeId)).toHaveLength(0);
    expect(await notices(o.id)).toHaveLength(0);
  });

  test("o token não aparece em job.last_error", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    setTelegramFetchForTests((async (url: string | URL | Request) => {
      throw new Error(`fetch failed: ${String(url)}`);
    }) as unknown as typeof fetch);
    await runDueJobs({ notify_telegram: getHandlers().notify_telegram! }, 50, () => new Date(), { types: ["notify_telegram"] });
    const [row] = await tgJobs(o.id);
    expect(row!.status).toBe("queued");
    expect(row!.lastError).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(BOT_TOKEN);
    expect(out).not.toContain(BOT_TOKEN);
  });

  test("alertText(\"telegram_falhou\") tem o título e o texto das restrições globais", () => {
    expect(alertText("telegram_falhou", { httpStatus: 403 }, null)).toEqual({
      title: "O Telegram recusou o aviso da loja",
      body: "Os avisos pararam de chegar ao Telegram. Confira o token do bot e se ele ainda está no grupo, salve em Conexões e use “Enviar teste”.",
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------

const cardDeps: CardDeps = { wait: () => new Promise<void>((r) => setImmediate(r)), verifyTurnstile: async () => true };
let cardSeq = 0;
/** Número de cartão sintético válido (Luhn), um por chamada: o limite por cartão não interfere entre testes. */
function cardNumber(): string {
  const body = `4300000000${String(++cardSeq).padStart(5, "0")}`;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}
let ipSeq = 0;
const cardInput = (orderPublicId: string): CardPaymentInput => ({
  orderPublicId,
  idempotencyKey: crypto.randomUUID(),
  installments: 1,
  card: { holderName: "TITULAR TELEGRAM", number: cardNumber(), expiryMonth: "08", expiryYear: "2034", ccv: "987" },
  holder: { cpf: "52998224725", postalCode: "01310-100", addressNumber: "100" },
  clientIp: `198.18.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
});
const uniqueEmail = () => `c-${crypto.randomUUID()}@example.com`;

/** Loja com Asaas (Pix automático e cartão, produto "Principal" a R$ 9,90) e Telegram com os eventos dados. */
async function seedAsaasTelegram(events: Record<string, boolean>) {
  const fake = createFakeAsaas();
  const shop = await seedAsaasStore(fake);
  fakeTg(okFor);
  await runAction(saveTelegram, panel(shop.storeId), { chatId: CHAT, token: BOT_TOKEN, events });
  return { ...shop, fake };
}
type AsaasShop = Awaited<ReturnType<typeof seedAsaasTelegram>>;
const newOrder = (shop: { storeId: string; offerId: string }, method: "pix_asaas" | "card_asaas", buyer = { ...BUYER, email: uniqueEmail() }) =>
  withStore(shop.storeId, (tx) =>
    createOrder(systemCtx(shop.storeId, tx), {
      offerId: shop.offerId,
      withBump: false,
      method,
      customer: buyer,
      touch: { first: null, last: null },
      clientIp: "203.0.113.7",
      userAgent: "teste",
    }),
  );
/** Recusa `n` vezes o cartão no pedido (o Asaas falso recusa qualquer número enquanto a falha estiver ligada). */
async function declineCard(shop: AsaasShop, publicId: string, n = 1) {
  setAsaasFetchForTests(shop.fake.fetch);
  shop.fake.fail("POST /payments", 400, "Transação não autorizada", "invalid_creditCard");
  try {
    for (let i = 0; i < n; i++) expect((await payWithCard({ storeId: shop.storeId }, cardInput(publicId), cardDeps)).status).toBe("declined");
  } finally {
    shop.fake.clearFailures();
  }
}
const eventOf = (j: Job) => (j.payload as { event: string }).event;
/** Roda, com o handler, os jobs notify_telegram enfileirados do pedido para o evento. */
async function runQueued(orderId: string, event: string): Promise<number> {
  const rows = (await tgJobs(orderId)).filter((j) => eventOf(j) === event);
  for (const j of rows) await notifyTelegramJob(j, new AbortController().signal);
  return rows.length;
}
/** Recua a criação do pedido em `ms` (o prazo do abandono conta de `created_at`). */
const backdate = (o: { id: string; createdAt: Date }, ms: number) =>
  t.ownerDb.update(orders).set({ createdAt: new Date(o.createdAt.getTime() - ms) }).where(eq(orders.id, o.id));
const MIN = 60_000;
const texts = (calls: TgCall[]) => sendCalls(calls).map((c) => String(c.body.text));

describe("outros avisos do Telegram", () => {
  afterEach(() => {
    setAsaasFetchForTests();
    resetCardFingerprintsForTests();
  });

  test("pedido Pix (asaas e manual) enfileira pix_generated; com o evento ligado envia \"Pix gerado: … — pedido #<código>\"", async () => {
    const manual = await seedShop({ events: { pixGenerated: true } });
    const m = await pendingOrder(manual);
    const asaas = await seedAsaasTelegram({ pixGenerated: true });
    const a = await newOrder(asaas, "pix_asaas");
    for (const o of [m, a]) expect((await tgJobs(o.id)).map((j) => j.payload)).toEqual([{ event: "pix_generated", orderId: o.id }]);
    const calls = fakeTg(okFor);
    expect(await runQueued(m.id, "pix_generated")).toBe(1);
    expect(await runQueued(a.id, "pix_generated")).toBe(1);
    expect(texts(calls)).toEqual([
      `Pix gerado: Almanaque + 5 Kits — R$ 36,90 — pedido #${orderCode(m.publicId)}`,
      `Pix gerado: Principal — R$ 9,90 — pedido #${orderCode(a.publicId)}`,
    ]);
    expect((await notices(m.id)).map((n) => n.event)).toEqual(["pix_generated"]);
  });

  test("Pix pago antes do envio não gera \"Pix gerado\"", async () => {
    const shop = await seedShop({ events: { pixGenerated: true } });
    const o = await paidOrder(shop);
    const calls = fakeTg(okFor);
    expect(await runQueued(o.id, "pix_generated")).toBe(1);
    expect(calls).toHaveLength(0);
    expect(await notices(o.id)).toHaveLength(0);
  });

  test("pedido de cartão não enfileira pix_generated", async () => {
    const shop = await seedAsaasTelegram({ pixGenerated: true });
    const o = await newOrder(shop, "card_asaas");
    expect(await tgJobs(o.id)).toHaveLength(0);
  });

  test("cartão recusado enfileira card_declined uma vez por pedido (3 recusas) e envia o texto exato; recusado e depois aprovado antes do envio → não envia", async () => {
    const shop = await seedAsaasTelegram({ cardDeclined: true });
    const o = await newOrder(shop, "card_asaas");
    await declineCard(shop, o.publicId, 3);
    expect((await tgJobs(o.id)).map((j) => j.payload)).toEqual([{ event: "card_declined", orderId: o.id }]);
    const calls = fakeTg(okFor);
    await runQueued(o.id, "card_declined");
    expect(texts(calls)).toEqual([`Cartão recusado: Principal — R$ 9,90 — pedido #${orderCode(o.publicId)}`]);
    expect((await notices(o.id)).map((n) => n.event)).toEqual(["card_declined"]);

    const o2 = await newOrder(shop, "card_asaas");
    await declineCard(shop, o2.publicId);
    setAsaasFetchForTests(shop.fake.fetch);
    expect(await payWithCard({ storeId: shop.storeId }, cardInput(o2.publicId), cardDeps)).toEqual({ status: "approved" });
    const calls2 = fakeTg(okFor);
    expect(await runQueued(o2.id, "card_declined")).toBe(1);
    expect(calls2).toHaveLength(0);
    expect(await notices(o2.id)).toHaveLength(0);
  });

  test("abandono: com o evento ligado, criar o pedido agenda o job para criado + prazo; rodando no prazo com o pedido pending envia o texto", async () => {
    const shop = await seedShop({ events: { abandoned: true } });
    const o = await pendingOrder(shop);
    const scheduled = (await tgJobs(o.id)).filter((j) => eventOf(j) === "abandoned");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.payload).toEqual({ event: "abandoned", orderId: o.id, afterMinutes: 30 });
    expect(scheduled[0]!.runAt.getTime()).toBe(o.createdAt.getTime() + 30 * MIN);
    await backdate(o, 30 * MIN);
    const calls = fakeTg(okFor);
    await notifyTelegramJob(scheduled[0]!, new AbortController().signal);
    expect(texts(calls)).toEqual([`Carrinho abandonado (30 min sem pagamento): Almanaque + 5 Kits — R$ 36,90 — Pix manual — pedido #${orderCode(o.publicId)}`]);
    expect((await notices(o.id)).map((n) => n.event)).toEqual(["abandoned"]);
  });

  test("abandono não sai se o pedido foi pago, nem se o mesmo cliente pagou depois outro pedido da mesma oferta", async () => {
    const shop = await seedShop({ events: { abandoned: true } });
    const paid = await paidOrder(shop);
    const first = await pendingOrder(shop);
    const second = await pendingOrder(shop);
    await runAction(releaseOrder, panel(shop.storeId), { orderId: second.id });
    await backdate(paid, 31 * MIN);
    await backdate(first, 31 * MIN);
    const calls = fakeTg(okFor);
    expect(await runQueued(paid.id, "abandoned")).toBe(1);
    expect(await runQueued(first.id, "abandoned")).toBe(1);
    expect(calls).toHaveLength(0);
    expect([...(await notices(paid.id)), ...(await notices(first.id))]).toHaveLength(0);
  });

  test("abandono com o evento desligado na criação: nada agendado", async () => {
    const shop = await seedShop({ events: { pixGenerated: true } });
    const o = await pendingOrder(shop);
    expect((await tgJobs(o.id)).map(eventOf)).toEqual(["pix_generated"]);
  });

  test("loja sem Telegram ou com \"Pix gerado\" desligado: pedido Pix não cria job notify_telegram", async () => {
    const bare = await seedShop({ telegram: false });
    expect(await tgJobs((await pendingOrder(bare)).id)).toHaveLength(0);
    const off = await seedShop();
    expect(await tgJobs((await pendingOrder(off)).id)).toHaveLength(0);
  });

  test("abandono usa o prazo do agendamento: agendado com 30, config mudada para 60, rodando no minuto 30 envia \"(30 min sem pagamento)\"", async () => {
    const shop = await seedShop({ events: { abandoned: true } });
    const o = await pendingOrder(shop);
    fakeTg(okFor);
    await runAction(saveTelegram, panel(shop.storeId), { chatId: CHAT, abandonAfterMinutes: 60 });
    await backdate(o, 30 * MIN);
    const calls = fakeTg(okFor);
    expect(await runQueued(o.id, "abandoned")).toBe(1);
    expect(texts(calls)).toEqual([`Carrinho abandonado (30 min sem pagamento): Almanaque + 5 Kits — R$ 36,90 — Pix manual — pedido #${orderCode(o.publicId)}`]);
  });

  test("abandono com payload sem afterMinutes (job antigo) usa o prazo da config", async () => {
    const shop = await seedShop({ events: { abandoned: true } });
    fakeTg(okFor);
    await runAction(saveTelegram, panel(shop.storeId), { chatId: CHAT, abandonAfterMinutes: 60 });
    const o = await pendingOrder(shop);
    const calls = fakeTg(okFor);
    await backdate(o, 31 * MIN);
    await runJob(shop, "abandoned", o.id);
    expect(calls).toHaveLength(0);
    expect(await notices(o.id)).toHaveLength(0);
    await backdate(o, 60 * MIN);
    await runJob(shop, "abandoned", o.id);
    expect(texts(calls)).toEqual([`Carrinho abandonado (60 min sem pagamento): Almanaque + 5 Kits — R$ 36,90 — Pix manual — pedido #${orderCode(o.publicId)}`]);
  });

  test("nenhuma mensagem dos três eventos contém dado do cliente", async () => {
    const shop = await seedAsaasTelegram({ pixGenerated: true, cardDeclined: true, abandoned: true });
    const pix = await newOrder(shop, "pix_asaas", BUYER);
    const card = await newOrder(shop, "card_asaas", BUYER);
    await declineCard(shop, card.publicId);
    await backdate(pix, 30 * MIN);
    await backdate(card, 30 * MIN);
    const calls = fakeTg(okFor);
    for (const [o, event] of [[pix, "pix_generated"], [pix, "abandoned"], [card, "card_declined"], [card, "abandoned"]] as const) {
      expect(await runQueued(o.id, event)).toBe(1);
    }
    expect(texts(calls)).toHaveLength(4);
    const all = JSON.stringify(sendCalls(calls).map((c) => c.body));
    for (const secret of ["Maria", "Teste", BUYER.email, BUYER.cpf, BUYER.phone, "maria.teste"]) expect(all).not.toContain(secret);
  });

  test("venda: pedido pago há mais de 24 h não vira aviso; há 23 h ainda sai", async () => {
    const shop = await seedShop();
    const old = await paidOrder(shop);
    const recent = await paidOrder(shop);
    await t.ownerDb.update(orders).set({ paidAt: new Date(Date.now() - 25 * 60 * MIN) }).where(eq(orders.id, old.id));
    await t.ownerDb.update(orders).set({ paidAt: new Date(Date.now() - 23 * 60 * MIN) }).where(eq(orders.id, recent.id));
    const calls = fakeTg(okFor);
    await runJob(shop, "sale", old.id);
    expect(calls).toHaveLength(0);
    expect(await notices(old.id)).toHaveLength(0);
    await runJob(shop, "sale", recent.id);
    expect(texts(calls)).toEqual([`Venda: Almanaque + 5 Kits — R$ 36,90 — Pix manual — pedido #${orderCode(recent.publicId)}`]);
  });

  test("card_declined forjado: pedido Pix ou cartão sem tentativa recusada não envia", async () => {
    const shop = await seedAsaasTelegram({ cardDeclined: true });
    const pix = await newOrder(shop, "pix_asaas");
    const card = await newOrder(shop, "card_asaas");
    const calls = fakeTg(okFor);
    await runJob(shop, "card_declined", pix.id);
    await runJob(shop, "card_declined", card.id);
    expect(calls).toHaveLength(0);
    expect([...(await notices(pix.id)), ...(await notices(card.id))]).toHaveLength(0);
  });

  test("abandoned forjado antes do prazo: não envia e não grava marca; o agendamento legítimo envia depois (tolerância de 5 s)", async () => {
    const shop = await seedShop({ events: { abandoned: true } });
    const o = await pendingOrder(shop);
    const calls = fakeTg(okFor);
    await runJob(shop, "abandoned", o.id);
    await backdate(o, 29 * MIN);
    await runJob(shop, "abandoned", o.id);
    expect(calls).toHaveLength(0);
    expect(await notices(o.id)).toHaveLength(0);
    await backdate(o, 30 * MIN - 3_000);
    expect(await runQueued(o.id, "abandoned")).toBe(1);
    expect(texts(calls)).toHaveLength(1);
    expect((await notices(o.id)).map((n) => n.event)).toEqual(["abandoned"]);
  });

  test("falhas definitivas simultâneas na mesma loja gravam um só aviso telegram_falhou", async () => {
    const shop = await seedShop();
    const paid = [];
    for (let i = 0; i < 5; i++) paid.push(await paidOrder(shop));
    // As 5 respostas só saem quando as 5 chamadas chegaram: as gravações do aviso começam juntas.
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    let arrived = 0;
    setTelegramFetchForTests((async () => {
      if (++arrived === paid.length) release();
      await all;
      return json(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked" });
    }) as unknown as typeof fetch);
    await Promise.all(paid.map((o) => runJob(shop, "sale", o.id)));
    expect(await openAlerts(shop.storeId)).toHaveLength(1);
  });
});
