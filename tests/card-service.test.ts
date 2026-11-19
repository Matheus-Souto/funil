// Serviço de cartão isolado (servidor node:http): formulário do iframe, POST /api/card, arquivos e /healthz.
// O servidor roda numa porta efêmera com o `payWithCard` real (embrulhado num espião), o banco de teste com o `db`
// apontado para o papel `card` e o Asaas falso. O preparo (loja, oferta, pedidos) roda antes, com o papel `app`.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import { cardFormCsp, cardFormHtml } from "@/card-service/page";
import { createCardServer, type CardServerOptions } from "@/card-service/server";
import { db, setDbForTests } from "@/lib/db/client";
import { integration, orders } from "@/lib/db/schema";
import { env, requireSecret } from "@/lib/env";
import { createIntegrationSecrets } from "@/lib/integrations";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { payWithCard, type CardDeps, type CardPaymentInput } from "@/lib/payments/asaas/card";
import { CARD_TICKET_TTL_MS, issueCardTicket } from "@/lib/payments/card-ticket";
import { resetCardFingerprintsForTests } from "@/lib/payments/ratelimit";
import { HEAVY_TEST_MS, createTestDb, seedStore, type TestDb } from "./db";
import { createFakeAsaas, newCardOrder, seedAsaasStore } from "./asaas-helpers";

const KEY = "chave-do-bilhete-de-teste-".repeat(2);
const CARD_ORIGIN = "http://127.0.0.1:3100";
const APP_ORIGIN = new URL(env.BASE_URL).origin;
const APPROVE = "4444444444444444";
const DECLINE = "5184019740373151";
const HOLDER = "TITULAR SERVICO OMEGA";
const tick = () => new Promise<void>((r) => setImmediate(r));
const fastDeps: CardDeps = { wait: tick };

type Order = Awaited<ReturnType<typeof newCardOrder>>;
let t: TestDb;
let shop: { storeId: string; offerId: string };
let other: { storeId: string; offerId: string };
let o: { approve: Order; decline: Order; foreign: Order; crossed: Order; logs: Order; logsDecline: Order; invalid: Order };

const servers: Server[] = [];
let payCalls = 0;
/** O `payWithCard` real, contando as chamadas (o servidor só o chama depois de todas as checagens). */
const spyPay = (async (call: { storeId: string }, input: CardPaymentInput) => {
  payCalls++;
  return payWithCard(call, input, fastDeps);
}) as typeof payWithCard;

beforeAll(async () => {
  t = await createTestDb();
  const fake = createFakeAsaas();
  shop = await seedAsaasStore(fake, 1000);
  other = await seedAsaasStore(fake, 1000);
  const mk = (s: { storeId: string; offerId: string }) => newCardOrder(s.storeId, s.offerId, `c-${randomUUID()}@example.com`);
  o = {
    approve: await mk(shop),
    decline: await mk(shop),
    foreign: await mk(other),
    crossed: await mk(shop),
    logs: await mk(shop),
    logsDecline: await mk(shop),
    invalid: await mk(shop),
  };
  setAsaasFetchForTests(fake.fetch);
  // Daqui em diante o `db` do processo é o do papel `card`, como no serviço isolado.
  await setDbForTests({ appUrl: t.cardUrl, ownerUrl: t.url });
}, HEAVY_TEST_MS);
afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  setAsaasFetchForTests();
  await t.drop();
});
afterEach(() => {
  resetCardFingerprintsForTests();
});

async function start(over: Partial<CardServerOptions> = {}): Promise<string> {
  const server = createCardServer({ cardOrigin: CARD_ORIGIN, ticketKey: KEY, trustProxy: 0, payWithCard: spyPay, ...over });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ticketFor = (storeId: string, order: Order, now = new Date()) =>
  issueCardTicket({ storeId, orderId: order.id, publicId: order.publicId }, KEY, now);

/** Corpo como o iframe de `/form/<storeId>` manda; `storeId` padrão: a loja `shop`. */
function cardBody(order: Order, ticket: string, over: Record<string, unknown> = {}) {
  return {
    storeId: shop.storeId,
    ticket,
    orderPublicId: order.publicId,
    idempotencyKey: randomUUID(),
    installments: 1,
    card: { holderName: HOLDER, number: APPROVE, expiryMonth: "08", expiryYear: "2034", ccv: "987" },
    holder: { cpf: "52998224725", postalCode: "01310-100", addressNumber: "100" },
    ...over,
  };
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/card`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: CARD_ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const orderStatus = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!.status;

/** Captura stdout/stderr e console.* (tudo o que `log` ou um console.* escreveria). */
function captureOutput() {
  const chunks: string[] = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const cons = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const grab = ((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = grab;
  process.stderr.write = grab;
  for (const k of Object.keys(cons) as (keyof typeof cons)[]) console[k] = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  return {
    text: () => chunks.join("\n"),
    restore() {
      process.stdout.write = out;
      process.stderr.write = err;
      Object.assign(console, cons);
    },
  };
}

/**
 * POST cru por socket com `Transfer-Encoding: chunked` (sem Content-Length), em pedaços de `chunk` bytes.
 * Devolve o status e o bloco de cabeçalhos da resposta (o servidor pode fechar antes de o corpo terminar).
 */
function chunkedPost(port: number, path: string, headers: Record<string, string>, body: string, chunk: number) {
  return new Promise<{ status: number; headers: string }>((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let got = "";
    sock.on("data", (d) => (got += d.toString("latin1")));
    sock.on("error", (e: NodeJS.ErrnoException) => {
      // O servidor pode fechar ao estourar o teto enquanto ainda escrevemos: vale o que já chegou.
      if (got.includes("\r\n\r\n")) return;
      if (e.code !== "EPIPE" && e.code !== "ECONNRESET") reject(e);
    });
    sock.on("close", () => {
      const end = got.indexOf("\r\n\r\n");
      if (end < 0) return reject(new Error(`resposta incompleta: ${JSON.stringify(got.slice(0, 200))}`));
      const head = got.slice(0, end);
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), headers: head });
    });
    const lines = Object.entries({ host: `127.0.0.1:${port}`, ...headers, "transfer-encoding": "chunked", connection: "close" });
    sock.write(`POST ${path} HTTP/1.1\r\n${lines.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    for (let i = 0; i < body.length; i += chunk) {
      const part = body.slice(i, i + chunk);
      sock.write(`${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`);
    }
    sock.write("0\r\n\r\n");
  });
}

const directives = (csp: string) => csp.split(";").map((d) => d.trim());

describe("POST /api/card: bilhete", () => {
  test("bilhete ausente, inválido, forjado ou vencido -> 403 sem chamar payWithCard; só o vencido diz ticketExpired", async () => {
    const base = await start();
    const before = payCalls;
    const valid = ticketFor(shop.storeId, o.approve);
    const [p, s] = valid.split(".") as [string, string];
    const cases: [unknown, boolean][] = [
      [undefined, false],
      ["", false],
      [42, false],
      ["lixo.lixo", false],
      [`${p}.${s.slice(0, 42)}${s[42] === "A" ? "B" : "A"}`, false],
      [issueCardTicket({ storeId: shop.storeId, orderId: o.approve.id, publicId: o.approve.publicId }, "outra-chave-".repeat(4)), false],
      [ticketFor(shop.storeId, o.approve, new Date(Date.now() - CARD_TICKET_TTL_MS - 60_000)), true],
    ];
    for (const [ticket, expired] of cases) {
      const res = await post(base, cardBody(o.approve, ticket as string));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "ticket", ticketExpired: expired });
    }
    expect(payCalls).toBe(before);
    expect(await orderStatus(o.approve.id)).toBe("pending");
  });

  test("bilhete de outro pedido (de outra loja) para este pedido -> 403 sem chamar payWithCard", async () => {
    const base = await start();
    const before = payCalls;
    const res = await post(base, cardBody(o.approve, ticketFor(other.storeId, o.foreign)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "ticket", ticketExpired: false });
    expect(payCalls).toBe(before);
  });

  test("loja da página do iframe diferente da loja do bilhete (ou ausente) -> 403 sem chamar payWithCard", async () => {
    const base = await start();
    const before = payCalls;
    const ticket = ticketFor(shop.storeId, o.approve);
    for (const storeId of [other.storeId, undefined, "", 42, shop.storeId.toUpperCase()]) {
      const res = await post(base, cardBody(o.approve, ticket, { storeId }));
      expect([storeId, res.status]).toEqual([storeId, 403]);
      expect(await res.json()).toEqual({ error: "forbidden_store", message: "Requisição recusada." });
    }
    expect(payCalls).toBe(before);
    expect(await orderStatus(o.approve.id)).toBe("pending");
  });

  test("bilhete com a loja errada para o publicId: a cobrança roda na loja do bilhete e não acha o pedido (404)", async () => {
    const base = await start();
    const res = await post(base, cardBody(o.crossed, issueCardTicket({ storeId: other.storeId, orderId: o.crossed.id, publicId: o.crossed.publicId }, KEY), { storeId: other.storeId }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Pedido não encontrado" });
    expect(await orderStatus(o.crossed.id)).toBe("pending");
  });
});

describe("POST /api/card: origem, tipo, HTTPS e tamanho (antes de qualquer trabalho)", () => {
  test("Origin de outro site, do app, 'null' ou ausente -> 403", async () => {
    const base = await start();
    const before = payCalls;
    const body = cardBody(o.approve, ticketFor(shop.storeId, o.approve));
    for (const origin of ["https://evil.example", APP_ORIGIN, "null", `${CARD_ORIGIN}/`, "http://127.0.0.1:3101"]) {
      const res = await post(base, body, { origin });
      expect(res.status).toBe(403);
      expect(res.headers.get("connection")).toBe("close");
      expect((await res.json()).error).toBe("forbidden_origin");
    }
    const noOrigin = await fetch(`${base}/api/card`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(noOrigin.status).toBe(403);
    expect(payCalls).toBe(before);
  });

  test("Content-Type text/plain, form ou ausente -> 403", async () => {
    const base = await start();
    const before = payCalls;
    const body = JSON.stringify(cardBody(o.approve, ticketFor(shop.storeId, o.approve)));
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await post(base, body, { "content-type": type });
      expect(res.status).toBe(403);
      expect(res.headers.get("connection")).toBe("close");
      expect((await res.json()).error).toBe("forbidden_origin");
    }
    const blob = await fetch(`${base}/api/card`, { method: "POST", headers: { origin: CARD_ORIGIN }, body: new Blob([body]) });
    expect(blob.status).toBe(403);
    expect(payCalls).toBe(before);
  });

  test("corpo maior que 16 KiB -> 413 sem chamar payWithCard", async () => {
    const base = await start();
    const before = payCalls;
    const res = await post(base, cardBody(o.approve, ticketFor(shop.storeId, o.approve), { pad: "x".repeat(17 * 1024) }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too_large");
    expect(payCalls).toBe(before);
  });

  test("corpo chunked sem Content-Length: 16 KiB exatos passam do teto; 1 byte a mais -> 413 (contagem em streaming)", async () => {
    const base = await start();
    const before = payCalls;
    const port = new URL(base).port;
    /** JSON com bilhete inválido e `pad` até `size` bytes (chega ao bilhete se o corpo couber no teto). */
    const bodyOf = (size: number) => {
      const head = '{"ticket":"x","pad":"';
      return `${head}${"x".repeat(size - head.length - 2)}"}`;
    };
    for (const [size, status] of [
      [16 * 1024, 403],
      [16 * 1024 + 1, 413],
      [64 * 1024, 413],
    ] as const) {
      const body = bodyOf(size);
      expect(Buffer.byteLength(body)).toBe(size);
      const raw = await chunkedPost(Number(port), "/api/card", { "content-type": "application/json", origin: CARD_ORIGIN }, body, 1000);
      expect([size, raw.status]).toEqual([size, status]);
      expect(raw.headers).not.toMatch(/^content-length: 1[0-9]{4,}/im);
      if (status === 413) expect(raw.headers).toMatch(/^connection: close/im);
    }
    expect(payCalls).toBe(before);
  });

  test("JSON inválido ou que não é objeto -> 400", async () => {
    const base = await start();
    for (const raw of ["{nao json", "[]", "null", "1"]) {
      const res = await post(base, raw);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_input");
    }
  });

  test("origem https: exige X-Forwarded-Proto https de proxy confiável; sem proxy confiável, sempre recusa", async () => {
    const httpsOrigin = "https://pagar.example.com";
    const proxied = await start({ cardOrigin: httpsOrigin, trustProxy: 1 });
    const direct = await start({ cardOrigin: httpsOrigin, trustProxy: 0 });
    const body = { ticket: "x" };
    const plain = await post(proxied, body, { origin: httpsOrigin });
    expect(plain.status).toBe(403);
    expect(plain.headers.get("connection")).toBe("close");
    expect((await plain.json()).error).toBe("https_required");
    const http = await post(proxied, body, { origin: httpsOrigin, "x-forwarded-proto": "http" });
    expect((await http.json()).error).toBe("https_required");
    // Passa da checagem de HTTPS e para no bilhete.
    const ok = await post(proxied, body, { origin: httpsOrigin, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" });
    expect(ok.status).toBe(403);
    expect((await ok.json()).error).toBe("ticket");
    const forged = await post(direct, body, { origin: httpsOrigin, "x-forwarded-proto": "https" });
    expect((await forged.json()).error).toBe("https_required");
  });

  test("IP do comprador: com proxy confiável, a entrada da direita do X-Forwarded-For; o clientIp do corpo é ignorado", async () => {
    const seen: CardPaymentInput[] = [];
    const base = await start({
      trustProxy: 1,
      payWithCard: (async (_c: { storeId: string }, i: CardPaymentInput) => {
        seen.push(i);
        return { status: "approved" };
      }) as typeof payWithCard,
    });
    const res = await post(base, cardBody(o.approve, ticketFor(shop.storeId, o.approve), { clientIp: "1.2.3.4" }), {
      "x-forwarded-for": "6.6.6.6, 203.0.113.50",
    });
    expect(res.status).toBe(200);
    expect(seen.map((i) => i.clientIp)).toEqual(["203.0.113.50"]);
    expect(Object.keys(seen[0]!)).not.toContain("ticket");
  });
});

describe("POST /api/card: cobrança com o payWithCard real (papel card)", () => {
  test("aprovação -> { status: approved } e pedido pago", async () => {
    const base = await start();
    const res = await post(base, cardBody(o.approve, ticketFor(shop.storeId, o.approve)));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "approved" });
    expect(await orderStatus(o.approve.id)).toBe("paid");
  }, HEAVY_TEST_MS);

  test("cartão de recusa -> declined e pedido pendente", async () => {
    const base = await start();
    const res = await post(base, cardBody(o.decline, ticketFor(shop.storeId, o.decline), { card: { holderName: HOLDER, number: DECLINE, expiryMonth: "08", expiryYear: "2034", ccv: "987" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("declined");
    expect(await orderStatus(o.decline.id)).toBe("pending");
  }, HEAVY_TEST_MS);

  test("dados inválidos -> 400 só com os caminhos dos campos, sem ecoar o cartão", async () => {
    const base = await start();
    const res = await post(base, cardBody(o.invalid, ticketFor(shop.storeId, o.invalid), { card: { holderName: HOLDER, number: APPROVE, expiryMonth: "08", expiryYear: "2034", ccv: "1" } }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid_input", message: "Dados de pagamento inválidos", fields: [["card", "ccv"]] });
    expect(text).not.toContain("4444");
    expect(text).not.toContain(HOLDER);
  });

  test("nenhuma linha de log contém o número nem o nome impresso do cartão (aprovação, recusa e erro inesperado)", async () => {
    const base = await start();
    const boom = await start({
      payWithCard: (async (_c: { storeId: string }, i: CardPaymentInput) => {
        throw new Error(`falhou com ${i.card.number} ${i.card.holderName}`);
      }) as typeof payWithCard,
    });
    const cap = captureOutput();
    let failed: Response;
    try {
      expect((await (await post(base, cardBody(o.logs, ticketFor(shop.storeId, o.logs)))).json()).status).toBe("approved");
      const decline = cardBody(o.logsDecline, ticketFor(shop.storeId, o.logsDecline), {
        card: { holderName: HOLDER, number: DECLINE, expiryMonth: "08", expiryYear: "2034", ccv: "987" },
      });
      expect((await (await post(base, decline)).json()).status).toBe("declined");
      failed = await post(boom, cardBody(o.logs, ticketFor(shop.storeId, o.logs)));
    } finally {
      cap.restore();
    }
    expect(failed!.status).toBe(500);
    expect(await failed!.json()).toEqual({
      error: "internal",
      message: "Não foi possível processar o pagamento. Verifique em instantes antes de tentar de novo.",
    });
    // O erro inesperado é registrado só com nome e código: nada do texto livre (que pode trazer dados do comprador).
    expect(cap.text()).toContain("checkout cartão: erro inesperado");
    expect(cap.text()).toContain('"errorName":"Error"');
    for (const secret of [APPROVE, DECLINE, "44444444", "51840197", HOLDER, "falhou com"]) expect(cap.text()).not.toContain(secret);
  }, HEAVY_TEST_MS);

  test("erro fora da cobrança (catch externo) -> 500 sem corpo; o log só tem nome e código do erro", async () => {
    const base = await start({
      origins: async () => {
        throw Object.assign(new TypeError(`falhou com ${APPROVE} ${HOLDER}`), { code: "E_TESTE" });
      },
    });
    const cap = captureOutput();
    let res: Response;
    try {
      res = await fetch(`${base}/form/${shop.storeId}`);
    } finally {
      cap.restore();
    }
    expect(res!.status).toBe(500);
    expect(await res!.text()).toBe("");
    expect(res!.headers.get("content-security-policy")).toBeNull();
    expect(cap.text()).toContain("serviço de cartão: erro inesperado");
    expect(cap.text()).toContain('"errorName":"TypeError"');
    expect(cap.text()).toContain('"errorCode":"E_TESTE"');
    for (const secret of [APPROVE, "44444444", HOLDER, "falhou com"]) expect(cap.text()).not.toContain(secret);
  });
});

describe("catch externo: o log identifica o erro sem texto livre", () => {
  async function outerCatchLog(thrower: () => Promise<string[]>) {
    const base = await start({ origins: thrower });
    const cap = captureOutput();
    let res: Response;
    try {
      res = await fetch(`${base}/form/${shop.storeId}`);
    } finally {
      cap.restore();
    }
    expect(res!.status).toBe(500);
    expect(await res!.text()).toBe("");
    const text = cap.text();
    for (const secret of [APPROVE, "44444444", HOLDER]) expect(text).not.toContain(secret);
    return text;
  }

  test("erro do drizzle (consulta real, papel card): SQLSTATE no log; nem SQL nem parâmetros", async () => {
    const text = await outerCatchLog(async () => {
      await db.execute(sql`select * from tabela_que_nao_existe where nome = ${HOLDER} and n = ${APPROVE}`);
      return [];
    });
    expect(text).toContain('"errorName":"DrizzleQueryError"');
    expect(text).toContain('"sqlState":"42P01"');
    expect(text).not.toContain("tabela_que_nao_existe");
  });

  test("provider_error do Asaas: code, mensagem e status no log", async () => {
    const text = await outerCatchLog(async () => {
      throw new ActionError("provider_error", "Erro no Asaas (HTTP 503)", { status: 503, errorCodes: [] });
    });
    expect(text).toContain('"errorCode":"provider_error"');
    expect(text).toContain('"errorMessage":"Erro no Asaas (HTTP 503)"');
    expect(text).toContain('"status":503');
  });
});

describe("GET /form/<storeId>", () => {
  test("HTML com cabeçalhos, CSP exata e frame-ancestors só com as origens da loja", async () => {
    const base = await start();
    const res = await fetch(`${base}/form/${shop.storeId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(cardFormCsp([APP_ORIGIN]));
    const fa = directives(csp).find((d) => d.startsWith("frame-ancestors "))!;
    expect(fa.split(/\s+/).slice(1)).toEqual([APP_ORIGIN]);
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="/form.css">');
    expect(html).toContain('<script src="/form.js" defer></script>');
    const cfg = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(html)!;
    expect(JSON.parse(cfg[1]!)).toEqual({ allowedOrigins: [APP_ORIGIN], storeId: shop.storeId });
    const upper = await (await fetch(`${base}/form/${shop.storeId.toUpperCase()}`)).text();
    const cfgUpper = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(upper)!;
    expect((JSON.parse(cfgUpper[1]!) as { storeId: string }).storeId).toBe(shop.storeId);
  });

  test("origens injetadas (multi): frame-ancestors tem exatamente essas; nada da Cloudflare (o Turnstile fica no checkout)", async () => {
    const origins = ["https://loja.example.com", "https://loja.plataforma.com.br"];
    const base = await start({ origins: async (id) => (id === shop.storeId ? origins : []) });
    const res = await fetch(`${base}/form/${shop.storeId}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(directives(csp).find((d) => d.startsWith("frame-ancestors "))).toBe(`frame-ancestors ${origins.join(" ")}`);
    expect(csp).toBe(cardFormCsp(origins));
    expect(csp).not.toContain("challenges.cloudflare.com");
    const cfg = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(await res.text())!;
    expect(JSON.parse(cfg[1]!)).toEqual({ allowedOrigins: origins, storeId: shop.storeId });
    expect((await fetch(`${base}/form/${other.storeId}`)).status).toBe(404);
  });

  test("o HTML não tem script inline executável, handler on* nem javascript:", async () => {
    const base = await start();
    const html = await (await fetch(`${base}/form/${shop.storeId}`)).text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBe(2);
    for (const [, attrs, body] of scripts) {
      if (/\bsrc=/.test(attrs!)) expect(body!.trim()).toBe("");
      else expect(attrs!.trim()).toBe('type="application/json" id="cfg"');
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    const csp = (await fetch(`${base}/form/${shop.storeId}`)).headers.get("content-security-policy")!;
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("storeId inválido, loja inexistente ou sem origens -> 404 sem corpo", async () => {
    const base = await start();
    const none = await start({ origins: async () => [] });
    for (const [b, path] of [
      [base, "/form/nao-uuid"],
      [base, `/form/${randomUUID()}`],
      [base, `/form/${shop.storeId}/x`],
      [base, "/form/"],
      [none, `/form/${shop.storeId}`],
    ] as const) {
      const res = await fetch(`${b}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });
});

describe("page.ts", () => {
  test("cardFormCsp: política exata, só scripts do próprio domínio (nenhum de terceiro, nem o Turnstile)", () => {
    const o1 = ["https://a.example", "https://b.example"];
    const off = cardFormCsp(o1);
    expect(off).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors https://a.example https://b.example",
    );
    expect(off).not.toContain("challenges.cloudflare.com");
  });

  test("a configuração no JSON não fecha o <script> (chave com </script> e caracteres de linha)", () => {
    const evil = "</script><script>alert(1)</script>\u2028&";
    const sid = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
    const html = cardFormHtml({ storeId: sid, allowedOrigins: ["https://a.example", evil] });
    expect(html.match(/<\/script>/gi)!.length).toBe(2);
    expect(html).not.toContain("<script>alert");
    const cfg = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(html)!;
    expect(JSON.parse(cfg[1]!)).toEqual({ allowedOrigins: ["https://a.example", evil], storeId: sid });
  });
});

describe("arquivos do formulário, /healthz e rotas fora da lista", () => {
  test("sem assetsDir, /form.js e /form.css dão 404", async () => {
    const base = await start();
    for (const p of ["/form.js", "/form.css"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  test("com assetsDir, só os dois nomes fixos, com cache curto e nosniff; nada mais do diretório", async () => {
    const dir = mkdtempSync(join(tmpdir(), "card-assets-"));
    writeFileSync(join(dir, "form.js"), "console.log('form')");
    writeFileSync(join(dir, "form.css"), "body{margin:0}");
    writeFileSync(join(dir, "server.js"), "segredo");
    const base = await start({ assetsDir: dir });
    const js = await fetch(`${base}/form.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(js.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await js.text()).toBe("console.log('form')");
    const css = await fetch(`${base}/form.css?v=../../server.js`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{margin:0}");
    for (const p of ["/server.js", "/form.js/../server.js", "/%2e%2e/server.js", "/assets/form.js", "/form.js/", "/FORM.JS"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  test("timeouts e teto de conexões: cabeçalhos 10 s, corpo em 15 s (corpo lento não prende conexão), keep-alive 5 s, 256 conexões", () => {
    const server = createCardServer({ cardOrigin: CARD_ORIGIN, ticketKey: KEY, trustProxy: 0 });
    expect({
      headersTimeout: server.headersTimeout,
      requestTimeout: server.requestTimeout,
      keepAliveTimeout: server.keepAliveTimeout,
      maxConnections: server.maxConnections,
    }).toEqual({ headersTimeout: 10_000, requestTimeout: 15_000, keepAliveTimeout: 5_000, maxConnections: 256 });
  });

  test("/healthz -> 200 ok com o banco respondendo", async () => {
    const base = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("GET /admin, GET /api/checkout/card, PUT /api/card e afins -> 404 sem corpo", async () => {
    const base = await start();
    const cases: [string, string][] = [
      ["GET", "/admin"],
      ["GET", "/api/checkout/card"],
      ["POST", "/api/checkout/card"],
      ["PUT", "/api/card"],
      ["GET", "/api/card"],
      ["DELETE", "/api/card"],
      ["POST", `/form/${shop.storeId}`],
      ["HEAD", "/healthz"],
      ["POST", "/healthz"],
      ["GET", "/"],
      ["GET", "/c/loja"],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${base}${path}`, { method, headers: { origin: CARD_ORIGIN, "content-type": "application/json" }, ...(method === "PUT" ? { body: "{}" } : {}) });
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(await res.text()).toBe("");
    }
  });
});

describe("main.ts: subida do serviço", () => {
  const MAIN = join(import.meta.dir, "..", "src", "card-service", "main.ts");
  const cardEnv = (over: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    SERVICE: "card",
    BASE_URL: "http://localhost:3000",
    DATABASE_URL: t.cardUrl,
    CARD_ORIGIN: CARD_ORIGIN,
    CARD_TICKET_KEY: "t".repeat(40),
    ASAAS_SEAL_KEY: "s".repeat(40),
    ...over,
  });
  /** Roda o main.ts num processo à parte (cwd vazio: nenhum .env é carregado) e espera ele sair. */
  async function boot(envVars: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, MAIN], {
      cwd: mkdtempSync(join(tmpdir(), "card-main-")),
      env: envVars,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return { code, out: (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text()) };
  }

  test("ASAAS_SEAL_KEY que não abre a conexão a1 de uma loja: não sobe (exit 1), com a contagem e sem valores", async () => {
    const sealKey = "a".repeat(40);
    const { storeId } = await seedStore("Selada");
    const sealed = createIntegrationSecrets({ secret: requireSecret(), asaasKey: sealKey }).seal("asaas", "chave-asaas-secreta");
    await t.ownerDb.insert(integration).values({ storeId, kind: "asaas", config: { env: "sandbox" }, secret: sealed });
    const r = await boot(cardEnv({ ASAAS_SEAL_KEY: "b".repeat(40) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "ASAAS_SEAL_KEY ausente ou diferente da que selou a conexão Asaas de 1 loja(s); restaure a chave correta",
    );
    expect(r.out).not.toContain("b".repeat(40));
    expect(r.out).not.toContain("chave-asaas-secreta");
  }, HEAVY_TEST_MS);

  test("SECRET no ambiente do serviço de cartão: não sobe (exit 1)", async () => {
    const r = await boot(cardEnv({ SECRET: "x".repeat(40) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("SECRET não pode ser passado ao serviço de cartão");
    expect(r.out).not.toContain("x".repeat(40));
  }, HEAVY_TEST_MS);

  test("TRUST_PROXY=0 com CARD_ORIGIN https: não sobe (exit 1), antes de tocar o banco", async () => {
    const r = await boot(cardEnv({ CARD_ORIGIN: "https://pagar.example.com", TRUST_PROXY: "0", DATABASE_URL: "postgres://card:x@127.0.0.1:1/nada" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "TRUST_PROXY=0 com CARD_ORIGIN https: todo pagamento seria recusado; defina TRUST_PROXY (atrás do Caddy: 1)",
    );
    expect(r.out).not.toContain("ASAAS_SEAL_KEY");
  }, HEAVY_TEST_MS);

  test("SERVICE=app: não sobe (exit 1)", async () => {
    const r = await boot(cardEnv({ SERVICE: "app", SECRET: "y".repeat(40) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("SERVICE=card");
  }, HEAVY_TEST_MS);
});
