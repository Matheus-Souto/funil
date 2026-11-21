// Tabelas da recuperação de vendas por e-mail (`recovery_email` e `email_optout`): isolamento por loja (RLS) e
// restrições do banco (kind x order_id, um lembrete por pedido e tipo). Varredura `recovery_scan`: candidatos dos três
// casos, dedupe, tetos e proteção do cartão (relógio injetado, datas mudadas no banco).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { cardAttempt, checkoutLead, emailOptout, job, orders, recoveryEmail, store } from "@/lib/db/schema";
import { cardBreakerKey, cardDeclineIpKey } from "@/lib/payments/card-keys";
import { recordEvent } from "@/lib/payments/ratelimit";
import { createRecoveryScanHandler } from "@/lib/recovery/scan";
import { createTestDb, seedStore, type TestDb } from "./db";
import { seedOrder, seedPanelStore } from "./panel-helpers";

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

  test("disjuntor de 3 h atrás não conta (janela de 2 h)", async () => {
    const s = await shop();
    await recordEvent(cardBreakerKey(s.storeId), ago(3 * HOUR));
    const o = await cardOrder(s, ago(31 * MIN));
    await scan();
    expect(await rowsOf(s.storeId)).toMatchObject([{ orderId: o.id, status: "queued" }]);
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
