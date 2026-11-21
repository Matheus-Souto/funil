// Tabelas da recuperação de vendas por e-mail (`recovery_email` e `email_optout`): isolamento por loja (RLS) e
// restrições do banco (kind x order_id, um lembrete por pedido e tipo).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { withStore } from "@/lib/db/client";
import { checkoutLead, emailOptout, recoveryEmail } from "@/lib/db/schema";
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
    await t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead", { leadId }));
    expect(await pgError(() => t.ownerDb.insert(recoveryEmail).values(row(s.storeId, s.offerId, "lead", { leadId })))).toEqual({
      code: UNIQUE,
      constraint: "recovery_email_lead_uniq",
    });
    await t.ownerDb.delete(checkoutLead);
    const rows = await t.ownerDb.select({ leadId: recoveryEmail.leadId, orderId: recoveryEmail.orderId }).from(recoveryEmail);
    expect(rows.filter((r) => r.leadId === null && r.orderId === null).length).toBeGreaterThanOrEqual(1);
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
