import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { ActionError, runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { createProduct } from "@/lib/catalog/products";
import { withStore } from "@/lib/db/client";
import { auditLog, downloadLink, emailLog, integration, job, orders, store } from "@/lib/db/schema";
import { handleDownload } from "@/lib/delivery/download";
import { resendOrder } from "@/lib/delivery/jobs";
import { saveSmtp, sendMail, setMailTransportForTests, testSmtp, type SentMail } from "@/lib/delivery/mailer";
import { runDueJobs, type Job } from "@/lib/jobs";
import { getHandlers } from "@/lib/jobs/handlers";
import { createOrder } from "@/lib/orders/create";
import { transitionOrder } from "@/lib/orders/state";
import { releaseOrder } from "@/lib/payments/manual";
import { refundOrder } from "@/lib/payments/refund";
import type { ResolvedStore } from "@/lib/stores";
import { createTestDb, seedStore, type TestDb } from "./db";
import { pageTexts } from "./pdf-text";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setMailTransportForTests();
  await t.drop();
});

// ---- SMTP falso ------------------------------------------------------------------------------------------------
let outbox: SentMail[] = [];
let sendError: Error | null = null;
let verifyError: Error | null = null;
const fakeTransport = () =>
  setMailTransportForTests(() => ({
    async verify() {
      if (verifyError) throw verifyError;
      return true;
    },
    async sendMail(m) {
      if (sendError) throw sendError;
      outbox.push(m);
      return {};
    },
    close() {},
  }));
fakeTransport();
afterEach(() => {
  outbox = [];
  sendError = null;
  verifyError = null;
  fakeTransport();
});

// ---- Loja, produtos e pedidos ----------------------------------------------------------------------------------
const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const support: Actor = { kind: "user", userId: "u2", role: "support" };
const traffic: Actor = { kind: "user", userId: "u3", role: "traffic" };
const panel = (storeId: string, actor: Actor = owner) => ({ storeId, actor, origin: "panel" as const });
const systemCtx = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "system" }, origin: "system", tx });
const SMTP = { host: "smtp.exemplo.com", port: 587, secure: false, user: "loja@exemplo.com", password: "senha-smtp-super-secreta", from: "contato@loja.com" };

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
  return doc.save();
}

type Shop = { storeId: string; slug: string; offerId: string; mainName: string; bumpName: string; resolve: () => Promise<ResolvedStore> };

async function seedShop(opts: { notifyEmail?: string | null; smtp?: boolean; mainName?: string; fileName?: string } = {}): Promise<Shop> {
  const { storeId } = await seedStore("Maná Kids");
  const [s] = await t.ownerDb
    .update(store)
    .set({ notifyEmail: opts.notifyEmail === undefined ? "dono@loja.com" : opts.notifyEmail })
    .where(eq(store.id, storeId))
    .returning({ slug: store.slug, name: store.name });
  if (opts.smtp !== false) await runAction(saveSmtp, panel(storeId), SMTP);
  const mainName = opts.mainName ?? "Maná bíblico · versão básica";
  const bumpName = "Maná bíblico · versão completa";
  const main = await runAction(createProduct, panel(storeId), { name: mainName, fileName: opts.fileName ?? "mana-basica.pdf", file: await pdf(3) });
  const bump = await runAction(createProduct, panel(storeId), { name: bumpName, fileName: "mana-completa.pdf", file: await pdf(2) });
  const offer = await runAction(createOffer, panel(storeId), {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Maná bíblico para crianças",
    productId: main.id,
    priceCents: 990,
    methods: ["pix"],
    pixMode: "manual",
    bumpProductId: bump.id,
    bumpPriceCents: 1710,
    bumpLabel: "Quero a completa",
  });
  return {
    storeId,
    slug: s!.slug,
    offerId: offer.id,
    mainName,
    bumpName,
    resolve: async () => ({ id: storeId, slug: s!.slug, name: s!.name }),
  };
}

async function newOrder(shop: Shop, opts: { bump?: boolean; name?: string; email?: string } = {}) {
  return withStore(shop.storeId, (tx) =>
    createOrder(systemCtx(shop.storeId, tx), {
      offerId: shop.offerId,
      withBump: opts.bump ?? true,
      method: "pix_manual",
      customer: { name: opts.name ?? "Maria Souza", email: opts.email ?? "maria@exemplo.com", phone: "11987654321" },
      touch: { first: null, last: null },
      clientIp: "127.0.0.1",
      userAgent: "bun-test",
    }),
  );
}

async function paidOrder(shop: Shop, opts: { bump?: boolean; name?: string; email?: string } = {}) {
  const o = await newOrder(shop, opts);
  await runAction(releaseOrder, panel(shop.storeId), { orderId: o.id });
  return o;
}

const jobsOf = (orderId: string, type: string) =>
  t.ownerDb
    .select()
    .from(job)
    .where(and(eq(job.type, type), sql`${job.payload}->>'orderId' = ${orderId}`))
    .orderBy(job.runAt);

/** Roda o handler de cada job aberto do tipo para o pedido (como o worker faria, sem passar pela fila). */
async function runJobs(orderId: string, type: "deliver_order" | "notify_seller" | "revoke_downloads" | "restore_downloads"): Promise<Job[]> {
  const handler = getHandlers()[type]!;
  const rows = (await jobsOf(orderId, type)).filter((j) => j.status === "queued");
  for (const j of rows) {
    await handler(j, new AbortController().signal);
    await t.ownerDb.update(job).set({ status: "done" }).where(eq(job.id, j.id));
  }
  return rows;
}

const tokensIn = (text: string) => [...text.matchAll(/\/d\/([A-Za-z0-9_-]{43})\b/g)].map((m) => m[1]!);
const lastMailTo = (to: string) => [...outbox].reverse().find((m) => m.to === to);

const download = (shop: Pick<Shop, "resolve">, token: string, init: { ip?: string } = {}) =>
  handleDownload(
    new Request(`http://localhost:3000/d/${token}`, { headers: init.ip ? { "x-forwarded-for": init.ip } : {} }),
    token,
    { resolveStore: shop.resolve, trustProxy: init.ip ? 1 : 0 },
  );

async function deliveredOrder(shop: Shop, opts: { bump?: boolean; name?: string; email?: string } = {}) {
  const o = await paidOrder(shop, opts);
  await runJobs(o.id, "deliver_order");
  const mail = lastMailTo(opts.email ?? "maria@exemplo.com")!;
  return { order: o, mail, tokens: tokensIn(mail.text) };
}

// ---------------------------------------------------------------------------------------------------------------

describe("deliver_order", () => {
  test("pedido pago com bump: um e-mail com 2 links (HTML e texto), registro 'sent' e só o hash do token no banco", async () => {
    const shop = await seedShop();
    const { order, mail, tokens } = await deliveredOrder(shop);
    expect(mail.subject).toBe(`Seu acesso: ${shop.mainName}`);
    expect(mail.from).toEqual({ name: "Maná Kids", address: "contato@loja.com" });
    expect(tokens).toHaveLength(2);
    expect([...new Set(tokensIn(mail.html))]).toEqual(tokens);
    expect(mail.html).toContain("Baixar PDF");
    expect(mail.html).toContain(shop.bumpName);
    expect(mail.text).toContain(shop.mainName);
    expect(mail.text).toContain(shop.bumpName);
    expect(mail.text).toContain("R$ 27,00");
    expect(mail.html).toContain("http://localhost:3000/d/");

    const links = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(l.maxDownloads).toBe(5);
      expect(l.downloads).toBe(0);
      expect(l.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29.9 * 86_400_000);
      expect(tokens).not.toContain(l.tokenHash);
      expect(l.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const logs = await t.ownerDb.select().from(emailLog).where(eq(emailLog.orderId, order.id));
    expect(logs.map((l) => [l.kind, l.status])).toEqual([["delivery", "sent"]]);
    expect(logs[0]!.toHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(logs)).not.toContain("maria@exemplo.com");
  });

  test("sem bump: um link só", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop, { bump: false });
    expect(tokens).toHaveLength(1);
  });

  test("at-least-once: o mesmo job rodando duas vezes manda um e-mail só", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "deliver_order");
    const handler = getHandlers().deliver_order!;
    await handler(j!, new AbortController().signal);
    await handler(j!, new AbortController().signal);
    expect(outbox.filter((m) => m.to === "maria@exemplo.com")).toHaveLength(1);
  });

  test("decide pelo status ATUAL: pedido já reembolsado quando o job roda -> não envia nada", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    await runAction(refundOrder, panel(shop.storeId), { orderId: o.id });
    await runJobs(o.id, "deliver_order");
    expect(outbox).toHaveLength(0);
    expect(await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, o.id))).toHaveLength(0);
  });

  test("valores dinâmicos escapados no HTML do e-mail", async () => {
    const shop = await seedShop({ mainName: `<script>alert(1)</script> & "x"` });
    const { mail } = await deliveredOrder(shop, { name: "<b>Ana</b>" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Ana</b>");
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;");
    expect(mail.subject).toBe(`Seu acesso: <script>alert(1)</script> & "x"`);
  });

  test("SMTP fora do ar (Review Focus 5b): pedido continua pago, job reagendado, email_log 'failed'; depois entrega", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    sendError = new Error("connect ECONNREFUSED 10.0.0.1:587");
    const now = new Date(Date.now() + 1000);
    const handlers = { deliver_order: getHandlers().deliver_order! };
    await runDueJobs(handlers, 50, now);
    const [j] = await jobsOf(o.id, "deliver_order");
    expect([j!.status, j!.attempts]).toEqual(["queued", 1]);
    expect(j!.lastError).toContain("ECONNREFUSED");
    expect(j!.runAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 60_000);
    const [row] = await t.ownerDb.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.status).toBe("paid");
    const failed = await t.ownerDb.select().from(emailLog).where(eq(emailLog.orderId, o.id));
    expect(failed.map((l) => [l.kind, l.status])).toEqual([["delivery", "failed"]]);
    expect(failed[0]!.error).toContain("ECONNREFUSED");

    sendError = null;
    await runDueJobs(handlers, 50, new Date(now.getTime() + 61_000));
    expect((await jobsOf(o.id, "deliver_order"))[0]!.status).toBe("done");
    const mail = lastMailTo("maria@exemplo.com")!;
    expect(tokensIn(mail.text)).toHaveLength(2);
    expect((await download(shop, tokensIn(mail.text)[0]!)).status).toBe(200);
    const logs = await t.ownerDb.select().from(emailLog).where(eq(emailLog.orderId, o.id));
    expect(logs.map((l) => l.status).sort()).toEqual(["failed", "sent"]);
    // A retentativa reaproveitou as linhas (não duplicou links).
    expect(await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, o.id))).toHaveLength(2);
  });

  test("loja sem SMTP: falha (re-tenta) com 'E-mail não configurado'", async () => {
    const shop = await seedShop({ smtp: false });
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "deliver_order");
    await expect(getHandlers().deliver_order!(j!, new AbortController().signal)).rejects.toThrow("E-mail não configurado");
  });

  test("tempo-limite: sinal abortado não manda e-mail", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "deliver_order");
    const ctrl = new AbortController();
    ctrl.abort(new Error("tempo-limite"));
    await expect(getHandlers().deliver_order!(j!, ctrl.signal)).rejects.toThrow();
    expect(outbox).toHaveLength(0);
  });
});

describe("GET /d/[token]", () => {
  test("serve o PDF carimbado como anexo, com cabeçalhos seguros; 6º download -> 410", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop, { name: "João Ñúñez 😀", email: "joao@exemplo.com" });
    for (let i = 1; i <= 5; i++) {
      const res = await download(shop, tokens[0]!);
      expect(res.status).toBe(200);
      if (i === 1) {
        expect(res.headers.get("content-type")).toBe("application/pdf");
        expect(res.headers.get("content-disposition")).toStartWith("attachment;");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        const body = new Uint8Array(await res.arrayBuffer());
        const texts = await pageTexts(body);
        expect(texts).toHaveLength(3);
        for (const p of texts) expect(p).toContain("Licenciado para João Ñúñez — joao@exemplo.com");
      }
    }
    const sixth = await download(shop, tokens[0]!);
    expect(sixth.status).toBe(410);
    expect(sixth.headers.get("content-type")).toContain("text/html");
    const html = await sixth.text();
    expect(html).toContain("Este link de download expirou");
    expect(html).toContain("peça um novo ao vendedor");
    const [l] = await t.ownerDb
      .select()
      .from(downloadLink)
      .where(and(eq(downloadLink.orderId, order.id), eq(downloadLink.downloads, 5)));
    expect(l).toBeDefined();
  });

  test("downloads simultâneos não passam do limite (incremento atômico)", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop);
    const res = await Promise.all(Array.from({ length: 8 }, () => download(shop, tokens[1]!)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(5);
    expect(res.filter((r) => r.status === 410)).toHaveLength(3);
  });

  test("reembolso: 410 na hora (status do pedido) e revoke_downloads grava revoked_at", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    await runAction(refundOrder, panel(shop.storeId), { orderId: order.id });
    expect((await download(shop, tokens[0]!)).status).toBe(410);
    await runJobs(order.id, "revoke_downloads");
    const links = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(links.every((l) => l.revokedAt instanceof Date)).toBe(true);
    expect((await download(shop, tokens[1]!)).status).toBe(410);
  });

  test("contestação revoga; contestação revertida (disputed -> paid) restaura sem novo e-mail", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "disputed", "chargeback"));
    await runJobs(order.id, "revoke_downloads");
    expect((await download(shop, tokens[0]!)).status).toBe(410);
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "paid", "chargeback revertido"));
    outbox = [];
    await runJobs(order.id, "restore_downloads");
    expect(outbox).toHaveLength(0);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
  });

  test("fora de ordem: restore com o pedido ainda contestado não reativa; revoke com o pedido pago não revoga", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    const handlers = getHandlers();
    const fakeJob = (type: string) => ({ id: crypto.randomUUID(), storeId: shop.storeId, type, payload: { orderId: order.id } }) as Job;
    await handlers.revoke_downloads!(fakeJob("revoke_downloads"), new AbortController().signal);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "disputed", "chargeback"));
    await runJobs(order.id, "revoke_downloads");
    await handlers.restore_downloads!(fakeJob("restore_downloads"), new AbortController().signal);
    const links = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(links.every((l) => l.revokedAt instanceof Date)).toBe(true);
  });

  test("token de outra loja (host de outra loja) -> 410; token inválido -> 410", async () => {
    const a = await seedShop();
    const b = await seedShop();
    const { tokens } = await deliveredOrder(a);
    expect((await download(b, tokens[0]!)).status).toBe(410);
    expect((await download(a, "x".repeat(43))).status).toBe(410);
    expect((await download(a, "../../etc/passwd")).status).toBe(410);
    expect((await download(a, tokens[0]!)).status).toBe(200);
  });

  test("host que não é de loja nenhuma -> 410", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop);
    const res = await handleDownload(new Request(`http://x/d/${tokens[0]}`), tokens[0]!, { resolveStore: async () => null });
    expect(res.status).toBe(410);
  });

  test("link vencido (30 dias) -> 410", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    await t.ownerDb.update(downloadLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(downloadLink.orderId, order.id));
    expect((await download(shop, tokens[0]!)).status).toBe(410);
  });

  test("nome do arquivo seguro no Content-Disposition (fallback ASCII + filename*)", async () => {
    const shop = await seedShop({ fileName: 'Maná "bíblico"\r\nX-Evil: 1/..\\a' });
    const { tokens } = await deliveredOrder(shop);
    const cd = (await download(shop, tokens[0]!)).headers.get("content-disposition")!;
    expect(cd).not.toMatch(/[\r\n]/);
    const ascii = /filename="([^"]*)"/.exec(cd)![1]!;
    expect(ascii).toMatch(/^[\x20-\x7e]+\.pdf$/);
    expect(ascii).not.toMatch(/[\\/"]/);
    const star = /filename\*=UTF-8''([^;\s]+)/.exec(cd)![1]!;
    const decoded = decodeURIComponent(star);
    expect(decoded).toStartWith("Maná");
    expect(decoded).toEndWith(".pdf");
    expect(decoded).not.toMatch(/[\\/"\r\n\u0000-\u001f]/);
  });

  test("limite por IP de tentativas inválidas (60/h): a 61ª recebe 429, mesmo com token válido", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop);
    const ip = "203.0.113.77";
    for (let i = 0; i < 60; i++) expect((await download(shop, `bad${i}`.padEnd(43, "x"), { ip })).status).toBe(410);
    expect((await download(shop, "y".repeat(43), { ip })).status).toBe(429);
    expect((await download(shop, tokens[0]!, { ip })).status).toBe(429);
    expect((await download(shop, tokens[0]!, { ip: "198.51.100.9" })).status).toBe(200);
  });
});

describe("orders.resend", () => {
  test("support pode; traffic não; reenvio manda e-mail novo com o link girado (contador mantido)", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    await expect(runAction(resendOrder, panel(shop.storeId, traffic), { orderId: order.id })).rejects.toMatchObject({ code: "forbidden" });
    const r = await runAction(resendOrder, panel(shop.storeId, support), { orderId: order.id });
    expect(r.queued).toBe(true);
    outbox = [];
    await runJobs(order.id, "deliver_order");
    const again = tokensIn(lastMailTo("maria@exemplo.com")!.text);
    expect(again).toHaveLength(2);
    expect((await download(shop, tokens[0]!)).status).toBe(410); // o link antigo deixou de valer
    for (let i = 0; i < 4; i++) expect((await download(shop, again[0]!)).status).toBe(200);
    expect((await download(shop, again[0]!)).status).toBe(410); // 1 + 4 = 5
  });

  test("renew: revoga os links e emite novos (5 downloads de novo); restore não ressuscita os renovados", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    for (let i = 0; i < 5; i++) await download(shop, tokens[0]!);
    await runAction(resendOrder, panel(shop.storeId, support), { orderId: order.id, renew: true });
    await runJobs(order.id, "deliver_order");
    const fresh = tokensIn(lastMailTo("maria@exemplo.com")!.text);
    for (let i = 0; i < 5; i++) expect((await download(shop, fresh[0]!)).status).toBe(200);
    const links = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(links).toHaveLength(4);
    expect(links.filter((l) => l.revokedAt !== null)).toHaveLength(2);
    // disputed -> paid: restore só desfaz revogação por status, não a renovação.
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "disputed", "cb"));
    await runJobs(order.id, "revoke_downloads");
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "paid", "cb revertido"));
    await runJobs(order.id, "restore_downloads");
    const after = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(after.filter((l) => l.revokedAt !== null)).toHaveLength(2);
    expect((await download(shop, tokens[1]!)).status).toBe(410);
  });

  test("pedido não pago -> conflict; job duplicado não é enfileirado", async () => {
    const shop = await seedShop();
    const pending = await newOrder(shop);
    await expect(runAction(resendOrder, panel(shop.storeId, support), { orderId: pending.id })).rejects.toMatchObject({ code: "conflict" });
    const o = await paidOrder(shop);
    const r = await runAction(resendOrder, panel(shop.storeId, support), { orderId: o.id });
    expect(r.queued).toBe(false); // a entrega inicial ainda está na fila
    expect((await jobsOf(o.id, "deliver_order")).length).toBe(1);
  });
});

describe("notify_seller", () => {
  const sellerJob = (storeId: string, payload: unknown) => ({ id: crypto.randomUUID(), storeId, type: "notify_seller", payload }) as Job;

  test("venda: e-mail para notify_email com produto, valor e método; mesmo job 2x = 1 e-mail", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "notify_seller");
    const handler = getHandlers().notify_seller!;
    await handler(j!, new AbortController().signal);
    await handler(j!, new AbortController().signal);
    const mails = outbox.filter((m) => m.to === "dono@loja.com");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe(`Nova venda: ${shop.mainName} — R$ 27,00`);
    expect(mails[0]!.text).toContain(shop.bumpName);
    expect(mails[0]!.text).toContain("Pix");
    expect(mails[0]!.text).toContain("R$ 27,00");
  });

  test("chave do Asaas recusada (sem orderId): manda corrigir em Conexões e REATIVAR a fila de webhooks do Asaas", async () => {
    const shop = await seedShop();
    await getHandlers().notify_seller!(sellerJob(shop.storeId, { reason: "chave_asaas_invalida", httpStatus: 401 }), new AbortController().signal);
    const m = lastMailTo("dono@loja.com")!;
    expect(m.subject).toContain("Asaas");
    expect(m.text).toContain("Conexões");
    expect(m.text).toMatch(/reative a fila de webhooks/i);
  });

  test("outros motivos sem pedido e motivo desconhecido (aviso genérico, sem ecoar texto arbitrário)", async () => {
    const shop = await seedShop();
    const h = getHandlers().notify_seller!;
    for (const reason of ["evento_conta_asaas_anterior", "asaas_conta_antiga", "estorno_cancelado", "disjuntor_cartao"]) {
      await h(sellerJob(shop.storeId, { reason }), new AbortController().signal);
    }
    expect(outbox.filter((m) => m.to === "dono@loja.com")).toHaveLength(4);
    expect(new Set(outbox.map((m) => m.subject)).size).toBe(3); // asaas_conta_antiga é sinônimo de evento_conta_asaas_anterior
    await h(sellerJob(shop.storeId, { reason: "<img src=x>coisa nova" }), new AbortController().signal);
    const generic = outbox.at(-1)!;
    expect(generic.subject).toBe("Aviso da sua loja");
    expect(generic.html).not.toContain("<img src=x>");
  });

  test("loja sem notify_email: job concluído sem enviar (não é falha)", async () => {
    const shop = await seedShop({ notifyEmail: null });
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "notify_seller");
    await getHandlers().notify_seller!(j!, new AbortController().signal);
    expect(outbox.filter((m) => m.subject.startsWith("Nova venda"))).toHaveLength(0);
  });
});

describe("conexão SMTP", () => {
  test("saveSmtp testa com verify() antes de salvar; senha selada; auditoria sem a senha", async () => {
    const { storeId } = await seedStore();
    const out = await runAction(saveSmtp, panel(storeId), SMTP);
    expect(out).toEqual({ host: SMTP.host, port: 587, secure: false, user: SMTP.user, from: SMTP.from, hasPassword: true });
    const [row] = await t.ownerDb.select().from(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, "smtp")));
    expect(row!.secret).toStartWith("v1.");
    expect(JSON.stringify(row)).not.toContain(SMTP.password);
    const audits = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "connections.saveSmtp")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(SMTP.password);
  });

  test("verify falhando: provider_error e nada salvo", async () => {
    const { storeId } = await seedStore();
    verifyError = Object.assign(new Error("Invalid login: 535 Authentication failed"), { code: "EAUTH" });
    const err = await runAction(saveSmtp, panel(storeId), SMTP).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).code).toBe("provider_error");
    expect((err as ActionError).message).toContain("usuário ou senha");
    const rows = await t.ownerDb.select().from(integration).where(eq(integration.storeId, storeId));
    expect(rows).toHaveLength(0);
  });

  test("sensível: MCP/IA precisam de aprovação; support não pode", async () => {
    const { storeId } = await seedStore();
    await expect(runAction(saveSmtp, { storeId, actor: owner, origin: "mcp" }, SMTP)).rejects.toMatchObject({ code: "approval_required" });
    await expect(runAction(saveSmtp, panel(storeId, support), SMTP)).rejects.toMatchObject({ code: "forbidden" });
  });

  test("salvar de novo sem senha mantém a senha guardada", async () => {
    const { storeId } = await seedStore();
    await runAction(saveSmtp, panel(storeId), SMTP);
    const out = await runAction(saveSmtp, panel(storeId), { host: SMTP.host, user: SMTP.user, from: SMTP.from, port: 465, secure: true });
    expect(out.hasPassword).toBe(true);
    await runAction(testSmtp, panel(storeId), { to: "eu@exemplo.com" });
    expect(lastMailTo("eu@exemplo.com")!.subject).toContain("teste");
  });

  test("testSmtp manda um e-mail de teste e registra; sendMail sem conexão -> provider_error 'E-mail não configurado'", async () => {
    const { storeId } = await seedStore();
    await expect(sendMail(storeId, { to: "a@b.co", subject: "x", html: "x", text: "x" })).rejects.toMatchObject({
      code: "provider_error",
      message: "E-mail não configurado",
    });
    await runAction(saveSmtp, panel(storeId), SMTP);
    await runAction(testSmtp, panel(storeId), { to: "eu@exemplo.com" });
    expect(lastMailTo("eu@exemplo.com")).toBeDefined();
    const logs = await withStore(storeId, (tx) => tx.select().from(emailLog));
    expect(logs.map((l) => [l.kind, l.status])).toEqual([["test", "sent"]]);
  });
});
