import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { ActionError, runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer, setOfferProducts } from "@/lib/catalog/offers";
import { sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { auditLog, downloadLink, downloadToken, emailLog, integration, job, orders, product, store } from "@/lib/db/schema";
import { handleDownloadHead, handleDownloadPage, handleDownloadPost } from "@/lib/delivery/download";
import { createSweepWatermarksHandler, resendOrder } from "@/lib/delivery/jobs";
import { RESEND_ERRORS, saveResend, setEmailProvider, setResendFetchForTests } from "@/lib/delivery/resend";
import {
  SMTP_GENERIC_ERROR,
  saveSmtp,
  sendMail,
  setMailTransportForTests,
  setSmtpNetworkForTests,
  testSmtp,
  type SentMail,
  type SmtpSettings,
} from "@/lib/delivery/mailer";
import { fileVersion, watermarkKey } from "@/lib/delivery/watermark";
import { storage } from "@/lib/storage";
import { runDueJobs, type Job } from "@/lib/jobs";
import { getHandlers } from "@/lib/jobs/handlers";
import { createOrder } from "@/lib/orders/create";
import { transitionOrder } from "@/lib/orders/state";
import { releaseOrder } from "@/lib/payments/manual";
import { refundOrder } from "@/lib/payments/refund";
import type { ResolvedStore } from "@/lib/stores";
import { HEAVY_TEST_MS, createTestDb, seedPdfProduct, seedStore, type TestDb } from "./db";
import { pageTexts } from "./pdf-text";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setResendFetchForTests();
  setMailTransportForTests();
  setSmtpNetworkForTests();
  await t.drop();
});

// ---- SMTP falso ------------------------------------------------------------------------------------------------
let outbox: SentMail[] = [];
let sendError: Error | null = null;
let verifyError: Error | null = null;
/** O servidor aceitou o e-mail, mas a resposta se perdeu (o envio "falha" para nós). */
let lostReply = false;
let transports: SmtpSettings[] = [];
const fakeTransport = () =>
  setMailTransportForTests((cfg) => {
    transports.push(cfg);
    return {
      async verify() {
        if (verifyError) throw verifyError;
        return true;
      },
      async sendMail(m) {
        if (sendError) throw sendError;
        outbox.push(m);
        if (lostReply) throw Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" });
        return {};
      },
      close() {},
    };
  });
fakeTransport();
afterEach(() => {
  setResendFetchForTests();
  outbox = [];
  sendError = null;
  verifyError = null;
  lostReply = false;
  transports = [];
  fakeTransport();
  setSmtpNetworkForTests();
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
  const main = await seedPdfProduct(storeId, mainName, opts.fileName ?? "mana-basica.pdf", await pdf(3));
  const bump = await seedPdfProduct(storeId, bumpName, "mana-completa.pdf", await pdf(2));
  const offer = await runAction(createOffer, panel(storeId), {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Maná bíblico para crianças",
    productIds: [main.id],
    priceCents: 990,
    methods: ["pix"],
    pixMode: "manual",
    bump: { productIds: [bump.id], priceCents: 1710, label: "Quero a completa" },
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

const reqFor = (token: string, method: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000/d/${token}`, { method, headers: { host: "localhost:3000", ...headers } });
/** O clique em "Baixar PDF": POST da mesma origem (é o que conta o download). */
const download = (shop: Pick<Shop, "resolve">, token: string, init: { ip?: string; headers?: Record<string, string> } = {}) =>
  handleDownloadPost(
    reqFor(token, "POST", { origin: "http://localhost:3000", ...(init.ip ? { "x-forwarded-for": init.ip } : {}), ...init.headers }),
    token,
    { resolveStore: shop.resolve, trustProxy: init.ip ? 1 : 0 },
  );
/** Abrir o link (GET): página com o botão, sem contar. */
const view = (shop: Pick<Shop, "resolve">, token: string, init: { ip?: string } = {}) =>
  handleDownloadPage(reqFor(token, "GET", init.ip ? { "x-forwarded-for": init.ip } : {}), token, { resolveStore: shop.resolve, trustProxy: init.ip ? 1 : 0 });
const countsOf = async (orderId: string) =>
  (await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, orderId))).map((l) => l.downloads).sort();

async function deliveredOrder(shop: Shop, opts: { bump?: boolean; name?: string; email?: string } = {}) {
  const o = await paidOrder(shop, opts);
  await runJobs(o.id, "deliver_order");
  const mail = lastMailTo(opts.email ?? "maria@exemplo.com")!;
  return { order: o, mail, tokens: tokensIn(mail.text) };
}

/** Loja com `n` PDFs ("Almanaque PDF 1".."n") e uma oferta "Almanaque Completo" de R$ 27,00 com todos como principais. */
async function seedKitShop(n: number, priceCents = 2700, given?: string[]): Promise<Shop & { productIds: string[]; names: string[] }> {
  const { storeId } = await seedStore("Maná Kids");
  const [s] = await t.ownerDb.update(store).set({ notifyEmail: "dono@loja.com" }).where(eq(store.id, storeId)).returning({ slug: store.slug, name: store.name });
  await runAction(saveSmtp, panel(storeId), SMTP);
  const names = given ?? Array.from({ length: n }, (_, i) => `Almanaque PDF ${i + 1}`);
  const productIds: string[] = [];
  for (const [i, name] of names.entries()) productIds.push((await seedPdfProduct(storeId, name, `pdf-${i + 1}.pdf`, await pdf(1))).id);
  const offer = await runAction(createOffer, panel(storeId), {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Almanaque Completo",
    productIds,
    priceCents,
    methods: ["pix"],
    pixMode: "manual",
  });
  return { storeId, slug: s!.slug, offerId: offer.id, mainName: names[0]!, bumpName: "", productIds, names, resolve: async () => ({ id: storeId, slug: s!.slug, name: s!.name }) };
}

/** Posições dos nomes no texto, na ordem pedida (-1 se faltar). */
const positionsIn = (text: string, names: string[]) => names.map((n) => text.indexOf(n));
const increasing = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!));

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
    // Sem preço por item (só o total), principal antes do bump.
    for (const part of [mail.html, mail.text]) {
      expect(part).not.toContain("R$ 9,90");
      expect(part).not.toContain("R$ 17,10");
      expect(part).toContain("R$ 27,00");
      expect(part.indexOf(shop.mainName)).toBeLessThan(part.indexOf(shop.bumpName));
    }

    const links = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(l.maxDownloads).toBe(5);
      expect(l.downloads).toBe(0);
      expect(l.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29.9 * 86_400_000);
    }
    const toks = await t.ownerDb.select().from(downloadToken).where(eq(downloadToken.storeId, shop.storeId));
    expect(toks).toHaveLength(2);
    for (const tk of toks) {
      expect(tokens).not.toContain(tk.tokenHash);
      expect(tk.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(links.map((l) => l.id)).toContain(tk.linkId);
    }
    const logs = await t.ownerDb.select().from(emailLog).where(eq(emailLog.orderId, order.id));
    expect(logs.map((l) => [l.kind, l.status])).toEqual([["delivery", "sent"]]);
    expect(logs[0]!.toHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(logs)).not.toContain("maria@exemplo.com");
  }, HEAVY_TEST_MS);

  test("sem bump: um link só", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop, { bump: false });
    expect(tokens).toHaveLength(1);
  }, HEAVY_TEST_MS);

  test("at-least-once: o mesmo job rodando duas vezes manda um e-mail só", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "deliver_order");
    const handler = getHandlers().deliver_order!;
    await handler(j!, new AbortController().signal);
    await handler(j!, new AbortController().signal);
    expect(outbox.filter((m) => m.to === "maria@exemplo.com")).toHaveLength(1);
  }, HEAVY_TEST_MS);

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
  }, HEAVY_TEST_MS);

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
  }, HEAVY_TEST_MS);

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
  }, HEAVY_TEST_MS);

  test("downloads simultâneos não passam do limite (incremento atômico)", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop);
    const res = await Promise.all(Array.from({ length: 8 }, () => download(shop, tokens[1]!)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(5);
    expect(res.filter((r) => r.status === 410)).toHaveLength(3);
  }, HEAVY_TEST_MS);

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
  }, HEAVY_TEST_MS);

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
    // Já houve e-mail de entrega: o restore não enfileira outra entrega.
    expect((await jobsOf(order.id, "deliver_order")).filter((j) => j.status === "queued")).toHaveLength(0);
  }, HEAVY_TEST_MS);

  test("contestação revertida de pedido que nunca recebeu o e-mail de acesso: o restore enfileira a entrega (uma vez)", async () => {
    const shop = await seedShop();
    const order = await paidOrder(shop);
    // A entrega não chegou a sair (ex.: SMTP fora do ar) e o pedido foi contestado: o job de entrega terminou sem enviar.
    await t.ownerDb.update(job).set({ status: "failed" }).where(and(eq(job.type, "deliver_order"), sql`${job.payload}->>'orderId' = ${order.id}`));
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "disputed", "chargeback"));
    await runJobs(order.id, "revoke_downloads");
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "paid", "chargeback revertido"));
    const [restore] = await jobsOf(order.id, "restore_downloads");
    await getHandlers().restore_downloads!(restore!, new AbortController().signal);
    await getHandlers().restore_downloads!(restore!, new AbortController().signal); // at-least-once
    const queued = (await jobsOf(order.id, "deliver_order")).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
    outbox = [];
    await runJobs(order.id, "deliver_order");
    expect(outbox.filter((m) => m.subject.includes("acesso") || tokensIn(m.text).length > 0)).toHaveLength(1);
  }, HEAVY_TEST_MS);

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
  }, HEAVY_TEST_MS);

  test("token de outra loja (host de outra loja) -> 410; token inválido -> 410", async () => {
    const a = await seedShop();
    const b = await seedShop();
    const { tokens } = await deliveredOrder(a);
    expect((await download(b, tokens[0]!)).status).toBe(410);
    expect((await download(a, "x".repeat(43))).status).toBe(410);
    expect((await download(a, "../../etc/passwd")).status).toBe(410);
    expect((await download(a, tokens[0]!)).status).toBe(200);
  }, HEAVY_TEST_MS);

  test("host que não é de loja nenhuma -> 410", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop);
    const none = { resolveStore: async () => null };
    expect((await handleDownloadPost(new Request(`http://x/d/${tokens[0]}`, { method: "POST" }), tokens[0]!, none)).status).toBe(410);
    expect((await handleDownloadPage(new Request(`http://x/d/${tokens[0]}`), tokens[0]!, none)).status).toBe(410);
  }, HEAVY_TEST_MS);

  test("link vencido (30 dias) -> 410", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    await t.ownerDb.update(downloadLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(downloadLink.orderId, order.id));
    expect((await download(shop, tokens[0]!)).status).toBe(410);
  }, HEAVY_TEST_MS);

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
  }, HEAVY_TEST_MS);

  test("limite por IP de tentativas inválidas (60/h): a 61ª recebe 429, mesmo com token válido", async () => {
    const shop = await seedShop();
    const { tokens } = await deliveredOrder(shop);
    const ip = "203.0.113.77";
    for (let i = 0; i < 60; i++) expect((await download(shop, `bad${i}`.padEnd(43, "x"), { ip })).status).toBe(410);
    expect((await download(shop, "y".repeat(43), { ip })).status).toBe(429);
    expect((await download(shop, tokens[0]!, { ip })).status).toBe(429);
    expect((await download(shop, tokens[0]!, { ip: "198.51.100.9" })).status).toBe(200);
  }, HEAVY_TEST_MS);
});

describe("orders.resend", () => {
  test("support pode; traffic não; reenvio ACRESCENTA um token ao mesmo link: o antigo continua valendo, contador único", async () => {
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
    expect(await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id))).toHaveLength(2); // mesmos links
    expect((await download(shop, tokens[0]!)).status).toBe(200); // o link do 1º e-mail continua valendo
    for (let i = 0; i < 3; i++) expect((await download(shop, again[0]!)).status).toBe(200);
    expect((await download(shop, again[0]!)).status).toBe(410); // 1 + 1 + 3 = 5 no mesmo link
    expect((await download(shop, tokens[0]!)).status).toBe(410);
  }, HEAVY_TEST_MS);

  test("SMTP fora do ar no reenvio: nada muda, o link antigo segue valendo e nenhum token novo é gravado", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    const before = await t.ownerDb.select().from(downloadToken).where(eq(downloadToken.storeId, shop.storeId));
    await runAction(resendOrder, panel(shop.storeId, support), { orderId: order.id });
    sendError = new Error("connect ECONNREFUSED");
    await expect(runJobs(order.id, "deliver_order")).rejects.toThrow("ECONNREFUSED");
    expect(await t.ownerDb.select().from(downloadToken).where(eq(downloadToken.storeId, shop.storeId))).toHaveLength(before.length);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    expect((await download(shop, tokens[1]!)).status).toBe(200);
  }, HEAVY_TEST_MS);

  test("resposta do SMTP perdida e retentativa: os links anteriores não morrem; o e-mail da retentativa funciona", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    await runAction(resendOrder, panel(shop.storeId, support), { orderId: order.id });
    const [j] = (await jobsOf(order.id, "deliver_order")).filter((x) => x.status === "queued");
    lostReply = true;
    await expect(getHandlers().deliver_order!(j!, new AbortController().signal)).rejects.toThrow("Connection closed");
    lostReply = false;
    await getHandlers().deliver_order!(j!, new AbortController().signal); // retentativa do mesmo job
    const second = tokensIn(lastMailTo("maria@exemplo.com")!.text);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    expect((await download(shop, second[0]!)).status).toBe(200);
    expect(await countsOf(order.id)).toEqual([0, 2]);
  }, HEAVY_TEST_MS);

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
    // Todos os tokens dos links antigos foram revogados.
    const old = links.filter((l) => l.revokedAt !== null).map((l) => l.id);
    const oldTokens = (await t.ownerDb.select().from(downloadToken).where(eq(downloadToken.storeId, shop.storeId))).filter((x) => old.includes(x.linkId));
    expect(oldTokens.length).toBeGreaterThan(0);
    expect(oldTokens.every((x) => x.revokedAt !== null)).toBe(true);
    expect((await download(shop, tokens[1]!)).status).toBe(410);
    // disputed -> paid: restore só desfaz revogação por status, não a renovação.
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "disputed", "cb"));
    await runJobs(order.id, "revoke_downloads");
    await withStore(shop.storeId, (tx) => transitionOrder(systemCtx(shop.storeId, tx), order.id, "paid", "cb revertido"));
    await runJobs(order.id, "restore_downloads");
    const after = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(after.filter((l) => l.revokedAt !== null)).toHaveLength(2);
    expect((await download(shop, tokens[1]!)).status).toBe(410);
  }, HEAVY_TEST_MS);

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

  test("estorno recusado, estorno parcial e página de pagamento alterada: texto próprio, só com códigos", async () => {
    const shop = await seedShop();
    const h = getHandlers().notify_seller!;
    await h(sellerJob(shop.storeId, { reason: "estorno_falhou", httpStatus: 400, code: "insufficient_balance" }), new AbortController().signal);
    const refused = lastMailTo("dono@loja.com")!;
    expect(refused.subject).toMatch(/recusou o estorno/i);
    expect(refused.text).toContain("insufficient_balance");
    expect(refused.text).toMatch(/continua pago/);
    await h(sellerJob(shop.storeId, { reason: "estorno_parcial", refundedCents: 300 }), new AbortController().signal);
    const partial = lastMailTo("dono@loja.com")!;
    expect(partial.subject).toMatch(/parcial/i);
    expect(partial.text).toContain("R$ 3,00");
    await h(sellerJob(shop.storeId, { reason: "monitor_pagina_pagamento", page: "/c", code: "csp_diferente" }), new AbortController().signal);
    const monitor = lastMailTo("dono@loja.com")!;
    expect(monitor.subject).toMatch(/página de pagamento/i);
    expect(monitor.text).toContain("csp_diferente");
    await h(sellerJob(shop.storeId, { reason: "monitor_pagina_pagamento", page: "/form", code: "script_nao_autorizado" }), new AbortController().signal);
    expect(lastMailTo("dono@loja.com")!.text).toContain("na página do formulário do cartão");
    // Código fora do formato não é ecoado.
    await h(sellerJob(shop.storeId, { reason: "estorno_falhou", code: "<b>x</b>" }), new AbortController().signal);
    expect(lastMailTo("dono@loja.com")!.html).not.toContain("<b>x</b>");
  });

  test("conta Asaas anterior: manda liberar o pedido pelo botão do painel", async () => {
    const shop = await seedShop();
    await getHandlers().notify_seller!(sellerJob(shop.storeId, { reason: "evento_conta_asaas_anterior", paymentId: "pay_1" }), new AbortController().signal);
    expect(lastMailTo("dono@loja.com")!.text).toContain("Liberar pedido");
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
    const out = await runAction(saveSmtp, panel(storeId), { host: SMTP.host, user: SMTP.user, from: SMTP.from, port: SMTP.port, secure: true });
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

describe("GET e HEAD não contam download (robôs de e-mail)", () => {
  test("GET mostra 'Seu PDF está pronto' com formulário POST; GET e HEAD repetidos não contam; o POST conta", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    for (let i = 0; i < 8; i++) {
      const res = await view(shop, tokens[0]!);
      expect(res.status).toBe(200);
      if (i === 0) {
        const html = await res.text();
        expect(html).toContain("Seu PDF está pronto");
        expect(html).toContain(shop.mainName);
        expect(html).toContain('<form method="post">');
        expect(html).toContain("Baixar PDF");
        expect(html).toContain("5 de 5");
        expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      const head = handleDownloadHead();
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect(await countsOf(order.id)).toEqual([0, 0]);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    expect(await countsOf(order.id)).toEqual([0, 1]);
    expect(await (await view(shop, tokens[0]!)).text()).toContain("4 de 5");
  }, HEAVY_TEST_MS);

  test("HEAD não consulta nem gera nada", async () => {
    const shop = await seedShop();
    const o = await paidOrder(shop);
    await runJobs(o.id, "deliver_order");
    // sem storeId nem token: responde 200 sem tocar no banco ou no storage
    expect(handleDownloadHead().status).toBe(200);
  });

  test("GET de link inválido, esgotado ou de pedido reembolsado -> 410", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    expect((await view(shop, "z".repeat(43))).status).toBe(410);
    for (let i = 0; i < 5; i++) await download(shop, tokens[0]!);
    expect((await view(shop, tokens[0]!)).status).toBe(410);
    await runAction(refundOrder, panel(shop.storeId), { orderId: order.id });
    expect((await view(shop, tokens[1]!)).status).toBe(410);
  }, HEAVY_TEST_MS);

  test("POST de outro site: 303 de volta para a página do link, nada contado", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    const evil = await download(shop, tokens[0]!, { headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(303);
    expect(evil.headers.get("location")).toBe(`/d/${tokens[0]}`);
    const fetchSite = await download(shop, tokens[0]!, { headers: { "sec-fetch-site": "cross-site" } });
    expect(fetchSite.status).toBe(303);
    const nullOrigin = await download(shop, tokens[0]!, { headers: { origin: "null" } });
    expect(nullOrigin.status).toBe(303);
    expect(await countsOf(order.id)).toEqual([0, 0]);
    // O formulário da própria página: com Referrer-Policy no-referrer o navegador manda Origin: null + Sec-Fetch-Site.
    const own = await download(shop, tokens[0]!, { headers: { origin: "null", "sec-fetch-site": "same-origin" } });
    expect(own.status).toBe(200);
    expect(await countsOf(order.id)).toEqual([0, 1]);
  }, HEAVY_TEST_MS);
});

describe("cópias carimbadas: versão do arquivo, limpeza e varredura", () => {
  const copyKey = async (orderId: string, productId: string) => {
    const [p] = await t.ownerDb.select().from(product).where(eq(product.id, productId));
    return watermarkKey(orderId, productId, fileVersion(p!.fileKey, p!.fileSha256));
  };
  const mainLink = async (orderId: string) =>
    (await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, orderId))).find((l) => l.downloads > 0) ??
    (await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, orderId)))[0]!;

  test("a chave inclui a versão do arquivo (file_key + sha256): trocar o arquivo gera cópia nova", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    const link = await mainLink(order.id);
    const k1 = await copyKey(order.id, link.productId);
    expect(await storage.exists(k1)).toBe(true);
    await t.ownerDb.update(product).set({ fileSha256: "0".repeat(64) }).where(eq(product.id, link.productId));
    const k2 = await copyKey(order.id, link.productId);
    expect(k2).not.toBe(k1);
    expect((await download(shop, tokens[0]!)).status).toBe(200);
    expect(await storage.exists(k2)).toBe(true);
  }, HEAVY_TEST_MS);

  test("reembolso: revoke_downloads apaga as cópias do pedido", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    await download(shop, tokens[0]!);
    const link = await mainLink(order.id);
    const key = await copyKey(order.id, link.productId);
    expect(await storage.exists(key)).toBe(true);
    await runAction(refundOrder, panel(shop.storeId), { orderId: order.id });
    await runJobs(order.id, "revoke_downloads");
    expect(await storage.exists(key)).toBe(false);
  }, HEAVY_TEST_MS);

  test("renew apaga as cópias (depois do commit)", async () => {
    const shop = await seedShop();
    const { order, tokens } = await deliveredOrder(shop);
    await download(shop, tokens[0]!);
    const link = await mainLink(order.id);
    const key = await copyKey(order.id, link.productId);
    await runAction(resendOrder, panel(shop.storeId, support), { orderId: order.id, renew: true });
    expect(await storage.exists(key)).toBe(false);
  }, HEAVY_TEST_MS);

  test("varredura diária: apaga cópia de link vencido, revogado e sem download há 7 dias; mantém a de link em uso", async () => {
    const shop = await seedShop();
    const used = await deliveredOrder(shop, { email: "usado@exemplo.com" });
    const idle = await deliveredOrder(shop, { email: "parado@exemplo.com" });
    const expired = await deliveredOrder(shop, { email: "vencido@exemplo.com" });
    for (const o of [used, idle, expired]) await download(shop, o.tokens[0]!);
    const keys = await Promise.all([used, idle, expired].map(async (o) => copyKey(o.order.id, (await mainLink(o.order.id)).productId)));
    for (const k of keys) expect(await storage.exists(k)).toBe(true);
    const now = new Date();
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    await t.ownerDb.update(downloadLink).set({ lastDownloadAt: days(8), createdAt: days(9) }).where(eq(downloadLink.orderId, idle.order.id));
    await t.ownerDb.update(downloadLink).set({ expiresAt: days(1) }).where(eq(downloadLink.orderId, expired.order.id));
    await createSweepWatermarksHandler(() => now)({ id: crypto.randomUUID(), storeId: null, type: "sweep_watermarks", payload: {} } as Job, new AbortController().signal);
    expect(await storage.exists(keys[0]!)).toBe(true);
    expect(await storage.exists(keys[1]!)).toBe(false);
    expect(await storage.exists(keys[2]!)).toBe(false);
  }, 20_000); // três entregas com carimbo real no Worker: passa do orçamento padrão de 5 s

  test("sweep_watermarks está registrado e agendado como tipo de job", () => {
    expect(typeof getHandlers().sweep_watermarks).toBe("function");
  });
});

describe("SMTP: rede restrita no modo multi (SSRF) e senha", () => {
  const strict = (addresses: Record<string, string[]>) =>
    setSmtpNetworkForTests({ strict: true, lookup: async (h) => addresses[h] ?? [] });

  test("recusa portas fora de 25/465/587/2525", async () => {
    const { storeId } = await seedStore();
    strict({ "smtp.exemplo.com": ["198.51.200.10"] });
    await expect(runAction(saveSmtp, panel(storeId), { ...SMTP, port: 8080 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runAction(saveSmtp, panel(storeId), { ...SMTP, port: 1025 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("recusa host que resolve para endereço interno (loopback, privado, link-local, CGNAT, ULA, multicast) com mensagem genérica", async () => {
    const { storeId } = await seedStore();
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.20.1.1", "192.168.0.10", "169.254.169.254", "100.64.1.1", "::1", "fd00::1", "fe80::1", "224.0.0.1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      strict({ "smtp.exemplo.com": [ip] });
      const err = (await runAction(saveSmtp, panel(storeId), SMTP).catch((e: unknown) => e)) as ActionError;
      expect(err.code, ip).toBe("provider_error");
      expect(err.message, ip).toBe(SMTP_GENERIC_ERROR);
    }
    // um endereço público e outro interno: recusa (não escolhe o "bom")
    strict({ "smtp.exemplo.com": ["198.51.200.10", "10.0.0.5"] });
    await expect(runAction(saveSmtp, panel(storeId), SMTP)).rejects.toMatchObject({ message: SMTP_GENERIC_ERROR });
    // IP literal interno também
    strict({});
    await expect(runAction(saveSmtp, panel(storeId), { ...SMTP, host: "10.1.2.3" })).rejects.toMatchObject({ message: SMTP_GENERIC_ERROR });
    expect(await t.ownerDb.select().from(integration).where(eq(integration.storeId, storeId))).toHaveLength(0);
  });

  test("conecta no IP já resolvido (servername = host, sem nova resolução) no salvar, no teste e no envio", async () => {
    const { storeId } = await seedStore();
    strict({ "smtp.exemplo.com": ["198.51.200.10"] });
    await runAction(saveSmtp, panel(storeId), SMTP);
    expect(transports.at(-1)).toMatchObject({ host: "198.51.200.10", servername: "smtp.exemplo.com", port: 587 });
    // DNS rebinding: agora o nome aponta para dentro. Envio e teste resolvem de novo e recusam.
    strict({ "smtp.exemplo.com": ["127.0.0.1"] });
    await expect(sendMail(storeId, { to: "a@b.co", subject: "x", html: "x", text: "x" })).rejects.toMatchObject({ message: SMTP_GENERIC_ERROR });
    await expect(runAction(testSmtp, panel(storeId), { to: "a@b.co" })).rejects.toMatchObject({ message: SMTP_GENERIC_ERROR });
    strict({ "smtp.exemplo.com": ["203.0.114.7"] });
    await sendMail(storeId, { to: "a@b.co", subject: "x", html: "x", text: "x" });
    expect(transports.at(-1)).toMatchObject({ host: "203.0.114.7", servername: "smtp.exemplo.com" });
  });

  test("modo restrito: erro de autenticação também vira a mensagem genérica", async () => {
    const { storeId } = await seedStore();
    strict({ "smtp.exemplo.com": ["198.51.200.10"] });
    verifyError = Object.assign(new Error("535 Authentication failed"), { code: "EAUTH" });
    await expect(runAction(saveSmtp, panel(storeId), SMTP)).rejects.toMatchObject({ message: SMTP_GENERIC_ERROR });
  });

  test("fora do modo restrito (single/dev) nada muda: 127.0.0.1:1025 é aceito", async () => {
    const { storeId } = await seedStore();
    await runAction(saveSmtp, panel(storeId), { ...SMTP, host: "127.0.0.1", port: 1025, user: undefined, password: undefined });
    expect(transports.at(-1)).toMatchObject({ host: "127.0.0.1", port: 1025 });
  });

  test("trocar servidor, porta ou usuário exige a senha de novo (a senha guardada não vai para outro servidor)", async () => {
    const { storeId } = await seedStore();
    await runAction(saveSmtp, panel(storeId), SMTP);
    const noPass = { host: SMTP.host, port: SMTP.port, secure: SMTP.secure, user: SMTP.user, from: SMTP.from };
    for (const change of [{ host: "outro.exemplo.com" }, { port: 465 }, { user: "outro@exemplo.com" }]) {
      const before = transports.length;
      const err = (await runAction(saveSmtp, panel(storeId), { ...noPass, ...change }).catch((e: unknown) => e)) as ActionError;
      expect(err.code, JSON.stringify(change)).toBe("invalid_input");
      expect(err.message).toContain("informe a senha de novo");
      expect(transports.length).toBe(before); // nem chegou a conectar
    }
    // mesmo servidor/porta/usuário: mantém a senha guardada
    await runAction(saveSmtp, panel(storeId), { ...noPass, from: "novo@loja.com" });
    expect(transports.at(-1)!.password).toBe(SMTP.password);
    // com a senha: troca normalmente
    await runAction(saveSmtp, panel(storeId), { ...SMTP, host: "outro.exemplo.com", password: "outra-senha" });
  });
});

describe("oferta com N produtos: entrega", () => {
  test("aviso ao vendedor com sobra (1.000 em 3): uma linha de preço por grupo com os nomes, nunca 3,34 / 3,33", async () => {
    const shop = await seedKitShop(3, 1000);
    const o = await paidOrder(shop, { bump: false });
    await runJobs(o.id, "notify_seller");
    const m = lastMailTo("dono@loja.com")!;
    expect(m.text).toContain(`${shop.names.join(" + ")}: R$ 10,00`);
    for (const part of [m.text, m.html]) {
      expect(part).not.toContain("R$ 3,34");
      expect(part).not.toContain("R$ 3,33");
    }
  });

  test("parte texto: nome com quebra de linha não forja linhas (e-mail do comprador e aviso ao vendedor)", async () => {
    const evil = "PDF\nTotal pago (Pix): R$ 0,00\u2028Outra\r\nlinha";
    const shop = await seedKitShop(2, 2700, [evil, "Normal"]);
    const { order, mail } = await deliveredOrder(shop, { bump: false });
    await runJobs(order.id, "notify_seller");
    const seller = lastMailTo("dono@loja.com")!;
    for (const text of [mail.text, seller.text]) {
      const lines = text.split(/\r\n|\r|\n|\u2028|\u2029/);
      expect(lines.some((l) => l.startsWith("Total pago (Pix): R$ 0,00"))).toBe(false);
      expect(lines.some((l) => l === "linha" || l.startsWith("Outra"))).toBe(false);
      expect(text).toContain("PDF Total pago (Pix): R$ 0,00 Outra linha");
    }
  }, HEAVY_TEST_MS);

  test("Completo (6 PDFs): 6 links, e-mail na ordem da oferta, só o total (nunca R$ 4,50), assunto com o nome da oferta", async () => {
    const shop = await seedKitShop(6);
    const { order, mail, tokens } = await deliveredOrder(shop, { bump: false });
    expect(mail.subject).toBe("Seu acesso: Almanaque Completo");
    expect(tokens).toHaveLength(6);
    expect(await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id))).toHaveLength(6);
    for (const part of [mail.html, mail.text]) {
      expect(increasing(positionsIn(part, shop.names))).toBe(true);
      expect(part).not.toContain("R$ 4,50");
      expect(part).toContain("R$ 27,00");
    }
    // Cada link baixa o PDF do produto na mesma posição da oferta.
    const linkProducts = await t.ownerDb
      .select({ productId: downloadLink.productId, tokenHash: downloadToken.tokenHash })
      .from(downloadToken)
      .innerJoin(downloadLink, eq(downloadLink.id, downloadToken.linkId))
      .where(eq(downloadLink.orderId, order.id));
    const byHash = new Map(linkProducts.map((l) => [l.tokenHash, l.productId]));
    expect(tokens.map((tk) => byHash.get(sha256(tk)))).toEqual(shop.productIds);
  }, HEAVY_TEST_MS);

  test("aviso ao vendedor de oferta com N principais: assunto com o nome da oferta", async () => {
    const shop = await seedKitShop(3);
    const o = await paidOrder(shop, { bump: false });
    await runJobs(o.id, "notify_seller");
    const m = lastMailTo("dono@loja.com")!;
    expect(m.subject).toBe("Nova venda: Almanaque Completo — R$ 27,00");
    expect(increasing(positionsIn(m.text, shop.names))).toBe(true);
  });

  test("reordenar a oferta depois do pedido não muda o e-mail desse pedido; o pedido novo segue a ordem nova", async () => {
    const shop = await seedKitShop(3);
    const pending = await newOrder(shop, { bump: false });
    const reversed = [...shop.productIds].reverse();
    await runAction(setOfferProducts, panel(shop.storeId), { id: shop.offerId, productIds: reversed, bump: null });
    await runAction(releaseOrder, panel(shop.storeId), { orderId: pending.id });
    await runJobs(pending.id, "deliver_order");
    const first = lastMailTo("maria@exemplo.com")!;
    expect(increasing(positionsIn(first.text, shop.names))).toBe(true);

    const { mail } = await deliveredOrder(shop, { bump: false, email: "joana@exemplo.com" });
    expect(increasing(positionsIn(mail.text, [...shop.names].reverse()))).toBe(true);
  }, HEAVY_TEST_MS);

  test("trocar os produtos da oferta com o pedido pendente não altera a entrega dele", async () => {
    const shop = await seedKitShop(2);
    const other = await seedPdfProduct(shop.storeId, "Outro PDF", "outro.pdf", await pdf(1));
    const pending = await newOrder(shop, { bump: false });
    await runAction(setOfferProducts, panel(shop.storeId), { id: shop.offerId, productIds: [other.id], bump: null });
    await runAction(releaseOrder, panel(shop.storeId), { orderId: pending.id });
    await runJobs(pending.id, "deliver_order");
    const m = lastMailTo("maria@exemplo.com")!;
    expect(m.subject).toBe("Seu acesso: Almanaque Completo");
    expect(m.text).not.toContain("Outro PDF");
    expect(tokensIn(m.text)).toHaveLength(2);
    const links = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, pending.id));
    expect(links.map((l) => l.productId).sort()).toEqual([...shop.productIds].sort());
  }, HEAVY_TEST_MS);

  test("reembolso de um pedido de 6 itens revoga os 6 links", async () => {
    const shop = await seedKitShop(6);
    const { order, tokens } = await deliveredOrder(shop, { bump: false });
    await runAction(refundOrder, panel(shop.storeId), { orderId: order.id });
    await runJobs(order.id, "revoke_downloads");
    const links = await t.ownerDb.select().from(downloadLink).where(eq(downloadLink.orderId, order.id));
    expect(links).toHaveLength(6);
    expect(links.every((l) => l.revokedAt instanceof Date)).toBe(true);
    for (const tk of tokens) expect((await download(shop, tk)).status).toBe(410);
  }, HEAVY_TEST_MS);
});

describe("envio pelo Resend", () => {
  const API_KEY = "re_AbCdEfGh_1234";
  let resendCalls: { headers: Record<string, string>; body: { to: string[]; subject: string } }[] = [];
  let resendStatus = 200;
  const fakeResend = () => {
    resendCalls = [];
    resendStatus = 200;
    setResendFetchForTests((async (_url: string | URL | Request, init?: RequestInit) => {
      resendCalls.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
      return resendStatus === 200
        ? new Response(JSON.stringify({ id: `msg_${resendCalls.length}` }), { status: 200 })
        : new Response(JSON.stringify({ message: `chave ${API_KEY} inválida` }), { status: resendStatus });
    }) as typeof fetch);
  };
  const useResend = async (storeId: string) => {
    await runAction(saveResend, panel(storeId), { fromEmail: "vendas@loja.com", apiKey: API_KEY });
    await runAction(setEmailProvider, panel(storeId), { provider: "resend" });
  };
  const logsOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(emailLog).orderBy(emailLog.at));
  const sellerJob = (storeId: string, payload: unknown) => ({ id: crypto.randomUUID(), storeId, type: "notify_seller", payload }) as Job;

  test("com Resend ativo: envia pela API com Idempotency-Key = id do job e grava provider e message id; nada no SMTP", async () => {
    const shop = await seedShop();
    await useResend(shop.storeId);
    fakeResend();
    const o = await paidOrder(shop, { bump: true });
    const [j] = await jobsOf(o.id, "deliver_order");
    await getHandlers().deliver_order!(j!, new AbortController().signal);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]!.headers["Idempotency-Key"]).toBe(j!.id);
    expect(resendCalls[0]!.body.to).toEqual(["maria@exemplo.com"]);
    expect(outbox).toHaveLength(0);
    const logs = (await logsOf(shop.storeId)).filter((l) => l.kind === "delivery");
    expect(logs.map((l) => [l.status, l.provider, l.providerMessageId, l.jobId])).toEqual([["sent", "resend", "msg_1", j!.id]]);
  }, HEAVY_TEST_MS);

  test("com SMTP ativo (padrão), nada muda: provider smtp e message id nulo", async () => {
    const shop = await seedShop();
    fakeResend();
    const o = await paidOrder(shop);
    await runJobs(o.id, "deliver_order");
    expect(resendCalls).toHaveLength(0);
    expect(lastMailTo("maria@exemplo.com")).toBeDefined();
    const logs = (await logsOf(shop.storeId)).filter((l) => l.kind === "delivery");
    expect(logs.map((l) => [l.status, l.provider, l.providerMessageId])).toEqual([["sent", "smtp", null]]);
  }, HEAVY_TEST_MS);

  test("Resend recusando (401): email_log failed com a mensagem fixa e sem a chave; o job lança", async () => {
    const shop = await seedShop();
    await useResend(shop.storeId);
    fakeResend();
    resendStatus = 401;
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "deliver_order");
    await expect(getHandlers().deliver_order!(j!, new AbortController().signal)).rejects.toMatchObject({ code: "provider_error", message: RESEND_ERRORS.key });
    const logs = (await logsOf(shop.storeId)).filter((l) => l.kind === "delivery");
    expect(logs.map((l) => [l.status, l.provider, l.providerMessageId, l.error])).toEqual([["failed", "resend", null, RESEND_ERRORS.key]]);
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
  }, HEAVY_TEST_MS);

  test("Resend ativo com segredo ilegível: provider_error 'E-mail não configurado' e email_log failed; sem cair no SMTP", async () => {
    const shop = await seedShop();
    await useResend(shop.storeId);
    fakeResend();
    await t.ownerDb.update(integration).set({ secret: "v1.lixo" }).where(and(eq(integration.storeId, shop.storeId), eq(integration.kind, "resend")));
    const o = await paidOrder(shop);
    const [j] = await jobsOf(o.id, "deliver_order");
    await expect(getHandlers().deliver_order!(j!, new AbortController().signal)).rejects.toMatchObject({ code: "provider_error", message: "E-mail não configurado" });
    expect(resendCalls).toHaveLength(0);
    expect(outbox).toHaveLength(0);
    const logs = (await logsOf(shop.storeId)).filter((l) => l.kind === "delivery");
    expect(logs.map((l) => [l.status, l.provider, l.error])).toEqual([["failed", "resend", "E-mail não configurado"]]);
  }, HEAVY_TEST_MS);

  test("notify_seller pelo Resend grava provider e id", async () => {
    const shop = await seedShop();
    await useResend(shop.storeId);
    fakeResend();
    const j = sellerJob(shop.storeId, { reason: "chave_asaas_invalida", httpStatus: 401 });
    await getHandlers().notify_seller!(j, new AbortController().signal);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0]!.headers["Idempotency-Key"]).toBe(j.id);
    expect(resendCalls[0]!.body.to).toEqual(["dono@loja.com"]);
    const logs = (await logsOf(shop.storeId)).filter((l) => l.kind === "seller_notice");
    expect(logs.map((l) => [l.status, l.provider, l.providerMessageId])).toEqual([["sent", "resend", "msg_1"]]);
  });
});
