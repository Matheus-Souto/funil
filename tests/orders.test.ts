import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import fc from "fast-check";
import { ActionError, runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { withStore } from "@/lib/db/client";
import { appEventId } from "@/lib/apps/webhook";
import { appWebhookDelivery, emailLog, integration, job, orderItem, orders } from "@/lib/db/schema";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { createOrder } from "@/lib/orders/create";
import { getOrderDetail } from "@/lib/orders/panel";
import { ALLOWED, transitionOrder, type OrderStatus } from "@/lib/orders/state";
import { HEAVY_TEST_MS, createTestDb, seedProduct, seedStore, type TestDb } from "./db";
import { seedAppOffer, seedAppOrder } from "./apps-helpers";
import { panelCall, seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const ctxOf = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "public" }, origin: "public", tx });

async function seedOffer(storeId: string, withBump = true) {
  const call = { storeId, actor: owner, origin: "panel" as const };
  const main = await seedProduct(storeId, "Principal");
  const bump = await seedProduct(storeId, "Bump");
  return runAction(createOffer, call, {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Oferta",
    productIds: [main.id],
    priceCents: 990,
    methods: ["pix", "card"],
    pixMode: "manual",
    ...(withBump ? { bump: { productIds: [bump.id], priceCents: 1710 } } : {}),
  });
}

const orderInput = (offerId: string, over: Record<string, unknown> = {}) => ({
  offerId,
  withBump: false,
  method: "pix_manual" as const,
  customer: { name: "Ana", email: "Ana@Example.com", phone: "11999999999" },
  touch: { first: { utm_source: "fb" }, last: null },
  clientIp: "127.0.0.1",
  userAgent: "bun-test",
  ...over,
});

async function newOrder(storeId: string, offerId: string, over: Record<string, unknown> = {}) {
  return withStore(storeId, (tx) => createOrder(ctxOf(storeId, tx), orderInput(offerId, over)));
}
const transition = (storeId: string, orderId: string, to: OrderStatus) =>
  withStore(storeId, (tx) => transitionOrder(ctxOf(storeId, tx), orderId, to, "teste"));
const jobsOf = (orderId: string, type: string) =>
  t.ownerDb.select().from(job).where(eq(job.type, type)).then((rows) => rows.filter((j) => (j.payload as { orderId?: string }).orderId === orderId));

describe("createOrder", () => {
  test("preço vem do banco, mesmo se o cliente mandar outro", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id, { priceCents: 1, totalCents: 1, subtotalCents: 1 });
    expect(o.subtotalCents).toBe(990);
    expect(o.totalCents).toBe(990);
    expect(o.hasBump).toBe(false);
    expect(o.publicId.length).toBeGreaterThanOrEqual(20);
  });

  test("bump soma 990 + 1710 = 2700 e cria 2 itens", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id, { withBump: true });
    expect(o.totalCents).toBe(2700);
    const items = await withStore(storeId, (tx) => tx.select().from(orderItem).where(eq(orderItem.orderId, o.id)));
    expect(items.map((i) => [i.kind, i.priceCents]).sort()).toEqual([["bump", 1710], ["main", 990]]);
  });

  test("bump pedido sem bump na oferta é recusado (conflict); método fora da oferta também", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId, false);
    const e1 = await newOrder(storeId, offer.id, { withBump: true }).catch((e) => e);
    // Ruling R4: bump marcado e indisponível -> conflict com a mensagem para o comprador atualizar a página.
    expect([(e1 as ActionError).code, (e1 as ActionError).message]).toEqual(["conflict", "O acréscimo não está mais disponível. Atualize a página."]);
    const e2 = await newOrder(storeId, offer.id, { method: "pix_asaas" }).catch((e) => e);
    expect((e2 as ActionError).code).toBe("invalid_input");
  });

  test("upsert de customer por e-mail (normalizado)", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const a = await newOrder(storeId, offer.id);
    const b = await newOrder(storeId, offer.id, { customer: { name: "Ana Maria", email: " ana@example.com ", phone: "11888888888" } });
    expect(b.customerId).toBe(a.customerId);
  });
});

describe("transitionOrder", () => {
  test("pending -> paid em paralelo: um changed e um único deliver_order", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id);
    const rs = await Promise.all([transition(storeId, o.id, "paid"), transition(storeId, o.id, "paid")]);
    expect(rs.filter((r) => r.changed)).toHaveLength(1);
    expect(await jobsOf(o.id, "deliver_order")).toHaveLength(1);
    expect(await jobsOf(o.id, "notify_seller")).toHaveLength(1);
    const meta = await jobsOf(o.id, "meta_event");
    expect(meta).toHaveLength(1);
    expect(meta[0]!.payload).toEqual({ event: "Purchase", orderId: o.id });
    const [row] = await withStore(storeId, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
    expect(row!.status).toBe("paid");
    expect(row!.paidAt).not.toBeNull();
  });

  test("expired -> paid é conflict e não enfileira nada", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id);
    await transition(storeId, o.id, "expired");
    const e = await transition(storeId, o.id, "paid").catch((x) => x);
    expect((e as ActionError).code).toBe("conflict");
    expect(await jobsOf(o.id, "deliver_order")).toHaveLength(0);
  });

  test("pedido inexistente é not_found", async () => {
    const { storeId } = await seedStore();
    const e = await transition(storeId, crypto.randomUUID(), "paid").catch((x) => x);
    expect((e as ActionError).code).toBe("not_found");
  });

  test("refunded e disputed enfileiram revoke_downloads", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const a = await newOrder(storeId, offer.id);
    await transition(storeId, a.id, "paid");
    expect((await transition(storeId, a.id, "refunded")).changed).toBe(true);
    expect(await jobsOf(a.id, "revoke_downloads")).toHaveLength(1);
    expect((await transition(storeId, a.id, "refunded")).changed).toBe(false);
    expect(await jobsOf(a.id, "revoke_downloads")).toHaveLength(1);

    const b = await newOrder(storeId, offer.id);
    await transition(storeId, b.id, "paid");
    await transition(storeId, b.id, "disputed");
    expect(await jobsOf(b.id, "revoke_downloads")).toHaveLength(1);
  });

  test("disputed -> paid só enfileira restore_downloads (não é venda nova)", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id);
    await transition(storeId, o.id, "paid");
    await transition(storeId, o.id, "disputed");
    expect((await transition(storeId, o.id, "paid")).changed).toBe(true);
    expect(await jobsOf(o.id, "deliver_order")).toHaveLength(1);
    expect(await jobsOf(o.id, "meta_event")).toHaveLength(1);
    expect(await jobsOf(o.id, "notify_seller")).toHaveLength(1);
    expect(await jobsOf(o.id, "restore_downloads")).toHaveLength(1);
  });

  test("falha na transação desfaz o efeito (jobs na mesma transação)", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const o = await newOrder(storeId, offer.id);
    await withStore(storeId, async (tx) => {
      await transitionOrder(ctxOf(storeId, tx), o.id, "paid", "x");
      throw new Error("rollback");
    }).catch(() => undefined);
    expect(await jobsOf(o.id, "deliver_order")).toHaveLength(0);
    const [row] = await withStore(storeId, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
    expect(row!.status).toBe("pending");
  });

  test("propriedade: qualquer sequência termina em estado alcançável e efeitos saem uma vez por transição real", async () => {
    const { storeId } = await seedStore();
    const offer = await seedOffer(storeId);
    const statuses: OrderStatus[] = ["pending", "paid", "refunded", "disputed", "expired", "declined"];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...statuses), { maxLength: 8 }), async (seq) => {
        const o = await newOrder(storeId, offer.id);
        let model: OrderStatus = "pending";
        let paid = 0;
        let revoke = 0;
        let restore = 0;
        for (const to of seq) {
          const r = await transition(storeId, o.id, to).catch((e: unknown) => e);
          if (to === model) {
            expect(r).toEqual({ changed: false });
          } else if (ALLOWED[model].includes(to)) {
            expect(r).toEqual({ changed: true });
            const prev = model;
            model = to;
            if (to === "paid") {
              if (prev === "disputed") restore++;
              else paid++;
            }
            if (to === "refunded" || to === "disputed") revoke++;
          } else {
            expect((r as ActionError).code).toBe("conflict");
          }
        }
        const [row] = await withStore(storeId, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
        expect(row!.status).toBe(model);
        expect(await jobsOf(o.id, "deliver_order")).toHaveLength(paid);
        expect(await jobsOf(o.id, "meta_event")).toHaveLength(paid);
        expect(await jobsOf(o.id, "notify_seller")).toHaveLength(paid);
        expect(await jobsOf(o.id, "revoke_downloads")).toHaveLength(revoke);
        expect(await jobsOf(o.id, "restore_downloads")).toHaveLength(restore);
      }),
      { numRuns: 25 },
    );
  }, HEAVY_TEST_MS);

  test("propriedade (pedido de app): cada transição real gera um aviso ao app, com id próprio, e nunca entrega nem revogação de link", async () => {
    const { storeId } = await seedStore();
    const offer = await seedAppOffer(storeId);
    const statuses: OrderStatus[] = ["pending", "paid", "refunded", "disputed", "expired", "declined"];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...statuses), { maxLength: 8 }), async (seq) => {
        const o = await seedAppOrder(storeId, offer.id);
        let model: OrderStatus = "pending";
        const expected: string[] = [];
        const seen: Record<string, number> = {};
        const notice = (type: "pagamento.confirmado" | "pagamento.reembolsado" | "pagamento.contestado" | "pagamento.restabelecido") => {
          expected.push(appEventId(o.id, type, seen[type] ?? 0));
          seen[type] = (seen[type] ?? 0) + 1;
        };
        let paid = 0;
        for (const to of seq) {
          const r = await transition(storeId, o.id, to).catch((e: unknown) => e);
          if (to === model) {
            expect(r).toEqual({ changed: false });
          } else if (ALLOWED[model].includes(to)) {
            expect(r).toEqual({ changed: true });
            const prev = model;
            model = to;
            if (to === "paid" && prev === "disputed") notice("pagamento.restabelecido");
            else if (to === "paid") {
              paid++;
              notice("pagamento.confirmado");
            } else if (to === "refunded") notice("pagamento.reembolsado");
            else if (to === "disputed") notice("pagamento.contestado");
          } else {
            expect((r as ActionError).code).toBe("conflict");
          }
        }
        const deliveries = await t.ownerDb.select().from(appWebhookDelivery).where(eq(appWebhookDelivery.orderId, o.id));
        expect(deliveries.map((d) => d.eventId).sort()).toEqual([...expected].sort());
        expect(new Set(expected).size).toBe(expected.length);
        const notices = (await t.ownerDb.select().from(job).where(eq(job.type, "notify_app"))).map((j) => (j.payload as { deliveryId?: string }).deliveryId);
        for (const d of deliveries) expect(notices.filter((id) => id === d.id)).toHaveLength(1);
        // Meta e aviso de venda como em qualquer pedido; nada do que é do PDF.
        expect(await jobsOf(o.id, "meta_event")).toHaveLength(paid);
        expect(await jobsOf(o.id, "notify_seller")).toHaveLength(paid);
        for (const type of ["deliver_order", "revoke_downloads", "restore_downloads"]) expect([type, (await jobsOf(o.id, type)).length]).toEqual([type, 0]);
      }),
      { numRuns: 25 },
    );
  }, HEAVY_TEST_MS);
});

describe("integrations", () => {
  test("segredo é selado no banco e volta aberto", async () => {
    const { storeId } = await seedStore();
    await withStore(storeId, (tx) => saveIntegration(tx, storeId, "asaas", { sandbox: true }, "chave-super-secreta"));
    const [raw] = await withStore(storeId, (tx) => tx.select().from(integration).where(eq(integration.storeId, storeId)));
    expect(raw!.secret).not.toBeNull();
    expect(raw!.secret).not.toContain("chave-super-secreta");
    expect(JSON.stringify(raw!.config)).not.toContain("chave-super-secreta");
    const got = await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"));
    expect(got).toEqual({ config: { sandbox: true }, secret: "chave-super-secreta" });
  });

  test("regravar sem segredo mantém o anterior; ausente devolve null; isolamento por loja", async () => {
    const a = await seedStore();
    const b = await seedStore();
    await withStore(a.storeId, (tx) => saveIntegration(tx, a.storeId, "smtp", { host: "h" }, "s1"));
    await withStore(a.storeId, (tx) => saveIntegration(tx, a.storeId, "smtp", { host: "h2" }));
    expect(await withStore(a.storeId, (tx) => getIntegration(tx, a.storeId, "smtp"))).toEqual({ config: { host: "h2" }, secret: "s1" });
    expect(await withStore(b.storeId, (tx) => getIntegration(tx, b.storeId, "smtp"))).toBeNull();
    expect(await withStore(a.storeId, (tx) => getIntegration(tx, a.storeId, "meta"))).toBeNull();
  });
});

describe("linha do tempo do pedido", () => {
  test("linha do tempo mostra o lembrete enviado", async () => {
    const p = await seedPanelStore();
    const email = "lembrete.timeline@exemplo.com";
    const order = await seedOrder(p, { status: "pending", email });
    const toHash = createHash("sha256").update(email).digest("hex");
    const sentAt = new Date(Date.now() - 2 * 3_600_000);
    const failedAt = new Date(Date.now() - 3_600_000);
    await t.ownerDb.insert(emailLog).values([
      { storeId: p.storeId, orderId: order.id, toHash, kind: "recovery", status: "sent", provider: "smtp", at: sentAt },
      { storeId: p.storeId, orderId: order.id, toHash, kind: "recovery", status: "failed", error: `recusado para ${email}`, at: failedAt },
    ]);
    const d = await runAction(getOrderDetail, panelCall(p.storeId), { id: order.id });
    const reminders = d.timeline.filter((e) => e.label.startsWith("Lembrete"));
    expect(reminders.map((e) => [e.at, e.kind, e.label])).toEqual([
      [failedAt, "email.failed", "Lembrete por e-mail não enviado"],
      [sentAt, "email.sent", "Lembrete de pagamento por e-mail"],
    ]);
    // nunca o destinatário (nem o erro cru do provedor, que pode ecoá-lo)
    expect(JSON.stringify(d.timeline)).not.toContain(email);
    expect(JSON.stringify(d.timeline)).not.toContain(toHash);
  });
});
