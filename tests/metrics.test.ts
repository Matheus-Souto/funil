import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { ActionError, runAction, type Action } from "@/lib/actions/core";
import { checkoutLead, offer, recoveryEmail } from "@/lib/db/schema";
import { leadWindowCovered, metricsBreakdown, metricsHasAppOffer, metricsSummary, metricsTrials, periodRange, TRIAL_WINDOW_DAYS, trialWindowCovered } from "@/lib/metrics";
import { bpPercent } from "@/lib/format";
import { seedAppOffer, seedAppOrder, seedAppTrial } from "./app-fixtures";
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

  test("coupons: pagos do período por código, com desconto e receita; pendente, reembolsado e sem cupom ficam fora", async () => {
    const s = await seedPanelStore();
    await seedOrder(s, { status: "paid", totalCents: 891, coupon: { code: "KIDS10", discountCents: 99 } });
    await seedOrder(s, { status: "paid", totalCents: 891, coupon: { code: "KIDS10", discountCents: 99 } });
    await seedOrder(s, { status: "paid", totalCents: 500, coupon: { code: "AMIGO", discountCents: 490 } });
    await seedOrder(s, { status: "pending", totalCents: 891, coupon: { code: "KIDS10", discountCents: 99 } });
    await seedOrder(s, { status: "refunded", totalCents: 891, coupon: { code: "KIDS10", discountCents: 99 } });
    await seedOrder(s, { status: "paid", totalCents: 990 });
    const old = new Date(Date.now() - 10 * 24 * HOUR);
    await seedOrder(s, { status: "paid", totalCents: 891, paidAt: old, createdAt: old, coupon: { code: "KIDS10", discountCents: 99 } });
    const m = await runAction(metricsSummary, panelCall(s.storeId), window());
    expect(m.coupons).toEqual([
      { code: "KIDS10", orders: 2, discountCents: 198, revenueCents: 1782 },
      { code: "AMIGO", orders: 1, discountCents: 490, revenueCents: 500 },
    ]);
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
      coupons: [],
      recovery: {
        sent: 0,
        recovered: 0,
        recoveredRevenueCents: 0,
        byCase: { lead: { sent: 0, recovered: 0 }, pix: { sent: 0, recovered: 0 }, card: { sent: 0, recovered: 0 } },
      },
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

  test("recovery: sent por caso; Pix pago 2 h depois do lembrete conta como recuperado e soma a receita; pago 8 dias depois não conta; dois lembretes para o mesmo pedido pago não somam a receita duas vezes", async () => {
    const s = await seedPanelStore();
    const outra = await seedPanelStore("Outra");
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms);
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const mail = (k: string) => `recupera.${k}.${randomUUID().slice(0, 8)}@exemplo.com`;
    const reminder = (
      p: { storeId: string; offerId: string },
      kind: "lead" | "pix" | "card",
      email: string,
      over: Partial<typeof recoveryEmail.$inferInsert> = {},
    ): typeof recoveryEmail.$inferInsert => ({
      storeId: p.storeId,
      kind,
      offerId: p.offerId,
      emailHash: sha(email),
      mailboxHash: sha(email),
      status: "sent",
      unsubHash: sha(randomUUID()),
      dueAt: over.sentAt ?? at(HOUR),
      sentAt: at(HOUR),
      expiresAt: new Date(now + 90 * 24 * HOUR),
      ...over,
    });

    // Pix pago 2 h depois do lembrete: recuperado, 990.
    const ePix = mail("pix");
    const pix = await seedOrder(s, { status: "paid", email: ePix, totalCents: 990, paidAt: at(HOUR) });
    // Cartão pago 8 dias depois do lembrete: não conta.
    const eCard = mail("card");
    const card = await seedOrder(s, { status: "paid", email: eCard, totalCents: 5000, method: "card_asaas", paidAt: at(HOUR) });
    // Mesmo endereço com dois lembretes (contato e Pix) e um pedido pago depois dos dois: 2700 uma vez só.
    const eTwo = mail("dois");
    const two = await seedOrder(s, { status: "paid", email: eTwo, totalCents: 2700, hasBump: true, paidAt: at(2 * HOUR) });
    // Contato lembrado que não comprou; e outro que comprou outra oferta (não conta).
    const eNone = mail("nada");
    const eOther = mail("outra-oferta");
    const [other] = await t.ownerDb
      .insert(offer)
      .values({ storeId: s.storeId, slug: `outra-${randomUUID().slice(0, 8)}`, name: "Outra", priceCents: 4000, methods: ["pix"], pixMode: "manual" })
      .returning({ id: offer.id });
    await seedOrder({ ...s, offerId: other!.id }, { status: "paid", email: eOther, totalCents: 4000, paidAt: at(HOUR) });
    // Pedido pago antes do lembrete (mesmo e-mail e oferta): não conta.
    const eBefore = mail("antes");
    await seedOrder(s, { status: "paid", email: eBefore, totalCents: 990, paidAt: at(5 * HOUR) });

    await t.ownerDb.insert(recoveryEmail).values([
      reminder(s, "pix", ePix, { orderId: pix.id, sentAt: at(3 * HOUR) }),
      reminder(s, "card", eCard, { orderId: card.id, sentAt: at(HOUR + 8 * 24 * HOUR) }),
      reminder(s, "lead", eTwo, { sentAt: at(5 * HOUR) }),
      reminder(s, "pix", eTwo, { orderId: two.id, sentAt: at(4 * HOUR) }),
      reminder(s, "lead", eNone, { sentAt: at(3 * HOUR) }),
      reminder(s, "lead", eOther, { sentAt: at(3 * HOUR) }),
      reminder(s, "lead", eBefore, { sentAt: at(4 * HOUR) }),
      // não enviados: não contam
      reminder(s, "lead", mail("falhou"), { status: "failed", sentAt: null }),
      reminder(s, "lead", mail("fila"), { status: "queued", sentAt: null }),
      reminder(s, "lead", mail("pulado"), { status: "skipped", sentAt: null }),
      // outra loja, mesmo e-mail do Pix recuperado: não entra nesta loja
      reminder(outra, "lead", ePix, { sentAt: at(3 * HOUR) }),
    ]);

    const wide = { from: new Date(now - 10 * 24 * HOUR), to: new Date(now + HOUR) };
    const m = await runAction(metricsSummary, panelCall(s.storeId), wide);
    expect(m.recovery).toEqual({
      sent: 7,
      recovered: 3,
      recoveredRevenueCents: 990 + 2700,
      byCase: { lead: { sent: 4, recovered: 1 }, pix: { sent: 2, recovered: 2 }, card: { sent: 1, recovered: 0 } },
    });
    // "no período" = sent_at dentro do período: a janela de 24 h deixa o lembrete do cartão (9 dias atrás) de fora.
    expect((await runAction(metricsSummary, panelCall(s.storeId), window())).recovery).toMatchObject({ sent: 6, recovered: 3, recoveredRevenueCents: 3690 });
    // a outra loja só vê o próprio lembrete, sem pedido recuperado
    expect((await runAction(metricsSummary, panelCall(outra.storeId), wide)).recovery).toMatchObject({ sent: 1, recovered: 0, recoveredRevenueCents: 0 });
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
    expect(b.byOffer).toEqual([{ offerId: s.offerId, views: 4, orders: 3, paid: 2, bumpPaid: 1, revenueCents: 3690 }]);    // Vendas pagas por oferta e dia (mini gráfico da lista de ofertas): só o dia com venda, no mesmo dia do byDay.
    expect(b.byOfferDay).toEqual([{ offerId: s.offerId, day: b.byDay.at(-1)!.day, paid: 2, revenueCents: 3690 }]);
  });

  test("byOfferDay: dia de São Paulo (02:00 UTC ainda é o dia anterior), mais de uma oferta, sem outra loja", async () => {
    const s = await seedPanelStore();
    const [o2] = await t.ownerDb
      .insert(offer)
      .values({ storeId: s.storeId, slug: `outra-${randomUUID().slice(0, 8)}`, name: "Outra", priceCents: 1990, methods: ["pix"], pixMode: "manual" })
      .returning({ id: offer.id });
    // Três dias atrás (em UTC): 02:00 UTC = 23:00 do dia anterior em São Paulo; 03:30 UTC = 00:30 do próprio dia.
    const utcDay = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const prevSp = new Date(Date.parse(`${utcDay}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await seedOrder(s, { status: "paid", totalCents: 990, paidAt: new Date(`${utcDay}T02:00:00Z`) });
    await seedOrder(s, { status: "paid", totalCents: 990, paidAt: new Date(`${utcDay}T03:30:00Z`) });
    await seedOrder({ ...s, offerId: o2!.id }, { status: "paid", totalCents: 1990, paidAt: new Date(`${utcDay}T03:30:00Z`) });
    // Outra loja, mesmo dia: não aparece.
    const other = await seedPanelStore("Outra loja");
    await seedOrder(other, { status: "paid", totalCents: 5000, paidAt: new Date(`${utcDay}T03:30:00Z`) });

    const b = await runAction(metricsBreakdown, panelCall(s.storeId), periodRange("7d", new Date(Date.now() + 1)));
    const key = (r: { offerId: string; day: string }) => `${r.offerId}|${r.day}`;
    expect([...b.byOfferDay].sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
      [
        { offerId: s.offerId, day: prevSp, paid: 1, revenueCents: 990 },
        { offerId: s.offerId, day: utcDay, paid: 1, revenueCents: 990 },
        { offerId: o2!.id, day: utcDay, paid: 1, revenueCents: 1990 },
      ].sort((x, y) => key(x).localeCompare(key(y))),
    );
    expect(b.byOfferDay.some((r) => r.offerId === other.offerId)).toBe(false);
  });
});

describe("metrics.trials (teste do app → pagante)", () => {
  const DAY = 24 * HOUR;
  const ago = (ms: number) => new Date(Date.now() - ms);

  test("4 testes no período e 1 pagante: conversionBp 2500; pagante de teste fora do período não conta", async () => {
    const s = await seedPanelStore();
    const app = await seedAppOffer(s.storeId);
    for (const account of ["c1", "c2", "c3", "c4"]) await seedAppTrial(s.storeId, { account, startedAt: ago(2 * HOUR), campaign: "natal" });
    await seedAppOrder(s.storeId, { offerId: app.id, account: "c1", totalCents: 29_900 });
    // Teste antigo (fora do período) que pagou agora: nem teste nem pagante do período.
    await seedAppTrial(s.storeId, { account: "velho", startedAt: ago(10 * DAY), campaign: "natal" });
    await seedAppOrder(s.storeId, { offerId: app.id, account: "velho", totalCents: 49_900 });
    const m = await runAction(metricsTrials, panelCall(s.storeId), window());
    expect(m).toEqual({
      trials: 4,
      paying: 1,
      conversionBp: 2500,
      byCampaign: [{ campaign: "natal", trials: 4, paying: 1, conversionBp: 2500, revenueCents: 29_900 }],
      retentionCovered: true,
    });
  });

  test("pagante = conta com pedido app pago em qualquer data; pendente, reembolsado e pago antes do período só mudam a receita", async () => {
    const s = await seedPanelStore();
    const app = await seedAppOffer(s.storeId);
    await seedAppTrial(s.storeId, { account: "a", startedAt: ago(HOUR) });
    await seedAppTrial(s.storeId, { account: "b", startedAt: ago(HOUR) });
    await seedAppTrial(s.storeId, { account: "c", startedAt: ago(HOUR) });
    await seedAppOrder(s.storeId, { offerId: app.id, account: "a", totalCents: 1_000, paidAt: ago(3 * DAY) }); // pago fora do período
    await seedAppOrder(s.storeId, { offerId: app.id, account: "a", totalCents: 2_000 }); // pacote extra no período
    await seedAppOrder(s.storeId, { offerId: app.id, account: "b", status: "pending" });
    await seedAppOrder(s.storeId, { offerId: app.id, account: "c", status: "refunded", totalCents: 5_000 });
    const m = await runAction(metricsTrials, panelCall(s.storeId), window());
    expect([m.trials, m.paying, m.conversionBp]).toEqual([3, 1, 3333]); // floor(1 * 10000 / 3)
    expect(m.byCampaign).toEqual([{ campaign: "(sem campanha)", trials: 3, paying: 1, conversionBp: 3333, revenueCents: 2_000 }]);
  });

  test("agrupa por utm_campaign do primeiro toque, com \"(sem campanha)\"; ordem por testes", async () => {
    const s = await seedPanelStore();
    const app = await seedAppOffer(s.storeId);
    const seed = async (account: string, campaign?: string) => seedAppTrial(s.storeId, { account, startedAt: ago(HOUR), ...(campaign ? { campaign } : {}) });
    await seed("n1", "natal");
    await seed("n2", "natal");
    await seed("n3", "natal");
    await seed("r1", "reels");
    await seed("x1");
    await seed("x2");
    await seedAppOrder(s.storeId, { offerId: app.id, account: "n2", totalCents: 29_900 });
    await seedAppOrder(s.storeId, { offerId: app.id, account: "x1", totalCents: 9_900 });
    const m = await runAction(metricsTrials, panelCall(s.storeId), window());
    expect(m).toMatchObject({ trials: 6, paying: 2, conversionBp: 3333 });
    expect(m.byCampaign).toEqual([
      { campaign: "natal", trials: 3, paying: 1, conversionBp: 3333, revenueCents: 29_900 },
      { campaign: "(sem campanha)", trials: 2, paying: 1, conversionBp: 5000, revenueCents: 9_900 },
      { campaign: "reels", trials: 1, paying: 0, conversionBp: 0, revenueCents: 0 },
    ]);
  });

  test("loja sem testes: conversionBp null e lista vazia; testes de outra loja não contam", async () => {
    const a = await seedPanelStore("A");
    const b = await seedPanelStore("B");
    const app = await seedAppOffer(b.storeId);
    await seedAppTrial(b.storeId, { account: "b1", startedAt: ago(HOUR) });
    await seedAppOrder(b.storeId, { offerId: app.id, account: "b1" });
    expect(await runAction(metricsTrials, panelCall(a.storeId), window())).toEqual({ trials: 0, paying: 0, conversionBp: null, byCampaign: [], retentionCovered: true });
  });

  test("aceita { period } (hoje, 7d, 30d) como o Dashboard; período e intervalo juntos ou nenhum → invalid_input", async () => {
    const s = await seedPanelStore();
    await seedAppTrial(s.storeId, { account: "p1", startedAt: ago(3 * DAY) });
    await seedAppTrial(s.storeId, { account: "p2", startedAt: ago(20 * DAY) });
    expect((await runAction(metricsTrials, panelCall(s.storeId), { period: "7d" })).trials).toBe(1);
    expect((await runAction(metricsTrials, panelCall(s.storeId), { period: "30d" })).trials).toBe(2);
    for (const bad of [{}, { period: "7d", ...window() }, { from: new Date() }, { period: "90d" }]) {
      const err = await runAction(metricsTrials, panelCall(s.storeId), bad as never).catch((e: unknown) => e);
      expect([bad, (err as ActionError).code]).toEqual([bad, "invalid_input"]);
    }
  });

  test("retenção: testes sem pagamento somem com 179 dias; período que começa antes disso sai com retentionCovered false", async () => {
    const s = await seedPanelStore();
    expect(TRIAL_WINDOW_DAYS).toBe(179);
    const now = new Date();
    expect(trialWindowCovered(new Date(now.getTime() - 179 * DAY + 60_000), now)).toBe(true);
    expect(trialWindowCovered(new Date(now.getTime() - 180 * DAY), now)).toBe(false);
    expect((await runAction(metricsTrials, panelCall(s.storeId), { period: "30d" })).retentionCovered).toBe(true);
    expect((await runAction(metricsTrials, panelCall(s.storeId), { from: ago(200 * DAY), to: new Date() })).retentionCovered).toBe(false);
  });

  test("a descrição avisa da retenção de 179 dias e do corte de 50 campanhas", () => {
    expect(metricsTrials.description).toContain("179 dias");
    expect(metricsTrials.description).toContain("retentionCovered");
    expect(metricsTrials.description).toContain("50 campanhas");
  });

  test("mais de 50 campanhas: as 50 com mais testes; totais contam todas", async () => {
    const s = await seedPanelStore();
    for (let i = 0; i < 52; i++) await seedAppTrial(s.storeId, { account: `k${i}`, startedAt: ago(HOUR), campaign: `camp-${String(i).padStart(2, "0")}` });
    await seedAppTrial(s.storeId, { account: "k-extra", startedAt: ago(HOUR), campaign: "camp-00" });
    const m = await runAction(metricsTrials, panelCall(s.storeId), window());
    expect(m.trials).toBe(53);
    expect(m.byCampaign).toHaveLength(50);
    expect(m.byCampaign[0]).toMatchObject({ campaign: "camp-00", trials: 2 });
  });

  test("permissão metrics.read (support não lê) e teto de 400 dias para token", async () => {
    const s = await seedPanelStore();
    const err = await runAction(metricsTrials, panelCall(s.storeId, "support"), window()).catch((e: unknown) => e);
    expect((err as ActionError).code).toBe("forbidden");
    const token = { storeId: s.storeId, actor: { kind: "token" as const, tokenId: randomUUID(), role: "reader" as const }, origin: "mcp" as const };
    const long = await runAction(metricsTrials, token, { from: ago(401 * DAY), to: new Date() }).catch((e: unknown) => e);
    expect((long as ActionError).code).toBe("invalid_input");
  });
});

test("bpPercent: pontos-base inteiros em porcentagem sem ponto flutuante", () => {
  expect([2500, 3333, 10000, 50, 5, 0, 1234, null].map(bpPercent)).toEqual(["25%", "33,33%", "100%", "0,5%", "0,05%", "0%", "12,34%", "—"]);
});

describe("metrics.hasAppOffer (bloco \"Testes do app\" no Dashboard)", () => {
  test("só com oferta app ativa: loja de download, oferta app inativa e oferta app de outra loja não contam", async () => {
    const s = await seedPanelStore();
    const other = await seedPanelStore("Outra");
    await seedAppOffer(other.storeId);
    expect(await runAction(metricsHasAppOffer, panelCall(s.storeId), {})).toEqual({ hasAppOffer: false });
    await seedAppOffer(s.storeId, { active: false });
    expect(await runAction(metricsHasAppOffer, panelCall(s.storeId), {})).toEqual({ hasAppOffer: false });
    await seedAppOffer(s.storeId);
    expect(await runAction(metricsHasAppOffer, panelCall(s.storeId), {})).toEqual({ hasAppOffer: true });
    const err = await runAction(metricsHasAppOffer, panelCall(s.storeId, "support"), {}).catch((e: unknown) => e);
    expect((err as ActionError).code).toBe("forbidden");
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

describe("contatos: só os últimos 30 dias existem (retenção)", () => {
  test("a janela anterior de 30 dias começa antes da retenção: sem comparação; hoje e 7 dias comparam", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(leadWindowCovered(periodRange("hoje", now, { previous: true }).from, now)).toBe(true);
    expect(leadWindowCovered(periodRange("7d", now, { previous: true }).from, now)).toBe(true);
    expect(leadWindowCovered(periodRange("30d", now, { previous: true }).from, now)).toBe(false);
    expect(leadWindowCovered(periodRange("30d", now).from, now)).toBe(true);
    // limite: exatamente 30 dias atrás ainda está coberto; um milissegundo antes, não
    expect(leadWindowCovered(new Date(now.getTime() - 30 * 86_400_000), now)).toBe(true);
    expect(leadWindowCovered(new Date(now.getTime() - 30 * 86_400_000 - 1), now)).toBe(false);
  });

  test("a descrição de metrics.summary avisa que leads e leadsConverted cobrem só os últimos 30 dias", () => {
    expect(metricsSummary.description).toContain("últimos 30 dias");
  });
});
