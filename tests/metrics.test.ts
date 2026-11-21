import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { ActionError, runAction, type Action } from "@/lib/actions/core";
import { checkoutLead } from "@/lib/db/schema";
import { metricsBreakdown, metricsSummary, periodRange } from "@/lib/metrics";
import { createTestDb, type TestDb } from "./db";
import { panelCall, seedOrder, seedPanelStore, seedViews } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const HOUR = 3_600_000;
const window = () => ({ from: new Date(Date.now() - 24 * HOUR), to: new Date(Date.now() + HOUR) });

describe("metrics.summary", () => {
  test("cenário do brief: 2 pagos de 990 via ig, 1 pago de 2700 com ref=joao, 1 reembolsado, 1 pendente", async () => {
    const s = await seedPanelStore();
    await seedOrder(s, { status: "paid", totalCents: 990, utmSource: "ig" });
    await seedOrder(s, { status: "paid", totalCents: 990, utmSource: "ig", method: "pix_manual" });
    await seedOrder(s, { status: "paid", totalCents: 2700, ref: "joao", hasBump: true, method: "card_asaas" });
    await seedOrder(s, { status: "refunded", totalCents: 990, utmSource: "ig" });
    await seedOrder(s, { status: "pending", totalCents: 990 });
    await seedViews(s, 7);

    const m = await runAction(metricsSummary, panelCall(s.storeId), window());
    expect(m.paid).toBe(3);
    expect(m.revenueCents).toBe(4680);
    expect(m.orders).toBe(5);
    expect(m.views).toBe(7);
    expect(m.bySource).toEqual([
      { source: "direto", paid: 1, revenueCents: 2700 },
      { source: "ig", paid: 2, revenueCents: 1980 },
    ]);
    expect(m.byRef).toEqual([{ ref: "joao", paid: 1, revenueCents: 2700 }]);
    expect(m.byMethod).toEqual({
      pix_asaas: { orders: 3, paid: 1, revenueCents: 990 },
      pix_manual: { orders: 1, paid: 1, revenueCents: 990 },
      card_asaas: { orders: 1, paid: 1, revenueCents: 2700 },
    });
  });

  test("período: pago fora do intervalo não conta; pedido criado antes mas pago dentro conta na receita", async () => {
    const s = await seedPanelStore();
    const old = new Date(Date.now() - 10 * 24 * HOUR);
    await seedOrder(s, { status: "paid", totalCents: 990, paidAt: old, createdAt: old });
    await seedOrder(s, { status: "paid", totalCents: 2700, createdAt: old, paidAt: new Date() });
    await seedViews(s, 3, old);
    const m = await runAction(metricsSummary, panelCall(s.storeId), window());
    expect(m).toMatchObject({ views: 0, orders: 0, paid: 1, revenueCents: 2700 });
  });

  test("loja vazia: tudo zero, métodos presentes", async () => {
    const s = await seedPanelStore();
    const m = await runAction(metricsSummary, panelCall(s.storeId), window());
    expect(m).toEqual({
      views: 0,
      orders: 0,
      paid: 0,
      revenueCents: 0,
      leads: 0,
      leadsConverted: 0,
      byMethod: {
        pix_manual: { orders: 0, paid: 0, revenueCents: 0 },
        pix_asaas: { orders: 0, paid: 0, revenueCents: 0 },
        card_asaas: { orders: 0, paid: 0, revenueCents: 0 },
      },
      bySource: [],
      byRef: [],
    });
  });

  test("leads e leadsConverted contam no período", async () => {
    const s = await seedPanelStore();
    const outra = await seedPanelStore();
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const lead = (p: { storeId: string; offerId: string }, over: Partial<typeof checkoutLead.$inferInsert> = {}) => {
      const email = `contato-${randomUUID()}@example.com`;
      return { storeId: p.storeId, offerId: p.offerId, keyHash: sha(randomUUID()), email, emailHash: sha(email), expiresAt: new Date(Date.now() + 30 * 24 * HOUR), ...over };
    };
    const converted = { email: null, phone: null, status: "converted" };
    const old = new Date(Date.now() - 10 * 24 * HOUR);
    await t.ownerDb.insert(checkoutLead).values([
      lead(s),
      lead(s, { status: "contacted" }),
      lead(s, converted),
      lead(s, { ...converted, createdAt: old }),
      lead(s, { createdAt: old }),
      lead(outra, converted),
    ]);
    expect(await runAction(metricsSummary, panelCall(s.storeId), window())).toMatchObject({ leads: 3, leadsConverted: 1 });
    expect(await runAction(metricsSummary, panelCall(outra.storeId), window())).toMatchObject({ leads: 1, leadsConverted: 1 });
    // o período é por created_at: a janela de 30 dias pega os cinco da loja
    const wide = { from: new Date(Date.now() - 30 * 24 * HOUR), to: new Date(Date.now() + HOUR) };
    expect(await runAction(metricsSummary, panelCall(s.storeId), wide)).toMatchObject({ leads: 5, leadsConverted: 2 });
  });

  test("isolamento: não soma pedidos de outra loja", async () => {
    const a = await seedPanelStore("A");
    const b = await seedPanelStore("B");
    await seedOrder(b, { status: "paid", totalCents: 5000 });
    const m = await runAction(metricsSummary, panelCall(a.storeId), window());
    expect(m.revenueCents).toBe(0);
  });

  test("permissão metrics.read: support recebe forbidden; traffic e admin leem", async () => {
    const s = await seedPanelStore();
    const err = await runAction(metricsSummary, panelCall(s.storeId, "support"), window()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).code).toBe("forbidden");
    await runAction(metricsSummary, panelCall(s.storeId, "traffic"), window());
    await runAction(metricsSummary, panelCall(s.storeId, "admin"), window());
  });

  test("intervalo invertido é recusado", async () => {
    const s = await seedPanelStore();
    const err = await runAction(metricsSummary, panelCall(s.storeId), { from: new Date(), to: new Date(Date.now() - HOUR) }).catch((e: unknown) => e);
    expect((err as ActionError).code).toBe("invalid_input");
  });
});

describe("metrics.breakdown", () => {
  test("receita por dia (São Paulo), pagos com bump e números por oferta", async () => {
    const s = await seedPanelStore();
    await seedOrder(s, { status: "paid", totalCents: 2700, hasBump: true });
    await seedOrder(s, { status: "paid", totalCents: 990 });
    await seedOrder(s, { status: "pending", totalCents: 990 });
    await seedViews(s, 4);
    // O fim do período é exclusivo (`paid_at < to`) e o Postgres grava microssegundos, mas `Date` só tem milissegundos:
    // um pedido pago no mesmo milissegundo do "agora" (ex.: 01:13:52.123456 contra to = 01:13:52.123) ficava de fora.
    // +1 ms garante que tudo o que foi gravado antes desta linha cai dentro do período.
    const range = periodRange("7d", new Date(Date.now() + 1));
    const b = await runAction(metricsBreakdown, panelCall(s.storeId), range);
    expect(b.byDay).toHaveLength(7);
    expect(b.byDay.at(-1)!.revenueCents).toBe(3690);
    expect(b.byDay.slice(0, 6).every((d) => d.revenueCents === 0)).toBe(true);
    expect(b.bumpPaid).toBe(1);
    expect(b.byOffer).toEqual([{ offerId: s.offerId, views: 4, orders: 3, paid: 2, bumpPaid: 1, revenueCents: 3690 }]);
  });
});

describe("teto de período para tokens MCP", () => {
  const DAY = 24 * HOUR;
  const tokenCall = (storeId: string) => ({ storeId, actor: { kind: "token" as const, tokenId: randomUUID(), role: "reader" as const }, origin: "mcp" as const });
  const days = (n: number) => {
    const to = new Date();
    return { from: new Date(to.getTime() - n * DAY), to };
  };
  const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? `${e.code}: ${e.message}` : String(e)));

  test("token: 401 dias → invalid_input; 400 dias → ok (summary e breakdown)", async () => {
    const s = await seedPanelStore();
    for (const action of [metricsSummary, metricsBreakdown] as Action<unknown, unknown>[]) {
      expect([action.name, await codeOf(runAction(action, tokenCall(s.storeId), days(401)))]).toEqual([
        action.name,
        "invalid_input: Período de no máximo 400 dias",
      ]);
      expect([action.name, await codeOf(runAction(action, tokenCall(s.storeId), days(400)))]).toEqual([action.name, "ok"]);
    }
  });

  test("painel (ator user): período desde 1970 continua aceito", async () => {
    const s = await seedPanelStore();
    for (const action of [metricsSummary, metricsBreakdown] as Action<unknown, unknown>[]) {
      expect([action.name, await codeOf(runAction(action, panelCall(s.storeId), { from: new Date(0), to: new Date() }))]).toEqual([action.name, "ok"]);
    }
  });
});

describe("periodRange", () => {
  test("hoje começa à meia-noite de São Paulo; 7 e 30 dias contam o dia de hoje", () => {
    const now = new Date("2026-11-18T02:30:00Z"); // 17/11 23:30 em São Paulo
    expect(periodRange("hoje", now).from.toISOString()).toBe("2026-11-17T03:00:00.000Z");
    expect(periodRange("7d", now).from.toISOString()).toBe("2026-11-11T03:00:00.000Z");
    expect(periodRange("30d", now).from.toISOString()).toBe("2026-10-19T03:00:00.000Z");
    expect(periodRange("7d", now).to).toEqual(now);
  });

  test("período anterior = o mesmo intervalo decorrido, deslocado (hoje 00:00–agora vs. ontem 00:00–mesma hora)", () => {
    const now = new Date("2026-11-18T12:00:00Z"); // 09:00 em São Paulo
    expect(periodRange("hoje", now, { previous: true })).toEqual({
      from: new Date("2026-11-17T03:00:00.000Z"),
      to: new Date("2026-11-17T12:00:00.000Z"),
    });
    expect(periodRange("7d", now, { previous: true })).toEqual({
      from: new Date("2026-11-05T03:00:00.000Z"),
      to: new Date("2026-11-11T12:00:00.000Z"),
    });
    expect(periodRange("30d", now, { previous: true })).toEqual({
      from: new Date("2026-09-20T03:00:00.000Z"),
      to: new Date("2026-10-19T12:00:00.000Z"),
    });
  });
});
