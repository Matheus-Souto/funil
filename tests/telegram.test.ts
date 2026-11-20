import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
