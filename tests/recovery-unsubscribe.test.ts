// Descadastro da recuperação de vendas (`/sair/<token>`, src/lib/recovery/unsubscribe.ts): GET só mostra o botão (não grava
// nada, nem o contador de limite); POST (o botão ou o um clique RFC 8058) grava `email_optout` e apaga os contatos abertos
// do mesmo e-mail na loja. Token de outra loja, inventado, malformado ou vencido: a mesma página neutra. 30 POSTs por IP
// por hora. Resposta sem o e-mail; log sem token, hash nem e-mail.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { randomToken } from "@/lib/crypto";
import { checkoutLead, emailOptout, rateLimit, recoveryEmail, store } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { handleUnsubscribePage, handleUnsubscribePost, UNSUB_LIMIT } from "@/lib/recovery/unsubscribe";
import { GET, POST } from "@/app/sair/[token]/route";
import { createTestDb, type TestDb } from "./db";
import { seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const DAY_MS = 86_400_000;
const INVALID = "Este link não vale mais";
const INVALID_NOTE = "Se quiser, responda a um e-mail da loja.";

type Shop = { storeId: string; offerId: string; name: string; resolve: () => Promise<{ id: string; slug: string; name: string }> };

async function seedShop(name = "Maná Kids"): Promise<Shop> {
  const p = await seedPanelStore(name);
  const [s] = await t.ownerDb.select({ slug: store.slug, name: store.name }).from(store).where(eq(store.id, p.storeId));
  return { storeId: p.storeId, offerId: p.offerId, name: s!.name, resolve: async () => ({ id: p.storeId, slug: s!.slug, name: s!.name }) };
}

/** Lembrete enviado para `email` (caixa `mailbox`), com o token de descadastro em claro (só existe no link do e-mail). */
async function seedReminder(shop: Shop, email: string, mailbox = email): Promise<string> {
  const token = randomToken(32);
  await t.ownerDb.insert(recoveryEmail).values({
    storeId: shop.storeId,
    offerId: shop.offerId,
    kind: "lead",
    emailHash: sha(email),
    mailboxHash: sha(mailbox),
    unsubHash: sha(token),
    status: "sent",
    dueAt: new Date(),
    sentAt: new Date(),
    expiresAt: new Date(Date.now() + 90 * DAY_MS),
  });
  return token;
}

async function seedLead(shop: Shop, email: string, status: "open" | "contacted" | "converted"): Promise<string> {
  const [l] = await t.ownerDb
    .insert(checkoutLead)
    .values({
      storeId: shop.storeId,
      offerId: shop.offerId,
      keyHash: sha(randomUUID()),
      email: status === "converted" ? null : email,
      emailHash: sha(email),
      status,
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
    })
    .returning({ id: checkoutLead.id });
  return l!.id;
}

const newEmail = () => `cliente.${randomUUID()}@exemplo.com`;
const newIp = () => `203.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const optoutsOf = (storeId: string) => t.ownerDb.select().from(emailOptout).where(eq(emailOptout.storeId, storeId));
const leadIdsOf = async (storeId: string) =>
  (await t.ownerDb.select({ id: checkoutLead.id }).from(checkoutLead).where(eq(checkoutLead.storeId, storeId))).map((r) => r.id).sort();
const unsubKeysOf = async (storeId: string) =>
  (await t.ownerDb.select({ key: rateLimit.key }).from(rateLimit).where(like(rateLimit.key, `recovery:unsub:ip:${storeId}:%`))).map((r) => r.key);

const HOST = "loja.exemplo.com";
type Init = { ip?: string; oneClick?: boolean; headers?: Record<string, string>; now?: Date };
function reqFor(token: string, method: "GET" | "POST", init: Init = {}): Request {
  const headers: Record<string, string> = { host: HOST, ...(init.ip ? { "x-forwarded-for": init.ip } : {}), ...init.headers };
  if (method === "GET") return new Request(`https://${HOST}/sair/${token}`, { method, headers });
  // Os dois POSTs mandam o mesmo corpo; o botão da página vem do navegador (mesma origem), o um clique do servidor do
  // provedor de e-mail (sem Origin nem Sec-Fetch-Site).
  headers["content-type"] = "application/x-www-form-urlencoded";
  if (!init.oneClick) headers["sec-fetch-site"] ??= "same-origin";
  return new Request(`https://${HOST}/sair/${token}`, { method, headers, body: "List-Unsubscribe=One-Click" });
}
const opts = (shop: Pick<Shop, "resolve">, init: Init) => ({
  resolveStore: shop.resolve,
  trustProxy: init.ip ? 1 : 0,
  ...(init.now ? { now: () => init.now! } : {}),
});
const view = (shop: Pick<Shop, "resolve">, token: string, init: Init = {}) => handleUnsubscribePage(reqFor(token, "GET", init), token, opts(shop, init));
const post = (shop: Pick<Shop, "resolve">, token: string, init: Init = {}) => handleUnsubscribePost(reqFor(token, "POST", init), token, opts(shop, init));

function expectPageHeaders(r: Response): void {
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("content-security-policy")).toContain("form-action 'self'");
}

describe("descadastro /sair/<token>", () => {
  test("GET com token válido → 200 com o botão e nenhuma linha em email_optout", async () => {
    const shop = await seedShop();
    const email = newEmail();
    const token = await seedReminder(shop, email);
    const open = await seedLead(shop, email, "open");
    const r = await view(shop, token, { ip: newIp() });
    expect(r.status).toBe(200);
    expectPageHeaders(r);
    const html = await r.text();
    expect(html).toContain(`Não quer mais receber lembretes da ${shop.name}?`);
    expect(html).toContain("Não quero mais receber");
    // O formulário volta para a mesma URL (sem `action` absoluto) com o mesmo corpo do um clique.
    expect(html).toContain('<form method="post">');
    expect(html).toContain('<input type="hidden" name="List-Unsubscribe" value="One-Click">');
    expect(html).not.toContain("action=");
    expect(await optoutsOf(shop.storeId)).toEqual([]);
    expect(await leadIdsOf(shop.storeId)).toEqual([open]);
    // GET nunca grava nada, nem o contador de limite.
    expect(await unsubKeysOf(shop.storeId)).toEqual([]);
  });

  test("POST com token válido → optout gravado e contatos abertos do e-mail apagados (os convertidos ficam)", async () => {
    const shop = await seedShop();
    const other = await seedShop("Outra Loja");
    const email = newEmail();
    const token = await seedReminder(shop, email);
    await seedLead(shop, email, "open");
    await seedLead(shop, email, "contacted");
    const converted = await seedLead(shop, email, "converted");
    const someoneElse = await seedLead(shop, newEmail(), "open");
    const otherStore = await seedLead(other, email, "open");

    const r = await post(shop, token, { ip: newIp() });
    expect(r.status).toBe(200);
    expectPageHeaders(r);
    expect(await r.text()).toContain(`Pronto: a ${shop.name} não vai mais mandar lembretes de compra para este e-mail.`);
    const rows = await optoutsOf(shop.storeId);
    expect(rows.map((o) => ({ emailHash: o.emailHash, reason: o.reason }))).toEqual([{ emailHash: sha(email), reason: "unsubscribe" }]);
    expect(await leadIdsOf(shop.storeId)).toEqual([converted, someoneElse].sort());
    expect(await leadIdsOf(other.storeId)).toEqual([otherStore]);
    expect(await optoutsOf(other.storeId)).toEqual([]);

    // De novo (clique duplo): mesma página, sem erro e sem segunda linha.
    const again = await post(shop, token, { ip: newIp() });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Pronto: a ");
    expect(await optoutsOf(shop.storeId)).toHaveLength(1);
  });

  test("POST de um lembrete para variante (+sufixo) → optout do e-mail exato e da caixa; contatos apagados só pelo exato", async () => {
    const shop = await seedShop();
    const id = randomUUID().slice(0, 8);
    const variant = `cliente.${id}+promo@exemplo.com`;
    const plain = `cliente.${id}@exemplo.com`;
    const token = await seedReminder(shop, variant, plain);
    await seedLead(shop, variant, "open");
    const keep = await seedLead(shop, plain, "open");
    const r = await post(shop, token, { ip: newIp() });
    expect(r.status).toBe(200);
    const rows = await optoutsOf(shop.storeId);
    expect(rows.map((o) => [o.emailHash, o.reason]).sort()).toEqual(
      [
        [sha(variant), "unsubscribe"],
        [sha(plain), "unsubscribe"],
      ].sort(),
    );
    expect(await leadIdsOf(shop.storeId)).toEqual([keep]);
    // De novo: nada duplicado.
    await post(shop, token, { ip: newIp() });
    expect(await optoutsOf(shop.storeId)).toHaveLength(2);
  });

  test("POST com corpo List-Unsubscribe=One-Click → optout gravado", async () => {
    const shop = await seedShop();
    const email = newEmail();
    const token = await seedReminder(shop, email);
    // O provedor de e-mail posta do servidor dele: sem Origin nem Sec-Fetch-Site, sem sessão nem CSRF.
    const r = await post(shop, token, { oneClick: true });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(`Pronto: a ${shop.name} não vai mais mandar lembretes de compra para este e-mail.`);
    expect((await optoutsOf(shop.storeId)).map((o) => o.reason)).toEqual(["unsubscribe"]);
  });

  test('token de outra loja (host diferente) ou inventado → "Este link não vale mais" e nada gravado', async () => {
    const a = await seedShop("Loja A");
    const b = await seedShop("Loja B");
    const email = newEmail();
    const tokenB = await seedReminder(b, email);
    const leadA = await seedLead(a, email, "open");
    const leadB = await seedLead(b, email, "open");
    const expired = await seedReminder(a, email);
    await t.ownerDb.update(recoveryEmail).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(recoveryEmail.unsubHash, sha(expired)));
    const cases = [tokenB, randomToken(32), "curto", "com/barra-e-mais-caracteres", "a".repeat(129), expired];
    for (const token of cases) {
      for (const r of [await view(a, token, { ip: newIp() }), await post(a, token, { ip: newIp() }), await post(a, token, { oneClick: true })]) {
        expect([token, r.status]).toEqual([token, 410]);
        expectPageHeaders(r);
        const html = await r.text();
        expect(html).toContain(INVALID);
        expect(html).toContain(INVALID_NOTE);
        expect(html).not.toContain("Não quero mais receber");
      }
    }
    // Host que não é de loja nenhuma: a mesma página.
    const none = { resolve: async () => null as never };
    expect(await (await view(none, tokenB)).text()).toContain(INVALID);
    expect(await (await post(none, tokenB)).text()).toContain(INVALID);
    expect(await optoutsOf(a.storeId)).toEqual([]);
    expect(await optoutsOf(b.storeId)).toEqual([]);
    expect(await leadIdsOf(a.storeId)).toEqual([leadA]);
    expect(await leadIdsOf(b.storeId)).toEqual([leadB]);
  });

  test("31º POST do mesmo IP na hora → nada gravado e a mesma página neutra", async () => {
    expect(UNSUB_LIMIT).toEqual({ perIpPerHour: 30 });
    const shop = await seedShop();
    const email = newEmail();
    const token = await seedReminder(shop, email);
    const open = await seedLead(shop, email, "open");
    const ip = newIp();
    // Relógio fixo: as 31 requisições caem na mesma janela de uma hora.
    const now = new Date();
    // GET não conta.
    for (let i = 0; i < 3; i++) expect((await view(shop, token, { ip, now })).status).toBe(200);
    // Inválidos contam (todo POST conta, válido ou não).
    for (let i = 0; i < UNSUB_LIMIT.perIpPerHour; i++) expect((await post(shop, randomToken(32), { ip, now })).status).toBe(410);
    const r = await post(shop, token, { ip, now });
    expect(r.status).toBe(410);
    const html = await r.text();
    expect(html).toContain(INVALID);
    expect(html).toContain(INVALID_NOTE);
    expect(await optoutsOf(shop.storeId)).toEqual([]);
    expect(await leadIdsOf(shop.storeId)).toEqual([open]);
    // O limite é por IP: outro IP com o mesmo link descadastra.
    expect((await post(shop, token, { ip: newIp(), now })).status).toBe(200);
    expect(await optoutsOf(shop.storeId)).toHaveLength(1);
  });

  test("resposta sem o e-mail; log sem o token", async () => {
    const shop = await seedShop();
    const email = newEmail();
    const token = await seedReminder(shop, email);
    await seedLead(shop, email, "open");
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(JSON.stringify(a));
    const spies = [
      spyOn(log, "info").mockImplementation(capture),
      spyOn(log, "warn").mockImplementation(capture),
      spyOn(log, "error").mockImplementation(capture),
    ];
    try {
      const pages = [
        await view(shop, token),
        await post(shop, token, { ip: newIp() }),
        await post(shop, token, { oneClick: true }),
        await post(shop, randomToken(32), { ip: newIp() }),
        await view(shop, "curto"),
      ];
      for (const p of pages) {
        const html = await p.text();
        expect(html).not.toContain(email);
        expect(html).not.toContain(token);
        expect(html).not.toContain(sha(email));
        expect(html).not.toContain(sha(token));
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const all = lines.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(sha(token));
    expect(all).not.toContain(email);
    expect(all).not.toContain(sha(email));
    // O resultado vai no log, só com a loja.
    expect(lines.some((l) => l.includes(shop.storeId) && l.includes('"result":"descadastrado"'))).toBe(true);
    expect(lines.some((l) => l.includes(shop.storeId) && l.includes('"result":"link_invalido"'))).toBe(true);
  });

  test("rota do Next: GET e POST só fazem o parse HTTP (token do caminho)", async () => {
    // Sem loja para o host (o teste não configura MODE/host): a rota responde a página neutra, sem erro.
    const token = randomToken(32);
    const params = { params: Promise.resolve({ token }) };
    const g = await GET(new Request(`https://nenhuma.invalid/sair/${token}`, { headers: { host: "nenhuma.invalid" } }), params);
    const p = await POST(
      new Request(`https://nenhuma.invalid/sair/${token}`, {
        method: "POST",
        headers: { host: "nenhuma.invalid", "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      params,
    );
    for (const r of [g, p]) {
      expectPageHeaders(r);
      expect(await r.text()).not.toContain(token);
    }
  });
});
