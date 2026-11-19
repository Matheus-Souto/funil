import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ActionError, runAction } from "@/lib/actions/core";
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
      byMethod: {
        pix_manual: { orders: 0, paid: 0, revenueCents: 0 },
        pix_asaas: { orders: 0, paid: 0, revenueCents: 0 },
        card_asaas: { orders: 0, paid: 0, revenueCents: 0 },
      },
      bySource: [],
      byRef: [],
    });
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
    const range = periodRange("7d");
    const b = await runAction(metricsBreakdown, panelCall(s.storeId), range);
    expect(b.byDay).toHaveLength(7);
    expect(b.byDay.at(-1)!.revenueCents).toBe(3690);
    expect(b.byDay.slice(0, 6).every((d) => d.revenueCents === 0)).toBe(true);
    expect(b.bumpPaid).toBe(1);
    expect(b.byOffer).toEqual([{ offerId: s.offerId, views: 4, orders: 3, paid: 2, bumpPaid: 1, revenueCents: 3690 }]);
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

  test("período anterior tem o mesmo tamanho e termina onde o atual começa", () => {
    const now = new Date("2026-11-18T15:00:00Z");
    const cur = periodRange("7d", now);
    const prev = periodRange("7d", now, { previous: true });
    expect(prev.to).toEqual(cur.from);
    expect(prev.from.toISOString()).toBe("2026-11-05T03:00:00.000Z");
  });
});
