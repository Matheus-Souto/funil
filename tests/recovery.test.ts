// Tabelas da recuperação de vendas por e-mail (`recovery_email` e `email_optout`): isolamento por loja (RLS) e
// restrições do banco (kind x order_id, um lembrete por pedido e tipo). Varredura `recovery_scan`: candidatos dos três
// casos, dedupe, tetos e proteção do cartão (relógio injetado, datas mudadas no banco). Envio `recovery_send`: e-mail
// pelo provedor da loja (SMTP falso), conferência de novo do caso na hora do envio, falhas e o que nunca vai a log.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { auditLog, cardAttempt, checkoutLead, emailLog, emailOptout, job, offer, orders, recoveryEmail, store } from "@/lib/db/schema";
import { storeBaseUrl } from "@/lib/delivery/links";
import { saveSmtp, setMailTransportForTests, type SentMail } from "@/lib/delivery/mailer";
import { saveResend, setEmailProvider, setResendFetchForTests } from "@/lib/delivery/resend";
import { dateTimeSP } from "@/lib/format";
import type { Job } from "@/lib/jobs";
import { cardBreakerKey, cardDeclineIpKey } from "@/lib/payments/card-keys";
import { recordEvent } from "@/lib/payments/ratelimit";
import { createRecoveryScanHandler } from "@/lib/recovery/scan";
import { createRecoverySendHandler } from "@/lib/recovery/send";
import { createTestDb, seedStore, type TestDb } from "./db";
import { panelCall, seedOrder, seedPanelStore, type PanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const DAY_MS = 86_400_000;

/** SQLSTATE e constraint do erro do Postgres (o drizzle o embrulha em `cause`). */
async function pgError(run: () => PromiseLike<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run();
  } catch (e) {
    const err = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint_name?: string };
    return { code: err.code, constraint: err.constraint_name };
  }
  return {};
}
const CHECK = "23514";
const UNIQUE = "23505";

function row(
  storeId: string,
  offerId: string,
  kind: "lead" | "pix" | "card",
  over: Partial<typeof recoveryEmail.$inferInsert> = {},
): typeof recoveryEmail.$inferInsert {
  return {
    storeId,
    offerId,
    kind,
    emailHash: sha(randomUUID()),
    unsubHash: sha(randomUUID()),
    dueAt: new Date(),
    expiresAt: new Date(Date.now() + 90 * DAY_MS),
    ...over,
  };
}

async function seedLead(storeId: string, offerId: string): Promise<string> {
  const email = `contato-${randomUUID()}@example.com`;
  const [l] = await t.ownerDb
    .insert(checkoutLead)
    .values({ storeId, offerId, keyHash: sha(randomUUID()), email, emailHash: sha(email), expiresAt: new Date(Date.now() + 30 * DAY_MS) })
    .returning({ id: checkoutLead.id });
  return l!.id;
}

describe("recovery_email e email_optout", () => {
  test("RLS: recovery_email e email_optout de outra loja não aparecem", async () => {
    const a = await seedPanelStore();
    const b = await seedPanelStore();
    await withStore(b.storeId, (tx) => tx.insert(recoveryEmail).values(row(b.storeId, b.offerId, "lead")));
    await withStore(b.storeId, (tx) => tx.insert(emailOptout).values({ storeId: b.storeId, emailHash: sha("x"), reason: "unsubscribe" }));

    expect(await withStore(a.storeId, (tx) => tx.select().from(recoveryEmail))).toHaveLength(0);
    expect(await withStore(a.storeId, (tx) => tx.select().from(emailOptout))).toHaveLength(0);
    expect(await withStore(b.storeId, (tx) => tx.select().from(recoveryEmail))).toHaveLength(1);
    expect(await withStore(b.storeId, (tx) => tx.select().from(emailOptout))).toHaveLength(1);
    // gravar com o store_id de outra loja também é recusado
    await expect(withStore(a.storeId, (tx) => tx.insert(recoveryEmail).values(row(b.storeId, b.offerId, "lead")))).rejects.toThrow();
    await expect(
      withStore(a.storeId, (tx) => tx.insert(emailOptout).values({ storeId: b.storeId, emailHash: sha("y"), reason: "bounce" })),
    ).rejects.toThrow();
  });

  test("lead sem order_id ok; pix sem order_id recusado", async () => {
    const s = await seedPanelStore();
    const order = await seedOrder(s, { status: "pending" });

    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead"));
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "pix")))).toEqual({
      code: CHECK,
      constraint: "recovery_email_kind_order_check",
    });
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "card")))).toEqual({
      code: CHECK,
      constraint: "recovery_email_kind_order_check",
    });
    // lead com pedido também é recusado; pix com pedido ok
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead", { orderId: order.id })))).toEqual({
      code: CHECK,
      constraint: "recovery_email_kind_order_check",
    });
    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "pix", { orderId: order.id }));
    // kind e status fora da lista
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "boleto" as "lead")))).toEqual({
      code: CHECK,
      constraint: "recovery_email_kind_check",
    });
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead", { status: "perdido" })))).toEqual({
      code: CHECK,
      constraint: "recovery_email_status_check",
    });
  });

  test("lead apagado (lead_id nulo) continua válido e um lead só tem um lembrete", async () => {
    const s = await seedPanelStore();
    const leadId = await seedLead(s.storeId, s.offerId);
    const [kept] = await t.ownerDb
      .insert(recoveryEmail)
      .values(row(s.storeId, s.offerId, "lead", { leadId }))
      .returning({ id: recoveryEmail.id });
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead", { leadId })))).toEqual({
      code: UNIQUE,
      constraint: "recovery_email_lead_uniq",
    });
    // apagado o contato, a linha daquele lembrete fica com lead_id nulo (ON DELETE SET NULL) e continua válida
    await t.ownerDb.delete(checkoutLead).where(eq(checkoutLead.id, leadId));
    const [after] = await t.ownerDb.select().from(recoveryEmail).where(eq(recoveryEmail.id, kept!.id));
    expect(after).toBeDefined();
    expect(after!.leadId).toBeNull();
    expect(after!.orderId).toBeNull();
    // dois leads sem lead_id (contato apagado) convivem: o único é parcial
    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead"));
  });

  test("segundo lembrete do mesmo pedido e caso recusado (único)", async () => {
    const s = await seedPanelStore();
    const order = await seedOrder(s, { status: "pending", method: "card_asaas" });
    const other = await seedOrder(s, { status: "pending", method: "pix_asaas" });

    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "card", { orderId: order.id }));
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "card", { orderId: order.id })))).toEqual({
      code: UNIQUE,
      constraint: "recovery_email_order_kind_uniq",
    });
    // outro tipo no mesmo pedido, ou o mesmo tipo em outro pedido, é aceito
    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "pix", { orderId: order.id }));
    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "card", { orderId: other.id }));
    // o unsub_hash é único
    const dup = sha(randomUUID());
    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead", { unsubHash: dup }));
    expect((await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead", { unsubHash: dup })))).code).toBe(UNIQUE);
  });

  test("email_optout: um por loja e e-mail; motivo fora da lista recusado", async () => {
    const { storeId } = await seedStore("Loja optout");
    const emailHash = sha("a@example.com");
    await t.ownerDb.insert(emailOptout).values({ storeId, emailHash, reason: "unsubscribe" });
    expect((await pgError(() => t.ownerDb.insert(emailOptout).values({ storeId, emailHash, reason: "complaint" }))).code).toBe(UNIQUE);
    expect(await pgError(() => t.ownerDb.insert(emailOptout).values({ storeId, emailHash: sha("b"), reason: "spam" as "bounce" }))).toEqual({
      code: CHECK,
      constraint: "email_optout_reason_check",
    });
  });
});

// ---- Varredura (`recovery_scan`) -------------------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Relógio da varredura: fixo no início do arquivo; as datas dos candidatos são relativas a ele. */
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const scan = (at: Date = NOW) => createRecoveryScanHandler(() => at)({} as never, new AbortController().signal);
const emailHash = (email: string) => sha(email.trim().toLowerCase());
const newEmail = () => `cliente.${randomUUID()}@exemplo.com`;
/** IP de teste único por chamada (o `rate_limit` é global entre lojas e testes). */
const newIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

type Flags = { on?: boolean; lead?: boolean; pix?: boolean; card?: boolean; capture?: boolean };
async function shop(f: Flags = {}) {
  const s = await seedPanelStore("Loja recuperação");
  await t.ownerDb
    .update(store)
    .set({
      recoveryOn: f.on ?? true,
      recoveryLead: f.lead ?? true,
      recoveryPix: f.pix ?? true,
      recoveryCard: f.card ?? true,
      leadCapture: f.capture ?? true,
      privacyEmail: "privacidade@exemplo.com",
    })
    .where(eq(store.id, s.storeId));
  return s;
}

async function lead(s: { storeId: string; offerId: string }, createdAt: Date, over: Partial<typeof checkoutLead.$inferInsert> = {}) {
  const email = newEmail();
  const [l] = await t.ownerDb
    .insert(checkoutLead)
    .values({
      storeId: s.storeId,
      offerId: s.offerId,
      keyHash: sha(randomUUID()),
      email,
      emailHash: sha(email),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 30 * DAY_MS),
      ...over,
    })
    .returning();
  return { ...l!, email: l!.email ?? email };
}

async function pixOrder(s: Parameters<typeof seedOrder>[0], createdAt: Date, over: { email?: string; expiresAt?: Date; status?: "pending" | "paid" } = {}) {
  const email = over.email ?? newEmail();
  const o = await seedOrder(s, { status: over.status ?? "pending", method: "pix_asaas", createdAt, email });
  if (over.expiresAt) await t.ownerDb.update(orders).set({ expiresAt: over.expiresAt }).where(eq(orders.id, o.id));
  return { ...o, email };
}

/** Pedido de cartão pendente com `declines` recusas, a 1ª resolvida em `firstDecline`. */
async function cardOrder(
  s: Parameters<typeof seedOrder>[0],
  firstDecline: Date,
  over: { declines?: number; ip?: string; email?: string } = {},
) {
  const email = over.email ?? newEmail();
  const o = await seedOrder(s, { status: "pending", method: "card_asaas", createdAt: new Date(firstDecline.getTime() - MIN), email });
  const ip = over.ip ?? newIp();
  await t.ownerDb.update(orders).set({ clientIp: ip }).where(eq(orders.id, o.id));
  const n = over.declines ?? 1;
  await t.ownerDb.insert(cardAttempt).values(
    Array.from({ length: n }, (_, i) => ({
      storeId: s.storeId,
      orderId: o.id,
      idempotencyKey: randomUUID(),
      status: "declined",
      createdAt: new Date(firstDecline.getTime() + i * 1000 - 500),
      resolvedAt: new Date(firstDecline.getTime() + i * 1000),
    })),
  );
  return { ...o, email, ip };
}

const rowsOf = (storeId: string) => t.ownerDb.select().from(recoveryEmail).where(eq(recoveryEmail.storeId, storeId));
const sendJobsOf = (storeId: string) =>
  t.ownerDb.select().from(job).where(and(eq(job.type, "recovery_send"), eq(job.storeId, storeId)));

/** Linha "lembrete já existente" (para dedupe e tetos), direto no banco. */
function pastRow(s: { storeId: string; offerId: string }, over: Partial<typeof recoveryEmail.$inferInsert> = {}) {
  return row(s.storeId, s.offerId, "lead", { status: "sent", createdAt: ago(10 * MIN), ...over });
}

describe("recovery_scan", () => {
  test("lead aberto há 61 min → 1 linha queued e 1 job recovery_send; há 59 min → nada", async () => {
    const s = await shop();
    const due = await lead(s, ago(61 * MIN));
    const early = await lead(s, ago(59 * MIN));
    await scan();
    const rows = await rowsOf(s.storeId);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({ kind: "lead", leadId: due.id, orderId: null, offerId: s.offerId, status: "queued", skipReason: null });
    expect(r.emailHash).toBe(emailHash(due.email));
    expect(r.dueAt.getTime()).toBe(due.createdAt.getTime() + 60 * MIN);
    expect(r.expiresAt.getTime()).toBe(NOW.getTime() + 90 * DAY_MS);
    const jobs = await sendJobsOf(s.storeId);
    expect(jobs).toHaveLength(1);
    const payload = jobs[0]!.payload as { recoveryId: string; unsubToken: string };
    expect(payload.recoveryId).toBe(r.id);
    // O token em claro só no payload; a linha guarda o sha256 dele.
    expect(payload.unsubToken.length).toBeGreaterThanOrEqual(43);
    expect(r.unsubHash).toBe(sha(payload.unsubToken));
    expect(rows.some((x) => x.leadId === early.id)).toBe(false);
    // Uma segunda varredura não repete o lembrete.
    await scan();
    expect(await rowsOf(s.storeId)).toHaveLength(1);
    expect(await sendJobsOf(s.storeId)).toHaveLength(1);
  });

  test("lead criado há 7 h → nada (janela de 6 h)", async () => {
    const s = await shop();
    await lead(s, ago(7 * HOUR));
    await scan();
    expect(await rowsOf(s.storeId)).toHaveLength(0);
  });

  test("lead convertido, contatado ou vencido → nada", async () => {
    const s = await shop();
    await lead(s, ago(2 * HOUR), { status: "converted", email: null, phone: null });
    await lead(s, ago(2 * HOUR), { status: "contacted" });
    await lead(s, ago(2 * HOUR), { expiresAt: ago(MIN) });
    await scan();
    expect(await rowsOf(s.storeId)).toHaveLength(0);
  });

  test("loja liga a recuperação com 50 abandonos de ontem → nenhuma linha", async () => {
    const s = await shop({ on: false });
    const yesterday = ago(DAY_MS);
    await t.ownerDb.insert(checkoutLead).values(
      Array.from({ length: 50 }, (_, i) => {
        const email = `ontem.${i}.${randomUUID()}@exemplo.com`;
        return {
          storeId: s.storeId,
          offerId: s.offerId,
          keyHash: sha(randomUUID()),
          email,
          emailHash: sha(email),
          createdAt: new Date(yesterday.getTime() + i * MIN),
          expiresAt: new Date(yesterday.getTime() + 30 * DAY_MS),
        };
      }),
    );
    await pixOrder(s, ago(DAY_MS - HOUR));
    await scan();
    expect(await rowsOf(s.storeId)).toHaveLength(0);
    await t.ownerDb.update(store).set({ recoveryOn: true }).where(eq(store.id, s.storeId));
    await scan();
    expect(await rowsOf(s.storeId)).toHaveLength(0);
    expect(await sendJobsOf(s.storeId)).toHaveLength(0);
  });

  test("pix pendente há 31 min → enfileira; Pix que vence em 50 min → nada; pedido pago → nada", async () => {
    const s = await shop();
    const due = await pixOrder(s, ago(31 * MIN));
    await pixOrder(s, ago(40 * MIN), { expiresAt: new Date(NOW.getTime() + 50 * MIN) });
    await pixOrder(s, ago(40 * MIN), { status: "paid" });
    await pixOrder(s, ago(29 * MIN));
    await scan();
    const rows = await rowsOf(s.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "pix", orderId: due.id, leadId: null, offerId: s.offerId, status: "queued" });
    expect(rows[0]!.emailHash).toBe(emailHash(due.email));
    expect(rows[0]!.dueAt.getTime()).toBe(due.createdAt.getTime() + 30 * MIN);
    expect(await sendJobsOf(s.storeId)).toHaveLength(1);
  });

  test("cartão com 1 recusa há 31 min → enfileira; com 4 recusas → skipped cartao_suspeito", async () => {
    const s = await shop();
    const first = ago(31 * MIN);
    const one = await cardOrder(s, first);
    const four = await cardOrder(s, ago(40 * MIN), { declines: 4 });
    const recent = await cardOrder(s, ago(29 * MIN));
    await scan();
    const rows = await rowsOf(s.storeId);
    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.orderId === one.id)!;
    expect(ok).toMatchObject({ kind: "card", status: "queued", skipReason: null, offerId: s.offerId });
    expect(ok.dueAt.getTime()).toBe(first.getTime() + 30 * MIN);
    expect(rows.find((r) => r.orderId === four.id)).toMatchObject({ kind: "card", status: "skipped", skipReason: "cartao_suspeito" });
    expect(rows.some((r) => r.orderId === recent.id)).toBe(false);
    // Só o enfileirado ganha job; o pulado não.
    const jobs = await sendJobsOf(s.storeId);
    expect(jobs.map((j) => (j.payload as { recoveryId: string }).recoveryId)).toEqual([ok.id]);
  });

  test("disjuntor da loja disparado há 1 h → skipped cartao_suspeito", async () => {
    const s = await shop();
    await recordEvent(cardBreakerKey(s.storeId), ago(HOUR));
    const o = await cardOrder(s, ago(31 * MIN));
    await scan();
    expect(await rowsOf(s.storeId)).toMatchObject([{ orderId: o.id, status: "skipped", skipReason: "cartao_suspeito" }]);
    expect(await sendJobsOf(s.storeId)).toHaveLength(0);
  });

  test("disjuntor de 3 h atrás (mais de 2 h antes da 1ª recusa) não conta", async () => {
    const s = await shop();
    await recordEvent(cardBreakerKey(s.storeId), ago(3 * HOUR));
    const o = await cardOrder(s, ago(31 * MIN));
    await scan();
    expect(await rowsOf(s.storeId)).toMatchObject([{ orderId: o.id, status: "queued" }]);
  });

  test("cartão suspeito (disjuntor há 1 h) adiado pelo teto e reavaliado 3 h depois → skipped cartao_suspeito, sem job", async () => {
    // Teto do cartão cheio (10 lembretes na última hora) nas duas lojas.
    const fillCardCap = async (s: Awaited<ReturnType<typeof shop>>) => {
      for (let i = 0; i < 10; i++) {
        const o = await seedOrder(s, { status: "pending", method: "card_asaas", createdAt: ago(3 * HOUR) });
        await t.ownerDb.insert(recoveryEmail).values(pastRow(s, { kind: "card", orderId: o.id }));
      }
    };
    // Avaliado já: o motivo de pulo vem antes do teto (a linha skipped não gasta teto e é definitiva).
    const now = await shop();
    await fillCardCap(now);
    await recordEvent(cardBreakerKey(now.storeId), ago(HOUR));
    const a = await cardOrder(now, ago(31 * MIN));
    // Adiado (sem varredura agora) e reavaliado 3 h depois: a janela ancorada na 1ª recusa ainda vê o disjuntor.
    const later = await shop();
    await fillCardCap(later);
    await recordEvent(cardBreakerKey(later.storeId), ago(HOUR));
    const b = await cardOrder(later, ago(31 * MIN));
    await createRecoveryScanHandler(
      () => NOW,
      async (storeId) => {
        if (storeId === later.storeId) throw new Error("loja adiada neste teste");
      },
    )({} as never, new AbortController().signal).catch(() => undefined);
    expect((await rowsOf(now.storeId)).filter((r) => r.orderId === a.id)).toMatchObject([{ status: "skipped", skipReason: "cartao_suspeito" }]);
    expect(await sendJobsOf(now.storeId)).toHaveLength(0);
    expect((await rowsOf(later.storeId)).filter((r) => r.orderId === b.id)).toHaveLength(0);
    await scan(new Date(NOW.getTime() + 3 * HOUR));
    expect((await rowsOf(later.storeId)).filter((r) => r.orderId === b.id)).toMatchObject([{ status: "skipped", skipReason: "cartao_suspeito" }]);
    expect(await sendJobsOf(later.storeId)).toHaveLength(0);
  });

  test("evidência só perto da recusa (disjuntor há 4 h, recusa há 4,5 h; IP com 4 recusas há 4,4 h) → skipped cartao_suspeito", async () => {
    const s = await shop();
    await recordEvent(cardBreakerKey(s.storeId), ago(4 * HOUR));
    const o = await cardOrder(s, ago(4.5 * HOUR));
    const ipShop = await shop();
    const busyIp = newIp();
    for (let i = 0; i < 4; i++) await recordEvent(cardDeclineIpKey(busyIp), ago(4.4 * HOUR - i * MIN));
    const ipOrder = await cardOrder(ipShop, ago(4.5 * HOUR), { ip: busyIp });
    // Disjuntor de 7 h atrás está a mais de 2 h antes da 1ª recusa (4,5 h): não conta.
    const old = await shop();
    await recordEvent(cardBreakerKey(old.storeId), ago(7 * HOUR));
    const clean = await cardOrder(old, ago(4.5 * HOUR));
    await scan();
    expect(await rowsOf(s.storeId)).toMatchObject([{ orderId: o.id, status: "skipped", skipReason: "cartao_suspeito" }]);
    expect(await rowsOf(ipShop.storeId)).toMatchObject([{ orderId: ipOrder.id, status: "skipped", skipReason: "cartao_suspeito" }]);
    expect(await rowsOf(old.storeId)).toMatchObject([{ orderId: clean.id, status: "queued" }]);
    expect(await sendJobsOf(s.storeId)).toHaveLength(0);
    expect(await sendJobsOf(ipShop.storeId)).toHaveLength(0);
  });

  test("IP do pedido com 4 recusas em 2 h → skipped; com 3 → enfileira", async () => {
    const s = await shop();
    const busyIp = newIp();
    const calmIp = newIp();
    for (let i = 0; i < 4; i++) await recordEvent(cardDeclineIpKey(busyIp), ago(90 * MIN - i * MIN));
    for (let i = 0; i < 3; i++) await recordEvent(cardDeclineIpKey(calmIp), ago(90 * MIN - i * MIN));
    const busy = await cardOrder(s, ago(31 * MIN), { ip: busyIp });
    const calm = await cardOrder(s, ago(31 * MIN), { ip: calmIp });
    await scan();
    const rows = await rowsOf(s.storeId);
    expect(rows.find((r) => r.orderId === busy.id)).toMatchObject({ status: "skipped", skipReason: "cartao_suspeito" });
    expect(rows.find((r) => r.orderId === calm.id)).toMatchObject({ status: "queued" });
  });

  test("IP desconhecido → skipped cartao_suspeito", async () => {
    const s = await shop();
    const o = await cardOrder(s, ago(31 * MIN), { ip: "unknown" });
    await scan();
    expect(await rowsOf(s.storeId)).toMatchObject([{ orderId: o.id, status: "skipped", skipReason: "cartao_suspeito" }]);
  });

  test("mesmo e-mail com lembrete há 2 h (outro caso) → skipped endereco_24h", async () => {
    const s = await shop();
    const o = await pixOrder(s, ago(31 * MIN));
    await t.ownerDb.insert(recoveryEmail).values(pastRow(s, { emailHash: emailHash(o.email), createdAt: ago(2 * HOUR) }));
    await scan();
    const rows = (await rowsOf(s.storeId)).filter((r) => r.orderId === o.id);
    expect(rows).toMatchObject([{ kind: "pix", status: "skipped", skipReason: "endereco_24h" }]);
    expect(await sendJobsOf(s.storeId)).toHaveLength(0);
  });

  test("lembrete pulado (skipped) do mesmo e-mail não conta para o dedupe", async () => {
    const s = await shop();
    const o = await pixOrder(s, ago(31 * MIN));
    await t.ownerDb.insert(recoveryEmail).values(pastRow(s, { emailHash: emailHash(o.email), createdAt: ago(2 * HOUR), status: "skipped" }));
    await scan();
    expect((await rowsOf(s.storeId)).filter((r) => r.orderId === o.id)).toMatchObject([{ status: "queued" }]);
  });

  test("3 lembretes em 30 dias → skipped endereco_30d", async () => {
    const s = await shop();
    const l = await lead(s, ago(61 * MIN));
    const h = emailHash(l.email);
    await t.ownerDb
      .insert(recoveryEmail)
      .values([2, 5, 10].map((d) => pastRow(s, { emailHash: h, createdAt: ago(d * DAY_MS) })));
    await scan();
    expect((await rowsOf(s.storeId)).filter((r) => r.leadId === l.id)).toMatchObject([{ status: "skipped", skipReason: "endereco_30d" }]);
  });

  test("e-mail em email_optout → skipped optout", async () => {
    const s = await shop();
    const l = await lead(s, ago(61 * MIN));
    await t.ownerDb.insert(emailOptout).values({ storeId: s.storeId, emailHash: emailHash(l.email), reason: "unsubscribe" });
    await scan();
    expect(await rowsOf(s.storeId)).toMatchObject([{ leadId: l.id, status: "skipped", skipReason: "optout" }]);
    expect(await sendJobsOf(s.storeId)).toHaveLength(0);
    // Pulado com linha: a próxima varredura não volta a ele.
    await scan();
    expect(await rowsOf(s.storeId)).toHaveLength(1);
  });

  test("já comprou a oferta há 10 dias → skipped ja_comprou", async () => {
    const s = await shop();
    const l = await lead(s, ago(61 * MIN));
    await seedOrder(s, { status: "paid", email: l.email, createdAt: ago(10 * DAY_MS), paidAt: ago(10 * DAY_MS) });
    const pix = await pixOrder(s, ago(31 * MIN));
    await seedOrder(s, { status: "refunded", email: pix.email, createdAt: ago(10 * DAY_MS), paidAt: ago(10 * DAY_MS) });
    // Compra de 40 dias atrás não conta.
    const old = await pixOrder(s, ago(45 * MIN));
    await seedOrder(s, { status: "paid", email: old.email, createdAt: ago(40 * DAY_MS), paidAt: ago(40 * DAY_MS) });
    await scan();
    const rows = await rowsOf(s.storeId);
    expect(rows.find((r) => r.leadId === l.id)).toMatchObject({ status: "skipped", skipReason: "ja_comprou" });
    expect(rows.find((r) => r.orderId === pix.id)).toMatchObject({ status: "skipped", skipReason: "ja_comprou" });
    expect(rows.find((r) => r.orderId === old.id)).toMatchObject({ status: "queued" });
  });

  test("dois Pix do mesmo cliente e oferta → só o mais novo recebe", async () => {
    const s = await shop();
    const email = newEmail();
    const older = await pixOrder(s, ago(50 * MIN), { email });
    const newer = await pixOrder(s, ago(35 * MIN), { email });
    await scan();
    const rows = await rowsOf(s.storeId);
    expect(rows.find((r) => r.orderId === older.id)).toMatchObject({ status: "skipped", skipReason: "pedido_mais_novo" });
    expect(rows.find((r) => r.orderId === newer.id)).toMatchObject({ status: "queued" });
    const jobs = await sendJobsOf(s.storeId);
    expect(jobs.map((j) => (j.payload as { recoveryId: string }).recoveryId)).toEqual([rows.find((r) => r.orderId === newer.id)!.id]);
  });

  test("61º lembrete da loja na hora → sem linha (volta na próxima varredura)", async () => {
    const s = await shop();
    await t.ownerDb.insert(recoveryEmail).values(Array.from({ length: 60 }, () => pastRow(s)));
    const o = await pixOrder(s, ago(31 * MIN));
    await scan();
    expect((await rowsOf(s.storeId)).filter((r) => r.orderId === o.id)).toHaveLength(0);
    expect(await sendJobsOf(s.storeId)).toHaveLength(0);
    // Passada a hora, o mesmo candidato entra.
    await t.ownerDb.update(recoveryEmail).set({ createdAt: ago(2 * HOUR) }).where(eq(recoveryEmail.storeId, s.storeId));
    await scan();
    expect((await rowsOf(s.storeId)).filter((r) => r.orderId === o.id)).toMatchObject([{ status: "queued" }]);
  });

  test("11º do caso cartão na hora → sem linha; o Pix da mesma loja segue", async () => {
    const s = await shop();
    for (let i = 0; i < 10; i++) {
      const o = await seedOrder(s, { status: "pending", method: "card_asaas", createdAt: ago(3 * HOUR) });
      await t.ownerDb.insert(recoveryEmail).values(pastRow(s, { kind: "card", orderId: o.id }));
    }
    const card = await cardOrder(s, ago(31 * MIN));
    const pix = await pixOrder(s, ago(31 * MIN));
    await scan();
    const rows = await rowsOf(s.storeId);
    expect(rows.some((r) => r.orderId === card.id)).toBe(false);
    expect(rows.find((r) => r.orderId === pix.id)).toMatchObject({ status: "queued" });
  });

  test("caso desligado (recovery_pix = false) ou chave geral desligada → nada", async () => {
    const noPix = await shop({ pix: false });
    await pixOrder(noPix, ago(31 * MIN));
    const l = await lead(noPix, ago(61 * MIN));
    const off = await shop({ on: false });
    await pixOrder(off, ago(31 * MIN));
    await lead(off, ago(61 * MIN));
    await cardOrder(off, ago(31 * MIN));
    await scan();
    // Só o caso desligado para: o contato da mesma loja segue.
    expect(await rowsOf(noPix.storeId)).toMatchObject([{ kind: "lead", leadId: l.id, status: "queued" }]);
    expect(await rowsOf(off.storeId)).toHaveLength(0);
    expect(await sendJobsOf(off.storeId)).toHaveLength(0);
  });

  test("caso cartão ou contato desligado → nada nesse caso", async () => {
    const s = await shop({ card: false, lead: false });
    await cardOrder(s, ago(31 * MIN));
    await lead(s, ago(61 * MIN));
    await scan();
    expect(await rowsOf(s.storeId)).toHaveLength(0);
  });

  test("oferta desativada → contato e cartão não viram candidatos; o Pix segue", async () => {
    const s = await shop();
    await lead(s, ago(61 * MIN));
    await cardOrder(s, ago(31 * MIN));
    const pix = await pixOrder(s, ago(31 * MIN));
    await t.ownerDb.update(offer).set({ active: false }).where(eq(offer.id, s.offerId));
    await scan();
    expect((await rowsOf(s.storeId)).map((r) => [r.kind, r.orderId, r.status])).toEqual([["pix", pix.id, "queued"]]);
  });

  test("captura de contato desligada → caso lead não roda", async () => {
    const s = await shop({ capture: false });
    await lead(s, ago(61 * MIN));
    const o = await pixOrder(s, ago(31 * MIN));
    await scan();
    expect(await rowsOf(s.storeId)).toMatchObject([{ kind: "pix", orderId: o.id }]);
  });

  test("duas varreduras ao mesmo tempo → uma linha só por pedido (lock + único)", async () => {
    const s = await shop();
    const pix = await pixOrder(s, ago(31 * MIN));
    const card = await cardOrder(s, ago(31 * MIN));
    const l = await lead(s, ago(61 * MIN));
    await Promise.all([scan(), scan()]);
    const rows = await rowsOf(s.storeId);
    expect(rows.filter((r) => r.orderId === pix.id)).toHaveLength(1);
    expect(rows.filter((r) => r.orderId === card.id)).toHaveLength(1);
    expect(rows.filter((r) => r.leadId === l.id)).toHaveLength(1);
    expect(await sendJobsOf(s.storeId)).toHaveLength(3);
  });

  test("falha numa loja não para as outras; o job falha no fim", async () => {
    const bad = await shop();
    const good = await shop();
    const o = await pixOrder(good, ago(31 * MIN));
    await pixOrder(bad, ago(31 * MIN));
    const h = createRecoveryScanHandler(
      () => NOW,
      async (storeId) => {
        if (storeId === bad.storeId) throw new Error("falha simulada");
      },
    );
    await expect(h({} as never, new AbortController().signal)).rejects.toThrow("recovery_scan falhou em 1 loja(s)");
    expect(await rowsOf(good.storeId)).toMatchObject([{ orderId: o.id, status: "queued" }]);
    expect(await rowsOf(bad.storeId)).toHaveLength(0);
  });

  describe("log", () => {
    let out = "";
    let stdout: ReturnType<typeof spyOn>;
    beforeEach(() => {
      out = "";
      stdout = spyOn(process.stdout, "write").mockImplementation(((v: string) => ((out += String(v)), true)) as never);
    });
    afterEach(() => stdout.mockRestore());

    test("log da varredura não contém o e-mail nem o token", async () => {
      const s = await shop();
      const l = await lead(s, ago(61 * MIN));
      const pix = await pixOrder(s, ago(31 * MIN));
      const opted = await pixOrder(s, ago(40 * MIN));
      await t.ownerDb.insert(emailOptout).values({ storeId: s.storeId, emailHash: emailHash(opted.email), reason: "complaint" });
      await scan();
      stdout.mockRestore();
      const rows = await rowsOf(s.storeId);
      expect(rows).toHaveLength(3);
      const jobs = await sendJobsOf(s.storeId);
      expect(jobs).toHaveLength(2);
      // O log identifica o lembrete (id, loja, caso, motivo)...
      for (const r of rows) expect(out).toContain(r.id);
      expect(out).toContain("optout");
      // ...e nunca o e-mail, o hash do e-mail nem o token de descadastro.
      for (const email of [l.email, pix.email, opted.email]) {
        expect(out).not.toContain(email);
        expect(out).not.toContain(emailHash(email));
      }
      for (const j of jobs) expect(out).not.toContain((j.payload as { unsubToken: string }).unsubToken);
      for (const r of rows) expect(out).not.toContain(r.unsubHash);
    });
  });
});

// ---- Envio (`recovery_send`) -----------------------------------------------------------------------------------------

describe("recovery_send", () => {
  let outbox: SentMail[] = [];
  let sendError: Error | null = null;
  const fakeSmtp = () =>
    setMailTransportForTests(() => ({
      async verify() {
        return true;
      },
      async sendMail(m) {
        if (sendError) throw sendError;
        outbox.push(m);
        return {};
      },
      close() {},
    }));
  beforeAll(fakeSmtp);
  afterEach(() => {
    outbox = [];
    sendError = null;
    fakeSmtp();
  });
  afterAll(() => setMailTransportForTests());

  const SMTP = { host: "smtp.exemplo.com", port: 587, secure: false, user: "loja@exemplo.com", password: "senha-smtp-de-teste", from: "contato@loja.com" };
  const send = (j: Job, at: Date = NOW) => createRecoverySendHandler(() => at)(j, new AbortController().signal);

  /** Loja com a recuperação ligada e, salvo `smtp: false`, o SMTP (falso) configurado. */
  async function mailShop(f: Flags & { smtp?: boolean } = {}) {
    const s = await shop(f);
    if (f.smtp !== false) await runAction(saveSmtp, panelCall(s.storeId), SMTP);
    return s;
  }

  /** Roda a varredura e devolve a linha `queued`, o job `recovery_send` e o token em claro (a loja tem 1 candidato). */
  async function queued(storeId: string) {
    await scan();
    const rows = await rowsOf(storeId);
    const jobs = await sendJobsOf(storeId);
    expect(rows).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    return { row: rows[0]!, job: j, token: (j.payload as { unsubToken: string }).unsubToken };
  }

  const rowOf = async (id: string) => (await t.ownerDb.select().from(recoveryEmail).where(eq(recoveryEmail.id, id)))[0]!;
  const logsOf = (storeId: string) => t.ownerDb.select().from(emailLog).where(eq(emailLog.storeId, storeId));
  const baseOf = async (storeId: string) => {
    const [s] = await t.ownerDb.select({ domain: store.domain, slug: store.slug }).from(store).where(eq(store.id, storeId));
    return storeBaseUrl(s!);
  };
  const slugOf = async (offerId: string) => {
    const [o] = await t.ownerDb.select({ slug: offer.slug }).from(offer).where(eq(offer.id, offerId));
    return o!.slug;
  };

  test("lead → e-mail para o contato com link /c/<slug>?utm_source=recuperacao&utm_medium=email&utm_campaign=contato, List-Unsubscribe e email_log recovery com to_hash", async () => {
    const s = await mailShop();
    const l = await lead(s, ago(61 * MIN));
    const { row, job: j, token } = await queued(s.storeId);
    await send(j);

    expect(outbox).toHaveLength(1);
    const m = outbox[0]!;
    const base = await baseOf(s.storeId);
    const link = `${base}/c/${await slugOf(s.offerId)}?utm_source=recuperacao&utm_medium=email&utm_campaign=contato`;
    const unsub = `${base}/sair/${token}`;
    expect(m.to).toBe(l.email);
    expect(m.subject).toBe("Sua compra de Maná básica ficou pela metade");
    expect(m.text).toContain(`Concluir minha compra: ${link}`);
    expect(m.text).toContain("R$ 9,90");
    expect(m.text).toContain(unsub);
    expect(m.html).toContain(link.replaceAll("&", "&amp;"));
    expect(m.headers).toEqual({ "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    // Nunca o e-mail (nem o hash dele) no link.
    expect(link).not.toContain(l.email);
    expect(m.text).not.toContain(encodeURIComponent(l.email));

    const after = await rowOf(row.id);
    expect(after).toMatchObject({ status: "sent", jobId: j.id, skipReason: null });
    expect(after.sentAt?.getTime()).toBe(NOW.getTime());
    const logs = await logsOf(s.storeId);
    expect(logs.map((x) => [x.kind, x.status, x.toHash, x.orderId, x.jobId, x.provider])).toEqual([
      ["recovery", "sent", emailHash(l.email), null, j.id, "smtp"],
    ]);
  });

  test("pix → link /o/<publicId>", async () => {
    const s = await mailShop();
    const o = await pixOrder(s, ago(31 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await send(j);

    expect(outbox).toHaveLength(1);
    const m = outbox[0]!;
    const link = `${await baseOf(s.storeId)}/o/${o.publicId}`;
    expect(m.to).toBe(o.email);
    expect(m.subject).toBe("Seu Pix de R$ 9,90 ainda não foi pago");
    expect(m.text).toContain(`Ver o Pix: ${link}`);
    // A validade do Pix é o `expires_at` do pedido.
    expect(m.text).toContain(dateTimeSP(o.expiresAt!));
    expect((await rowOf(row.id)).status).toBe("sent");
    const logs = await logsOf(s.storeId);
    expect(logs.map((x) => [x.kind, x.status, x.toHash, x.orderId, x.jobId])).toEqual([["recovery", "sent", emailHash(o.email), o.id, j.id]]);
  });

  test("cartão → utm_campaign=cartao", async () => {
    const s = await mailShop();
    const o = await cardOrder(s, ago(31 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await send(j);

    expect(outbox).toHaveLength(1);
    const m = outbox[0]!;
    const link = `${await baseOf(s.storeId)}/c/${await slugOf(s.offerId)}?utm_source=recuperacao&utm_medium=email&utm_campaign=cartao`;
    expect(m.to).toBe(o.email);
    expect(m.subject).toBe("Sua compra de Maná básica não foi concluída");
    expect(m.text).toContain(`Tentar de novo: ${link}`);
    expect((await rowOf(row.id)).status).toBe("sent");
    const logs = await logsOf(s.storeId);
    expect(logs.map((x) => [x.kind, x.status, x.orderId])).toEqual([["recovery", "sent", o.id]]);
  });

  test("pago entre a varredura e o envio → skipped, nenhum e-mail", async () => {
    const s = await mailShop();
    const o = await pixOrder(s, ago(31 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb.update(orders).set({ status: "paid", paidAt: NOW }).where(eq(orders.id, o.id));
    await send(j);
    expect(outbox).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "pago", sentAt: null });
    expect(await logsOf(s.storeId)).toHaveLength(0);
  });

  test("cartão aprovado (tentativa approved) entre a varredura e o envio → skipped pago", async () => {
    const s = await mailShop();
    const o = await cardOrder(s, ago(31 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb
      .insert(cardAttempt)
      .values({ storeId: s.storeId, orderId: o.id, idempotencyKey: randomUUID(), status: "approved", resolvedAt: NOW });
    await send(j);
    expect(outbox).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "pago" });
  });

  test("Pix vencido entre a varredura e o envio → skipped pix_vencido", async () => {
    const s = await mailShop();
    const o = await pixOrder(s, ago(31 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb.update(orders).set({ expiresAt: ago(MIN) }).where(eq(orders.id, o.id));
    await send(j);
    expect(outbox).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "pix_vencido" });
  });

  test("pago em outro pedido entre a varredura e o envio → skipped, nenhum e-mail", async () => {
    // Cartão recusado; a pessoa abre outro pedido e paga com Pix: o pedido do cartão segue pending, sem tentativa approved.
    const s = await mailShop();
    const card = await cardOrder(s, ago(31 * MIN));
    const a = await queued(s.storeId);
    await seedOrder(s, { status: "paid", method: "pix_asaas", email: card.email });
    await send(a.job);
    expect(await rowOf(a.row.id)).toMatchObject({ status: "skipped", skipReason: "ja_comprou" });

    // Contato: comprou por outra sessão de checkout e o contato antigo ficou open.
    const s2 = await mailShop();
    const l = await lead(s2, ago(61 * MIN));
    const b = await queued(s2.storeId);
    await seedOrder(s2, { status: "paid", method: "pix_asaas", email: l.email });
    await send(b.job);
    expect(await rowOf(b.row.id)).toMatchObject({ status: "skipped", skipReason: "ja_comprou" });
    expect(outbox).toHaveLength(0);
    expect(await logsOf(s.storeId)).toHaveLength(0);
  });

  test("pedido mais novo da mesma oferta entre a varredura e o envio → skipped pedido_mais_novo", async () => {
    for (const make of [(s: PanelStore) => cardOrder(s, ago(31 * MIN)), (s: PanelStore) => pixOrder(s, ago(31 * MIN))]) {
      const s = await mailShop();
      const o = await make(s);
      const { row, job: j } = await queued(s.storeId);
      await seedOrder(s, { status: "pending", method: "pix_asaas", email: o.email });
      await send(j);
      expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "pedido_mais_novo" });
    }
    expect(outbox).toHaveLength(0);
  });

  test("oferta desativada depois da varredura → contato e cartão skipped oferta_inativa, nenhum e-mail", async () => {
    for (const make of [(s: PanelStore) => lead(s, ago(61 * MIN)), (s: PanelStore) => cardOrder(s, ago(31 * MIN))]) {
      const s = await mailShop();
      await make(s);
      const { row, job: j } = await queued(s.storeId);
      await t.ownerDb.update(offer).set({ active: false }).where(eq(offer.id, s.offerId));
      await send(j);
      expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "oferta_inativa" });
    }
    expect(outbox).toHaveLength(0);
  });

  test("Pix com a oferta desativada depois da varredura → sai (o /o/ funciona sem a oferta ativa)", async () => {
    const s = await mailShop();
    await pixOrder(s, ago(31 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb.update(offer).set({ active: false }).where(eq(offer.id, s.offerId));
    await send(j);
    expect(outbox).toHaveLength(1);
    expect((await rowOf(row.id)).status).toBe("sent");
  });

  test("descadastrou com o job na fila → skipped optout", async () => {
    const s = await mailShop();
    const l = await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb.insert(emailOptout).values({ storeId: s.storeId, emailHash: emailHash(l.email), reason: "unsubscribe" });
    await send(j);
    expect(outbox).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "optout" });
  });

  test("contato convertido ou apagado → skipped", async () => {
    const s = await mailShop();
    const l = await lead(s, ago(61 * MIN));
    const a = await queued(s.storeId);
    await t.ownerDb.update(checkoutLead).set({ status: "converted", email: null, phone: null }).where(eq(checkoutLead.id, l.id));
    await send(a.job);
    expect(await rowOf(a.row.id)).toMatchObject({ status: "skipped", skipReason: "contato_encerrado" });

    const s2 = await mailShop();
    const l2 = await lead(s2, ago(61 * MIN));
    const b = await queued(s2.storeId);
    await t.ownerDb.delete(checkoutLead).where(eq(checkoutLead.id, l2.id));
    await send(b.job);
    expect(await rowOf(b.row.id)).toMatchObject({ status: "skipped", skipReason: "contato_apagado", leadId: null });
    expect(outbox).toHaveLength(0);
  });

  test("contato trocou de e-mail na mesma chave → skipped email_mudou", async () => {
    const s = await mailShop();
    const l = await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    const other = newEmail();
    await t.ownerDb.update(checkoutLead).set({ email: other, emailHash: emailHash(other) }).where(eq(checkoutLead.id, l.id));
    await send(j);
    expect(outbox).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "email_mudou" });
  });

  test("caso ou chave geral desligados depois da varredura → skipped desligado", async () => {
    for (const set of [{ recoveryOn: false }, { recoveryPix: false }]) {
      const s = await mailShop();
      await pixOrder(s, ago(31 * MIN));
      const { row, job: j } = await queued(s.storeId);
      await t.ownerDb.update(store).set(set).where(eq(store.id, s.storeId));
      await send(j);
      expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "desligado" });
    }
    // Caso lead: a captura de contato desligada também desliga o lembrete.
    const s = await mailShop();
    await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb.update(store).set({ leadCapture: false }).where(eq(store.id, s.storeId));
    await send(j);
    expect(await rowOf(row.id)).toMatchObject({ status: "skipped", skipReason: "desligado" });
    expect(outbox).toHaveLength(0);
  });

  test("token do payload que não bate com o unsub_hash (ou fora do base64url) → failed sem enviar", async () => {
    for (const bad of [randomUUID().replaceAll("-", ""), "a b<c>"]) {
      const s = await mailShop();
      await lead(s, ago(61 * MIN));
      const { row, job: j } = await queued(s.storeId);
      await send({ ...j, payload: { recoveryId: row.id, unsubToken: bad } });
      expect(await rowOf(row.id)).toMatchObject({ status: "failed" });
    }
    expect(outbox).toHaveLength(0);
  });

  test("segundo recovery_send da mesma linha → não envia de novo", async () => {
    const s = await mailShop();
    await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await send(j);
    // O mesmo job de novo (at-least-once) e um segundo job com o mesmo payload.
    await send(j);
    await send({ ...j, id: randomUUID() });
    expect(outbox).toHaveLength(1);
    expect(await rowOf(row.id)).toMatchObject({ status: "sent", jobId: j.id });
    expect(await logsOf(s.storeId)).toHaveLength(1);
  });

  test("linha em sending por outro job → não envia; o mesmo job (worker caiu no meio) reivindica de novo", async () => {
    const s = await mailShop();
    await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb.update(recoveryEmail).set({ status: "sending", jobId: randomUUID() }).where(eq(recoveryEmail.id, row.id));
    await send(j);
    expect(outbox).toHaveLength(0);
    await t.ownerDb.update(recoveryEmail).set({ jobId: j.id }).where(eq(recoveryEmail.id, row.id));
    await send(j);
    expect(outbox).toHaveLength(1);
    expect((await rowOf(row.id)).status).toBe("sent");
  });

  test("provedor não configurado → failed sem relançar", async () => {
    const s = await mailShop({ smtp: false });
    const l = await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await send(j); // não lança
    expect(outbox).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ status: "failed", sentAt: null });
    const logs = await logsOf(s.storeId);
    expect(logs.map((x) => [x.kind, x.status, x.toHash, x.jobId])).toEqual([["recovery", "failed", emailHash(l.email), j.id]]);
  });

  test("erro de rede dentro de 2 h → relança e linha queued", async () => {
    const s = await mailShop();
    await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    sendError = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
    await expect(send(j)).rejects.toThrow();
    expect(await rowOf(row.id)).toMatchObject({ status: "queued", sentAt: null });
    expect((await logsOf(s.storeId)).map((x) => [x.kind, x.status])).toEqual([["recovery", "failed"]]);
    // A fila tenta de novo e agora sai.
    sendError = null;
    await send(j);
    expect(outbox).toHaveLength(1);
    expect((await rowOf(row.id)).status).toBe("sent");
  });

  test("erro de rede depois de 2 h → failed", async () => {
    const s = await mailShop();
    await lead(s, ago(61 * MIN));
    const { row, job: j } = await queued(s.storeId);
    await t.ownerDb.update(recoveryEmail).set({ dueAt: ago(121 * MIN) }).where(eq(recoveryEmail.id, row.id));
    sendError = Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" });
    await send(j); // não lança
    expect(await rowOf(row.id)).toMatchObject({ status: "failed", sentAt: null });
    expect((await logsOf(s.storeId)).map((x) => [x.kind, x.status])).toEqual([["recovery", "failed"]]);
  });

  describe("pelo Resend", () => {
    // Montada em tempo de execução: nenhum literal com formato de chave no código.
    const apiKey = ["re", "teste", "recuperacao"].join("_");
    let status = 200;
    let calls = 0;
    beforeEach(() => {
      status = 200;
      calls = 0;
      setResendFetchForTests((async () => {
        calls++;
        return status === 200
          ? new Response(JSON.stringify({ id: `msg_${calls}` }), { status: 200 })
          : new Response(JSON.stringify({ message: "erro" }), { status });
      }) as unknown as typeof fetch);
    });
    afterEach(() => setResendFetchForTests());

    async function resendShop() {
      const s = await mailShop({ smtp: false });
      await runAction(saveResend, panelCall(s.storeId), { fromEmail: "vendas@loja.com", apiKey });
      await runAction(setEmailProvider, panelCall(s.storeId), { provider: "resend" });
      await lead(s, ago(61 * MIN));
      return { s, ...(await queued(s.storeId)) };
    }

    test("503 → relança e linha queued; a nova tentativa sai com o message id", async () => {
      const { s, row, job: j } = await resendShop();
      status = 503;
      await expect(send(j)).rejects.toThrow();
      expect(await rowOf(row.id)).toMatchObject({ status: "queued", sentAt: null });
      status = 200;
      await send(j);
      expect(await rowOf(row.id)).toMatchObject({ status: "sent" });
      const logs = await logsOf(s.storeId);
      expect(logs.map((x) => [x.status, x.provider]).sort()).toEqual([
        ["failed", "resend"],
        ["sent", "resend"],
      ]);
      expect(logs.find((x) => x.status === "sent")!.providerMessageId).toBe("msg_2");
    });

    test("429 e falha de rede (status 0) também são temporários; depois de 2 h → failed", async () => {
      const { row, job: j } = await resendShop();
      status = 429;
      await expect(send(j)).rejects.toThrow();
      expect((await rowOf(row.id)).status).toBe("queued");
      setResendFetchForTests((async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch);
      await expect(send(j)).rejects.toThrow();
      expect((await rowOf(row.id)).status).toBe("queued");
      await t.ownerDb.update(recoveryEmail).set({ dueAt: ago(121 * MIN) }).where(eq(recoveryEmail.id, row.id));
      await send(j); // não lança
      expect((await rowOf(row.id)).status).toBe("failed");
    });

    test("422 → failed sem relançar", async () => {
      const { s, row, job: j } = await resendShop();
      status = 422;
      await send(j); // não lança
      expect(await rowOf(row.id)).toMatchObject({ status: "failed", sentAt: null });
      expect((await logsOf(s.storeId)).map((x) => [x.status, x.provider])).toEqual([["failed", "resend"]]);
    });
  });

  describe("log", () => {
    let out = "";
    let stdout: ReturnType<typeof spyOn>;
    beforeEach(() => {
      out = "";
      stdout = spyOn(process.stdout, "write").mockImplementation(((v: string) => ((out += String(v)), true)) as never);
    });
    afterEach(() => stdout.mockRestore());

    test("nem log nem audit_log contêm o e-mail ou o token", async () => {
      const s = await mailShop();
      const l = await lead(s, ago(61 * MIN));
      const sent = await queued(s.storeId);
      await send(sent.job);

      const s2 = await mailShop();
      const p = await pixOrder(s2, ago(31 * MIN));
      const skipped = await queued(s2.storeId);
      await t.ownerDb.insert(emailOptout).values({ storeId: s2.storeId, emailHash: emailHash(p.email), reason: "complaint" });
      await send(skipped.job);

      const s3 = await mailShop();
      const l3 = await lead(s3, ago(61 * MIN));
      const failed = await queued(s3.storeId);
      sendError = Object.assign(new Error(`Can't send mail - all recipients were rejected: 550 <${l3.email}>`), { code: "EENVELOPE" });
      const err = await send(failed.job).catch((e: unknown) => e);
      stdout.mockRestore();
      expect(err).toBeInstanceOf(Error);

      expect(outbox).toHaveLength(1);
      expect((await rowOf(skipped.row.id)).skipReason).toBe("optout");
      // O log identifica o lembrete...
      for (const x of [sent, skipped, failed]) expect(out).toContain(x.row.id);
      // ...e nunca o e-mail, o token nem a URL de descadastro.
      const audits = JSON.stringify(await t.ownerDb.select().from(auditLog).where(inArray(auditLog.storeId, [s.storeId, s2.storeId, s3.storeId])));
      for (const email of [l.email, p.email, l3.email]) {
        expect(out).not.toContain(email);
        expect(audits).not.toContain(email);
      }
      for (const x of [sent, skipped, failed]) {
        expect(out).not.toContain(x.token);
        expect(audits).not.toContain(x.token);
        expect(out).not.toContain("/sair/");
      }
      // O erro relançado (vai ao log da fila e ao last_error do job) também não traz o e-mail.
      expect((err as Error).message).not.toContain(l3.email);
      // email_log guarda só o hash.
      expect(JSON.stringify(await logsOf(s3.storeId))).not.toContain(l3.email);
    });
  });
});
