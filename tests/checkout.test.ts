import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { z } from "zod";
import { ActionError, runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { listActions } from "@/lib/actions/registry";
import { checkoutOffer } from "@/lib/catalog/checkout-offer";
import { createOffer, getPublicOffer, setOfferProducts } from "@/lib/catalog/offers";
import { withStore } from "@/lib/db/client";
import { auditLog, checkoutLead, checkoutView, customer, orderItem, orders, product, store } from "@/lib/db/schema";
import { checkoutSaveLead } from "@/lib/leads/capture";
import {
  ASAAS_LIMITS,
  CARD_UNAVAILABLE_MESSAGE,
  CHECKOUT_LIMIT_MESSAGE,
  PIX_REGEN_PER_HOUR,
  PIX_UNAVAILABLE_MESSAGE,
  TOUCH_MAX_BYTES,
  VIEW_LIMIT_PER_HOUR,
  checkoutMethods,
  checkoutRenewCardTicket,
  checkoutStart,
  checkoutView as checkoutViewAction,
  getOrderPublic,
  handleOrderStatus,
  regenerateOrderPix,
  renewCardTicket,
  startCheckout,
} from "@/lib/checkout";
import { CARD_TICKET_RENEW_WINDOW_MS, CARD_TICKET_TTL_MS, issueCardTicket, verifyCardTicket } from "@/lib/payments/card-ticket";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { createOrder, type Method } from "@/lib/orders/create";
import { payWithCard } from "@/lib/payments/asaas/card";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { savePixManual } from "@/lib/payments/manual";
import { resetCardFingerprintsForTests } from "@/lib/payments/ratelimit";
import { HEAVY_TEST_MS, createTestDb, seedProduct, seedStore, type TestDb } from "./db";
import { createFakeAsaas, type FakeAsaas } from "./fakes/asaas";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  setAsaasFetchForTests();
  await t.drop();
});
afterEach(() => {
  setAsaasFetchForTests();
  resetCardFingerprintsForTests();
});

const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const pub = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });
const tick = () => new Promise<void>((r) => setImmediate(r));

let ipSeq = 0;
const nextIp = () => `203.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const email = () => `c-${randomUUID()}@example.com`;
const CPF = "52998224725";
const CPF_B = "11144477735";

type Over = Record<string, unknown> & { customer?: Record<string, unknown> };
function startInput(slug: string, over: Over = {}) {
  const { customer: c, ...rest } = over;
  return {
    slug,
    withBump: false,
    method: "pix",
    customer: { name: "Maria Souza", email: email(), phone: "(11) 98765-4321", ...c },
    touch: { first: null, last: { utm_source: "ig" } },
    eventId: randomUUID(),
    clientIp: nextIp(),
    userAgent: "bun-test",
    ...rest,
  };
}

interface SeedOpts {
  pixMode?: "manual" | "asaas";
  methods?: ("pix" | "card")[];
  bump?: boolean;
  pixKey?: boolean;
  asaas?: FakeAsaas | null;
  priceCents?: number;
  maxInstallments?: number;
}

/** Loja com produto, oferta (bump opcional de 1710), chave Pix manual e/ou Asaas (fake). */
async function seed(opts: SeedOpts = {}) {
  const { storeId } = await seedStore("Maná Kids");
  const call = { storeId, actor: owner, origin: "panel" as const };
  if (opts.asaas) {
    setAsaasFetchForTests(opts.asaas.fetch);
    await runAction(saveAsaas, call, { env: "sandbox", apiKey: opts.asaas.apiKey });
  }
  if (opts.pixKey !== false) await runAction(savePixManual, call, { key: "contato@manakids.com.br", name: "Mana Kids", city: "Sao Paulo" });
  const main = await seedProduct(storeId, "Maná básica");
  const extra = await seedProduct(storeId, "Maná completa");
  const slug = `o-${Math.random().toString(36).slice(2, 10)}`;
  const offer = await runAction(createOffer, call, {
    slug,
    name: "Maná bíblico para crianças",
    productIds: [main.id],
    priceCents: opts.priceCents ?? 990,
    methods: opts.methods ?? ["pix", "card"],
    pixMode: opts.pixMode ?? "manual",
    ...(opts.bump === false ? {} : { bump: { productIds: [extra.id], priceCents: 1710, label: "Quero a versão completa" } }),
    thankYouText: "Que essas histórias tragam momentos especiais em família!",
    ...(opts.maxInstallments ? { maxInstallments: opts.maxInstallments } : {}),
  });
  return { storeId, slug, offerId: offer.id };
}

const orderBy = async (storeId: string, publicId: string) =>
  (await withStore(storeId, (tx) => tx.select().from(orders).where(eq(orders.publicId, publicId))))[0]!;
const customerOf = async (storeId: string, id: string) =>
  (await withStore(storeId, (tx) => tx.select().from(customer).where(eq(customer.id, id))))[0]!;
const fail = (p: Promise<unknown>) => p.then(
  () => {
    throw new Error("esperava erro");
  },
  (e: unknown) => e as ActionError,
);

describe("checkout.start: método, CPF e valores", () => {
  test("oferta só com Pix recusa method card", async () => {
    const s = await seed({ methods: ["pix"] });
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card", customer: { cpf: CPF } })));
    expect(e).toBeInstanceOf(ActionError);
    expect(e.code).toBe("invalid_input");
  });

  test("pix_mode asaas: CPF inválido ou ausente -> invalid_input", async () => {
    const s = await seed({ pixMode: "asaas", asaas: createFakeAsaas() });
    const bad = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { cpf: "123.456.789-00" } })));
    expect(bad.code).toBe("invalid_input");
    const missing = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug)));
    expect(missing.code).toBe("invalid_input");
    const ok = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { cpf: "529.982.247-25" } }));
    expect(ok.method).toBe("pix_asaas");
    expect((await orderBy(s.storeId, ok.publicId)).buyerCpf).toBe(CPF);
  });

  test("cartão exige CPF válido e Asaas conectado", async () => {
    const noAsaas = await seed();
    const e = await fail(runAction(checkoutStart, pub(noAsaas.storeId), startInput(noAsaas.slug, { method: "card", customer: { cpf: CPF } })));
    expect(e.code).toBe("conflict");
    const s = await seed({ asaas: createFakeAsaas() });
    expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card" })))).code).toBe("invalid_input");
    const ok = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card", customer: { cpf: CPF } }));
    expect(ok.method).toBe("card_asaas");
  });

  test("pix_mode manual ignora o CPF enviado e não o salva", async () => {
    const s = await seed();
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { cpf: CPF } }));
    expect(r.method).toBe("pix_manual");
    const o = await orderBy(s.storeId, r.publicId);
    expect(o.buyerCpf).toBeNull();
    expect((await customerOf(s.storeId, o.customerId)).cpf).toBeNull();
  });

  test("bump marcado gera pedido de 2700 com dois itens", async () => {
    const s = await seed();
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { withBump: true }));
    const o = await orderBy(s.storeId, r.publicId);
    expect(o.totalCents).toBe(2700);
    expect(o.hasBump).toBe(true);
    expect(o.manualAmountCents!).toBeGreaterThan(2700);
    expect(o.manualAmountCents!).toBeLessThanOrEqual(2799);
    const items = await withStore(s.storeId, (tx) => tx.select().from(orderItem).where(eq(orderItem.orderId, o.id)));
    expect(items.map((i) => i.priceCents).sort()).toEqual([1710, 990]);
  });

  test("cupom sem expectedTotalCents -> invalid_input; total esperado sem cupom: igual cria, diferente -> conflict PRICE_CHANGED e nenhum pedido", async () => {
    const s = await seed();
    const noTotal = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { couponCode: "KIDS10" })));
    expect(noTotal.code).toBe("invalid_input");
    expect(JSON.stringify(noTotal.details)).toContain("expectedTotalCents");
    const same = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { expectedTotalCents: 990 }));
    expect(same.totalCents).toBe(990);
    const changed = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { withBump: true, expectedTotalCents: 990 })));
    expect([changed.code, changed.message, (changed.details as { code?: string }).code]).toEqual(["conflict", "O valor mudou: confira o resumo", "PRICE_CHANGED"]);
    const rows = await withStore(s.storeId, (tx) => tx.select({ id: orders.id }).from(orders));
    expect(rows).toHaveLength(1);
  });

  test("oferta inexistente ou inativa -> not_found", async () => {
    const s = await seed();
    expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput("nao-existe")))).code).toBe("not_found");
  });
});

describe("checkout.start: celular, e-mail e retrato do comprador", () => {
  test("celular BR de verdade: DDD válido, 9 + 8 dígitos, sem dígitos repetidos", async () => {
    const s = await seed();
    for (const phone of ["11999999999", "(20) 98765-4321", "1198765432", "(11) 8765-43210", "abc"]) {
      const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { phone } })));
      expect(e.code).toBe("invalid_input");
    }
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { phone: "+55 (21) 98765-4321" } }));
    expect((await orderBy(s.storeId, r.publicId)).buyerPhone).toBe("21987654321");
  });

  test("e-mail inválido -> invalid_input", async () => {
    const s = await seed();
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: "maria@" } })));
    expect(e.code).toBe("invalid_input");
  });

  test("mesmo e-mail com outros dados: o cliente não é sobrescrito; o pedido guarda o retrato do comprador", async () => {
    const s = await seed({ pixMode: "asaas", asaas: createFakeAsaas() });
    const mail = email();
    const a = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail, name: "Ana Lima", cpf: CPF } }));
    const b = await runAction(
      checkoutStart,
      pub(s.storeId),
      startInput(s.slug, { customer: { email: mail.toUpperCase(), name: "Outra Pessoa", phone: "21987654321", cpf: CPF_B } }),
    );
    const oa = await orderBy(s.storeId, a.publicId);
    const ob = await orderBy(s.storeId, b.publicId);
    expect(ob.customerId).toBe(oa.customerId);
    const c = await customerOf(s.storeId, oa.customerId);
    expect({ name: c.name, phone: c.phone, cpf: c.cpf }).toEqual({ name: "Ana Lima", phone: "11987654321", cpf: CPF });
    expect({ name: ob.buyerName, phone: ob.buyerPhone, cpf: ob.buyerCpf }).toEqual({ name: "Outra Pessoa", phone: "21987654321", cpf: CPF_B });
  });

  test("cliente sem CPF ganha o CPF do primeiro pedido que o exige (só preenche vazio)", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const mail = email();
    const a = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail } }));
    const cust = (await orderBy(s.storeId, a.publicId)).customerId;
    expect((await customerOf(s.storeId, cust)).cpf).toBeNull();
    await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card", customer: { email: mail, cpf: CPF } }));
    expect((await customerOf(s.storeId, cust)).cpf).toBe(CPF);
  });

  test("auditoria: slug, método, bump e e-mail em hash; nunca CPF, celular nem e-mail", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const mail = email();
    await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card", withBump: true, customer: { email: mail, cpf: CPF } }));
    const rows = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "checkout.start")));
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]!.input);
    expect(text).not.toContain(CPF);
    expect(text).not.toContain("98765");
    expect(text).not.toContain(mail);
    expect(rows[0]!.input).toEqual({
      slug: s.slug,
      method: "card",
      hasBump: true,
      emailHash: createHash("sha256").update(mail).digest("hex"),
    });
  });
});

/** Ocupa os 99 valores únicos do total (pedidos Pix manual pendentes de outro comprador). */
async function exhaustManual(storeId: string, offerId: string, total = 990) {
  await withStore(storeId, async (tx) => {
    const [c] = await tx.insert(customer).values({ storeId, email: `fill-${randomUUID()}@x.com`, name: "X", phone: "11987654321" }).returning();
    await tx.insert(orders).values(
      Array.from({ length: 99 }, (_, i) => ({
        storeId,
        publicId: `fill-${randomUUID()}`,
        offerId,
        customerId: c!.id,
        status: "pending",
        method: "pix_manual",
        subtotalCents: total,
        totalCents: total,
        manualAmountCents: total + 1 + i,
        expiresAt: new Date(Date.now() + 3600_000),
        clientIp: "127.0.0.1",
        userAgent: "x",
      })),
    );
  });
}

describe("checkout.start: Pix manual esgotado", () => {
  test("com Asaas conectado: sem CPF -> needs_cpf; com CPF -> pedido pix_asaas", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    await exhaustManual(s.storeId, s.offerId);
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug)));
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("needs_cpf");
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { cpf: CPF } }));
    expect(r.method).toBe("pix_asaas");
    const o = await orderBy(s.storeId, r.publicId);
    expect(o.method).toBe("pix_asaas");
    expect(o.buyerCpf).toBe(CPF);
  });

  test("sem Asaas -> mensagem de Pix indisponível", async () => {
    const s = await seed();
    await exhaustManual(s.storeId, s.offerId);
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { cpf: CPF } })));
    expect(e.code).toBe("conflict");
    expect(e.message).toBe(PIX_UNAVAILABLE_MESSAGE);
    expect(PIX_UNAVAILABLE_MESSAGE).toBe("Pix indisponível no momento, tente em alguns minutos");
  });
});

describe("checkout.start: limites do Pix manual (DoS de pendentes)", () => {
  test("no máximo 3 Pix manuais pendentes ou reservados por e-mail na loja", async () => {
    const s = await seed();
    const mail = email();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail } }))).publicId);
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail } })));
    expect(e.code).toBe("rate_limited");
    expect(e.message).toBe(CHECKOUT_LIMIT_MESSAGE);
    expect(CHECKOUT_LIMIT_MESSAGE).toBe("Você já tem um Pix aguardando pagamento. Use o código anterior ou aguarde alguns minutos.");

    // Expirado há pouco ainda reserva o valor (48 h): continua contando.
    await withStore(s.storeId, (tx) =>
      tx.update(orders).set({ status: "expired", expiresAt: new Date(Date.now() - 3600_000) }).where(eq(orders.publicId, ids[0]!)),
    );
    expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail } })))).code).toBe("rate_limited");

    // Expirado há mais de 48 h e pago não contam.
    await withStore(s.storeId, async (tx) => {
      await tx.update(orders).set({ expiresAt: new Date(Date.now() - 49 * 3600_000) }).where(eq(orders.publicId, ids[0]!));
    });
    const ok = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail } }));
    expect(ok.method).toBe("pix_manual");
  });

  test("outro e-mail e cartão não são afetados pelo limite por e-mail", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const mail = email();
    for (let i = 0; i < 3; i++) await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail } }));
    const card = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card", customer: { email: mail, cpf: CPF } }));
    expect(card.method).toBe("card_asaas");
    expect((await runAction(checkoutStart, pub(s.storeId), startInput(s.slug))).method).toBe("pix_manual");
  });

  test("no máximo 5 Pix manuais por IP por hora (IP desconhecido não limita)", async () => {
    const s = await seed();
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip }));
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip })));
    expect(e.code).toBe("rate_limited");
    expect(e.message).toBe(CHECKOUT_LIMIT_MESSAGE);
    // Rejeição de ator público antes de executar: sem linha de auditoria de falha.
    const failures = await withStore(s.storeId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.action, "checkout.start"), eq(auditLog.ok, false))),
    );
    expect(failures).toHaveLength(0);
    for (let i = 0; i < 7; i++) await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: "unknown" }));
  });
});

describe("startCheckout: Pix do Asaas", () => {
  test("cria a cobrança logo após o pedido, com o retrato do comprador no cliente do Asaas", async () => {
    const fake = createFakeAsaas();
    const s = await seed({ pixMode: "asaas", asaas: fake });
    const mail = email();
    await startCheckout({ storeId: s.storeId }, startInput(s.slug, { customer: { email: mail, name: "Ana Lima", cpf: CPF } }));
    const r = await startCheckout(
      { storeId: s.storeId },
      startInput(s.slug, { customer: { email: mail, name: "Outra Pessoa", phone: "21987654321", cpf: CPF_B } }),
    );
    expect(r.method).toBe("pix_asaas");
    const created = fake.calls.filter((c) => c.method === "POST" && c.path === "/customers").map((c) => c.body as Record<string, unknown>);
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ name: "Outra Pessoa", cpfCnpj: CPF_B, mobilePhone: "21987654321" });
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/payments")).toHaveLength(2);
  });

  test("celular recusado pelo Asaas vira invalid_input 'Confira o número de WhatsApp'", async () => {
    const fake = createFakeAsaas();
    const s = await seed({ pixMode: "asaas", asaas: fake });
    fake.fail("POST /customers", 400, "O celular informado é inválido", "invalid_mobilePhone");
    const e = await fail(startCheckout({ storeId: s.storeId }, startInput(s.slug, { customer: { cpf: CPF } })));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toBe("Confira o número de WhatsApp");
    expect(e.details).toEqual([{ path: ["customer", "phone"] }]);
  });
});

describe("cartão: CPF do titular e validade", () => {
  test("CPF do titular vai só para o Asaas (holder); cliente e pedido guardam o CPF do comprador", async () => {
    const fake = createFakeAsaas();
    const s = await seed({ asaas: fake });
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card", customer: { cpf: CPF } }));
    const res = await payWithCard(
      { storeId: s.storeId },
      {
        orderPublicId: r.publicId,
        idempotencyKey: randomUUID(),
        installments: 1,
        card: { holderName: "TITULAR", number: "4444444444444444", expiryMonth: "08", expiryYear: "2034", ccv: "123" },
        holder: { cpf: CPF_B, postalCode: "01310100", addressNumber: "10" },
        clientIp: nextIp(),
      },
      { wait: tick },
    );
    expect(res.status).toBe("approved");
    const o = await orderBy(s.storeId, r.publicId);
    expect(o.buyerCpf).toBe(CPF);
    expect((await customerOf(s.storeId, o.customerId)).cpf).toBe(CPF);
    const cust = fake.calls.find((c) => c.path === "/customers")!.body as Record<string, unknown>;
    expect(cust.cpfCnpj).toBe(CPF);
    const pay = fake.calls.find((c) => c.method === "POST" && c.path === "/payments")!.body as { creditCardHolderInfo: Record<string, unknown> };
    expect(pay.creditCardHolderInfo.cpfCnpj).toBe(CPF_B);
    expect(pay.creditCardHolderInfo.mobilePhone).toBe("11987654321");
  });

  test("validade anterior ao mês atual (São Paulo) -> invalid_input sem tocar no Asaas", async () => {
    const fake = createFakeAsaas();
    const s = await seed({ asaas: fake });
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method: "card", customer: { cpf: CPF } }));
    // 2026-12-01 01:00 UTC = 30/11 22:00 em São Paulo: novembro ainda vale, outubro não.
    const now = () => new Date("2026-12-01T01:00:00Z");
    const card = (expiryMonth: string) => ({
      orderPublicId: r.publicId,
      idempotencyKey: randomUUID(),
      installments: 1,
      card: { holderName: "TITULAR", number: "4444444444444444", expiryMonth, expiryYear: "2026", ccv: "123" },
      holder: { cpf: CPF, postalCode: "01310100", addressNumber: "10" },
      clientIp: nextIp(),
    });
    const e = await fail(payWithCard({ storeId: s.storeId }, card("10"), { wait: tick, now }));
    expect(e.code).toBe("invalid_input");
    expect(e.details).toEqual([{ path: ["card", "expiryMonth"] }]);
    expect(fake.calls.filter((c) => c.path === "/payments")).toHaveLength(0);
    expect((await payWithCard({ storeId: s.storeId }, card("11"), { wait: tick, now })).status).toBe("approved");
  });
});

describe("página do checkout: \"Inclui:\" e cartão do bump (dados de offers.getPublic)", () => {
  const KIDS = ["Almanaque Bíblico Kids", "Pack de jogos", "Datas especiais", "Cartões de versículos", "Diário de oração", "Escola dominical"];
  const pageData = async (storeId: string, slug: string) =>
    checkoutOffer(await runAction(getPublicOffer, pub(storeId), { slug }), ["pix", "card"]);

  test("Completo (6 principais): nome da oferta e a linha \"Inclui:\" com os 6 nomes na ordem", async () => {
    const { storeId } = await seedStore("Kids");
    const six = [];
    for (const n of KIDS) six.push(await seedProduct(storeId, n));
    await runAction(createOffer, { storeId, actor: owner, origin: "panel" }, {
      slug: "completo",
      name: "Completo",
      productIds: six.map((p) => p.id),
      priceCents: 2700,
      methods: ["pix"],
      pixMode: "manual",
    });
    const v = await pageData(storeId, "completo");
    expect(v.name).toBe("Completo");
    expect(v.includes).toBe(`Inclui: ${KIDS.join(" · ")}`);
    expect(v.productName).toBe("Completo");
    expect(v.priceCents).toBe(2700);
    expect(v.bump).toBeNull();
  });

  test("1 principal: sem linha \"Inclui\" e o nome do produto (como antes); bump de 1 produto mostra o nome dele", async () => {
    const s = await seed();
    const v = await pageData(s.storeId, s.slug);
    expect(v.includes).toBeNull();
    expect(v.productName).toBe("Maná básica");
    expect(v.bump).toEqual({ productName: "Maná completa", contents: null, priceCents: 1710, label: "Quero a versão completa" });
  });

  test("Almanaque com bump de 5: o cartão do bump mostra o rótulo e a lista dos 5", async () => {
    const { storeId } = await seedStore("Kids");
    const [alm, ...kits] = await Promise.all(KIDS.map((n) => seedProduct(storeId, n)));
    await runAction(createOffer, { storeId, actor: owner, origin: "panel" }, {
      slug: "almanaque",
      name: "Almanaque",
      productIds: [alm!.id],
      priceCents: 990,
      methods: ["pix"],
      pixMode: "manual",
      bump: { productIds: kits.map((p) => p.id), priceCents: 1710, label: "5 Kits Extras" },
    });
    const v = await pageData(storeId, "almanaque");
    expect(v.includes).toBeNull();
    expect(v.productName).toBe(KIDS[0]);
    expect(v.bump).toEqual({ productName: "5 Kits Extras", contents: KIDS.slice(1).join(" · "), priceCents: 1710, label: "5 Kits Extras" });
  });
});

describe("página do pedido", () => {
  test("getOrderPublic nunca contém e-mail, CPF, celular nem ids internos", async () => {
    const s = await seed({ pixMode: "asaas", asaas: createFakeAsaas() });
    const mail = email();
    const r = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { withBump: true, customer: { email: mail, cpf: CPF } }));
    const o = await orderBy(s.storeId, r.publicId);
    const view = await getOrderPublic(s.storeId, r.publicId);
    expect(view).not.toBeNull();
    expect(view!.status).toBe("pending");
    expect(view!.method).toBe("pix_asaas");
    expect(view!.totalCents).toBe(2700);
    expect(view!.items.map((i) => i.name)).toEqual(["Maná básica", "Maná completa"]);
    expect(view!.pix?.copyPaste).toContain("00020126");
    expect(view!.thankYouText).toBe("Que essas histórias tragam momentos especiais em família!");
    const text = JSON.stringify(view);
    for (const secret of [mail, CPF, "98765", o.id, o.customerId, o.offerId, s.storeId]) expect(text).not.toContain(secret);
  });

  test("Pix manual: valor único, BR Code e QR em SVG", async () => {
    const s = await seed();
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug));
    const view = (await getOrderPublic(s.storeId, r.publicId))!;
    expect(view.method).toBe("pix_manual");
    expect(view.manualAmountCents!).toBeGreaterThan(990);
    expect(view.pix!.copyPaste.startsWith("000201")).toBe(true);
    expect(view.pix!.qrSvg).toContain("<svg");
    expect(view.pix!.receiver).toBe("MANA KIDS");
  });

  test("publicId da loja B consultado pela loja A -> null; rota de status 404", async () => {
    const a = await seed();
    const b = await seed();
    const rb = await runAction(checkoutStart, pub(b.storeId), startInput(b.slug));
    expect(await getOrderPublic(a.storeId, rb.publicId)).toBeNull();
    const resolveA = async () => ({ id: a.storeId, slug: "a", name: "A" });
    const resolveB = async () => ({ id: b.storeId, slug: "b", name: "B" });
    const req = () => new Request(`http://loja/api/orders/${rb.publicId}/status`, { headers: { host: "loja" } });
    expect((await handleOrderStatus(req(), rb.publicId, { resolveStore: resolveA })).status).toBe(404);
    const ok = await handleOrderStatus(req(), rb.publicId, { resolveStore: resolveB });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "pending" });
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  test("checkout.view grava uma visita da oferta", async () => {
    const s = await seed();
    await runAction(checkoutViewAction, pub(s.storeId), { slug: s.slug, touch: { first: null, last: { utm_source: "ig" } }, clientIp: nextIp() });
    const rows = await withStore(s.storeId, (tx) => tx.select().from(checkoutView).where(eq(checkoutView.offerId, s.offerId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.touch).toEqual({ first: null, last: { utm_source: "ig" } });
  });
});

describe("fix 1: limites contam pedidos criados, não tentativas", () => {
  test("Pix manual por IP: tentativas recusadas (limite por e-mail) não consomem as 5 do IP", async () => {
    const s = await seed();
    const ip = nextIp();
    const mail = email();
    for (let i = 0; i < 3; i++) await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip, customer: { email: mail } }));
    for (let i = 0; i < 4; i++) {
      expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip, customer: { email: mail } })))).code).toBe("rate_limited");
    }
    for (let i = 0; i < 2; i++) expect((await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip }))).method).toBe("pix_manual");
    expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip })))).code).toBe("rate_limited");
  });

  test("ida e volta do needs_cpf e o Pix do Asaas de reserva não consomem o limite do Pix manual", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    await exhaustManual(s.storeId, s.offerId);
    const ip = nextIp();
    for (let i = 0; i < 6; i++) {
      expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip })))).message).toBe("needs_cpf");
    }
    for (let i = 0; i < 6; i++) {
      expect((await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip, customer: { cpf: CPF } }))).method).toBe("pix_asaas");
    }
    // Valores liberados: o IP ainda tem os 5 Pix manuais.
    await withStore(s.storeId, (tx) => tx.delete(orders).where(and(eq(orders.method, "pix_manual"), eq(orders.offerId, s.offerId))));
    for (let i = 0; i < 5; i++) expect((await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip }))).method).toBe("pix_manual");
    expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip })))).code).toBe("rate_limited");
  });

  test("Asaas (cartão e Pix do Asaas): 10 pedidos por IP por hora", async () => {
    const s = await seed({ pixMode: "asaas", asaas: createFakeAsaas() });
    expect(ASAAS_LIMITS).toEqual({ perIpPerHour: 10, perEmailPerHour: 5 });
    const ip = nextIp();
    // Recusado (CPF inválido) não conta.
    expect((await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip, customer: { cpf: "123" } })))).code).toBe("invalid_input");
    for (let i = 0; i < 10; i++) {
      const method = i % 2 ? "card" : "pix";
      await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip, method, customer: { cpf: CPF } }));
    }
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { clientIp: ip, method: "card", customer: { cpf: CPF } })));
    expect(e.code).toBe("rate_limited");
  });

  test("Asaas: 5 pedidos por e-mail por hora na loja (outra loja não é afetada)", async () => {
    const fake = createFakeAsaas();
    const a = await seed({ pixMode: "asaas", asaas: fake });
    const mail = email();
    for (let i = 0; i < 5; i++) await runAction(checkoutStart, pub(a.storeId), startInput(a.slug, { method: "card", customer: { email: mail, cpf: CPF } }));
    const e = await fail(runAction(checkoutStart, pub(a.storeId), startInput(a.slug, { customer: { email: mail, cpf: CPF } })));
    expect(e.code).toBe("rate_limited");
    const b = await seed({ pixMode: "asaas", asaas: fake });
    expect((await runAction(checkoutStart, pub(b.storeId), startInput(b.slug, { customer: { email: mail, cpf: CPF } }))).method).toBe("pix_asaas");
  });

  test("falhas de ator público em checkout.start não gravam audit_log; sucesso grava", async () => {
    const s = await seed();
    const mail = email();
    for (let i = 0; i < 4; i++) await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { customer: { email: mail } })).catch(() => undefined);
    await runAction(checkoutStart, pub(s.storeId), startInput("nao-existe")).catch(() => undefined);
    const rows = await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "checkout.start")));
    expect(rows.map((r) => r.ok)).toEqual([true, true, true]);
  });
});

describe("fix 1: página do pedido nunca chama o Asaas; novo código só por POST", () => {
  test("GET (getOrderPublic) lê o QR guardado no checkout, sem chamar o Asaas", async () => {
    const fake = createFakeAsaas();
    const s = await seed({ pixMode: "asaas", asaas: fake });
    const r = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { customer: { cpf: CPF } }));
    const before = fake.calls.length;
    const view = (await getOrderPublic(s.storeId, r.publicId))!;
    expect(view.pix?.copyPaste).toContain("00020126fake");
    expect(view.pix?.qrImage).toBeTruthy();
    await getOrderPublic(s.storeId, r.publicId);
    expect(fake.calls.length).toBe(before);
  });

  test("QR faltando: a página mostra o aviso sem chamar o Asaas; 'Gerar novo código Pix' (POST) busca e guarda; 3 por hora", async () => {
    const fake = createFakeAsaas();
    const s = await seed({ pixMode: "asaas", asaas: fake });
    fake.fail("GET /payments/", 503, "fora do ar");
    const r = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { customer: { cpf: CPF } }));
    fake.clearFailures();
    const before = fake.calls.length;
    const missing = (await getOrderPublic(s.storeId, r.publicId))!;
    expect(missing.pix).toBeUndefined();
    expect(missing.pixUnavailable).toBe(true);
    expect(fake.calls.length).toBe(before);

    expect(PIX_REGEN_PER_HOUR).toBe(3);
    await runAction(regenerateOrderPix, pub(s.storeId), { publicId: r.publicId });
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/payments")).toHaveLength(1); // reaproveita a cobrança
    const view = (await getOrderPublic(s.storeId, r.publicId))!;
    expect(view.pix?.copyPaste).toContain("00020126fake");
    await runAction(regenerateOrderPix, pub(s.storeId), { publicId: r.publicId });
    await runAction(regenerateOrderPix, pub(s.storeId), { publicId: r.publicId });
    expect((await fail(runAction(regenerateOrderPix, pub(s.storeId), { publicId: r.publicId }))).code).toBe("rate_limited");
  });

  test("novo código só para Pix do Asaas pendente da própria loja", async () => {
    const s = await seed();
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug));
    expect((await fail(runAction(regenerateOrderPix, pub(s.storeId), { publicId: r.publicId }))).code).toBe("conflict");
    const other = await seed();
    expect((await fail(runAction(regenerateOrderPix, pub(other.storeId), { publicId: r.publicId }))).code).toBe("not_found");
  });
});

describe("fix 1: checkout.view (gravação anônima)", () => {
  test("no máximo 30 visitas por IP por hora em cada oferta", async () => {
    const s = await seed();
    expect(VIEW_LIMIT_PER_HOUR).toBe(30);
    const ip = nextIp();
    const view = (clientIp: string) => runAction(checkoutViewAction, pub(s.storeId), { slug: s.slug, touch: { first: null, last: null }, clientIp });
    for (let i = 0; i < 30; i++) await view(ip);
    expect((await fail(view(ip))).code).toBe("rate_limited");
    await view(nextIp());
    const rows = await withStore(s.storeId, (tx) => tx.select().from(checkoutView).where(eq(checkoutView.offerId, s.offerId)));
    expect(rows).toHaveLength(31);
    // Só as ações do dono no seed (produto, oferta, chave Pix) estão auditadas; nada de checkout.view.
    const actions = (await withStore(s.storeId, (tx) => tx.select({ action: auditLog.action }).from(auditLog))).map((r) => r.action);
    expect(actions.filter((a) => a.startsWith("checkout."))).toEqual([]);
  });

  test("toque acima de 2 KB é descartado (não grava payload grande)", async () => {
    const s = await seed();
    expect(TOUCH_MAX_BYTES).toBe(2048);
    const big: Record<string, string> = {};
    for (let i = 0; i < 10; i++) big[`k${i}`] = "x".repeat(400);
    await runAction(checkoutViewAction, pub(s.storeId), { slug: s.slug, touch: { first: big, last: { utm_source: "ig" } }, clientIp: nextIp() });
    const [row] = await withStore(s.storeId, (tx) => tx.select().from(checkoutView).where(eq(checkoutView.offerId, s.offerId)));
    expect(row!.touch).toEqual({ first: null, last: null });
    const r = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { touch: { first: big, last: null } }));
    expect((await orderBy(s.storeId, r.publicId)).firstTouch).toBeNull();
  });
});

describe("cartão: bilhete do pedido (iframe do serviço isolado)", () => {
  const KEY = "k".repeat(32) + "-chave-do-bilhete-de-teste";

  test("startCheckout com a chave: cartão devolve um bilhete que verifyCardTicket aceita para aquele pedido; Pix não", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const card = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    expect(card.method).toBe("card_asaas");
    const o = await orderBy(s.storeId, card.publicId);
    expect(verifyCardTicket(card.cardTicket!, KEY)).toEqual({ storeId: s.storeId, orderId: o.id, publicId: card.publicId, totalCents: 990, maxInstallments: 1 });
    const pix = await startCheckout({ storeId: s.storeId }, startInput(s.slug), { cardTicketKey: KEY });
    expect(pix.method).toBe("pix_manual");
    expect("cardTicket" in pix).toBe(false);
  });

  test("bilhete leva o total do pedido (com bump) e as parcelas da oferta: o iframe recusa pagar se o checkout mostrar outro", async () => {
    const s = await seed({ asaas: createFakeAsaas(), maxInstallments: 4 });
    const card = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", withBump: true, customer: { cpf: CPF } }), { cardTicketKey: KEY });
    expect(verifyCardTicket(card.cardTicket!, KEY)).toMatchObject({ totalCents: 990 + 1710, maxInstallments: 4 });
    const renewed = await renewCardTicket({ storeId: s.storeId }, { publicId: card.publicId, ticket: card.cardTicket }, KEY);
    expect(verifyCardTicket(renewed, KEY)).toMatchObject({ publicId: card.publicId, totalCents: 990 + 1710, maxInstallments: 4 });
  });

  test("startCheckout sem a chave (serviço de cartão não configurado): cartão recusado sem criar pedido; Pix segue", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const before = await withStore(s.storeId, (tx) => tx.select({ id: orders.id }).from(orders));
    const e = await fail(startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } })));
    expect([e.code, e.message]).toEqual(["conflict", CARD_UNAVAILABLE_MESSAGE]);
    expect(await withStore(s.storeId, (tx) => tx.select({ id: orders.id }).from(orders))).toEqual(before);
    expect((await startCheckout({ storeId: s.storeId }, startInput(s.slug))).method).toBe("pix_manual");
  });

  test("checkoutMethods: sem o serviço de cartão, o checkout mostra só Pix; oferta só de cartão abre com o cartão (indisponível)", () => {
    expect(checkoutMethods(["pix", "card"], true)).toEqual(["pix", "card"]);
    expect(checkoutMethods(["pix", "card"], false)).toEqual(["pix"]);
    // Sem Pix para oferecer: a página abre com o cartão, e o checkout (sem iframe) mostra o aviso de indisponível.
    expect(checkoutMethods(["card"], false)).toEqual(["card"]);
    expect(checkoutMethods(["card", "boleto"], true)).toEqual(["card"]);
    expect(checkoutMethods([], false)).toEqual([]);
  });

  test("renewCardTicket: com o bilhete anterior (mesmo vencido), pedido de cartão pendente ganha bilhete novo do mesmo pedido", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const card = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    const later = new Date(Date.now() + CARD_TICKET_TTL_MS + 60_000); // o primeiro já venceu
    expect(verifyCardTicket(card.cardTicket!, KEY, later)).toBeNull();
    const ticket = await renewCardTicket({ storeId: s.storeId }, { publicId: card.publicId, ticket: card.cardTicket }, KEY, later);
    const o = await orderBy(s.storeId, card.publicId);
    expect(verifyCardTicket(ticket, KEY, later)).toEqual({ storeId: s.storeId, orderId: o.id, publicId: card.publicId, totalCents: 990, maxInstallments: 1 });
  });

  test("renewCardTicket: sem bilhete, bilhete de outro pedido, forjado ou vencido há mais de 24 h -> recusa", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const a = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    const b = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: a.publicId }, KEY))).code).toBe("invalid_input");
    // Bilhete do pedido B para renovar o A.
    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: a.publicId, ticket: b.cardTicket }, KEY))).code).toBe("forbidden");
    // Assinado com outra chave (forjado).
    const forged = issueCardTicket({ storeId: s.storeId, orderId: (await orderBy(s.storeId, a.publicId)).id, publicId: a.publicId, totalCents: 990, maxInstallments: 1 }, "f".repeat(64));
    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: a.publicId, ticket: forged }, KEY))).code).toBe("forbidden");
    // Íntegro, mesmo publicId, mas orderId de outro pedido (só possível com a chave): recusado pelo pedido.
    const mixed = issueCardTicket({ storeId: s.storeId, orderId: (await orderBy(s.storeId, b.publicId)).id, publicId: a.publicId, totalCents: 990, maxInstallments: 1 }, KEY);
    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: a.publicId, ticket: mixed }, KEY))).code).toBe("forbidden");
    const tooLate = new Date(Date.now() + CARD_TICKET_TTL_MS + CARD_TICKET_RENEW_WINDOW_MS + 60_000);
    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: a.publicId, ticket: a.cardTicket }, KEY, tooLate))).code).toBe("forbidden");
  });

  test("checkout.renewCardTicket confere o bilhete anterior dentro da ação (não só quem a chama)", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const a = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    const b = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    // A chave vem do servidor (`call.server`), fora da entrada da ação.
    const run = (ticket: unknown) => runAction(checkoutRenewCardTicket, { ...pub(s.storeId), server: { ticketKey: KEY } }, { publicId: a.publicId, ticket });
    expect((await fail(run(b.cardTicket))).code).toBe("forbidden");
    expect((await fail(run(undefined))).code).toBe("invalid_input");
    const ok = await run(a.cardTicket);
    expect(verifyCardTicket(ok.ticket, KEY)).toMatchObject({ storeId: s.storeId, publicId: a.publicId });
  });

  test("checkout.renewCardTicket: a chave (e a hora) ficam fora da entrada: nem no schema, nem no catálogo de ações", async () => {
    const shape = z.toJSONSchema(checkoutRenewCardTicket.input) as { properties?: Record<string, unknown> };
    expect(Object.keys(shape.properties ?? {}).sort()).toEqual(["publicId", "ticket"]);
    const listed = listActions().find((x) => x.name === "checkout.renewCardTicket")!;
    expect(JSON.stringify(listed.inputSchema)).not.toMatch(/ticketKey|nowMs/);
    // Uma chave escolhida por quem chama, na entrada, é descartada: sem a do servidor, nada é emitido.
    const s = await seed({ asaas: createFakeAsaas() });
    const a = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    const chosen = "c".repeat(64);
    const e = await runAction(checkoutRenewCardTicket, pub(s.storeId), { publicId: a.publicId, ticket: a.cardTicket, ticketKey: chosen, nowMs: 0 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ActionError);
  });

  test("renewCardTicket: pedido de outra loja, pago ou de Pix -> falha", async () => {
    const s = await seed({ asaas: createFakeAsaas() });
    const other = await seed({ asaas: createFakeAsaas() });
    const card = await startCheckout({ storeId: s.storeId }, startInput(s.slug, { method: "card", customer: { cpf: CPF } }), { cardTicketKey: KEY });
    // Bilhete da loja A apresentado no host da loja B: recusado antes do pedido.
    expect((await fail(renewCardTicket({ storeId: other.storeId }, { publicId: card.publicId, ticket: card.cardTicket }, KEY))).code).toBe("forbidden");
    // Bilhete "da loja B" para o pedido da A (só com a chave): o pedido não aparece pela RLS.
    const crossStore = issueCardTicket({ storeId: other.storeId, orderId: (await orderBy(s.storeId, card.publicId)).id, publicId: card.publicId, totalCents: 990, maxInstallments: 1 }, KEY);
    expect((await fail(renewCardTicket({ storeId: other.storeId }, { publicId: card.publicId, ticket: crossStore }, KEY))).code).toBe("not_found");

    // Pix: nunca tem bilhete; com um bilhete íntegro do pedido Pix (só com a chave), a ação recusa pelo método.
    const pix = await startCheckout({ storeId: s.storeId }, startInput(s.slug), { cardTicketKey: KEY });
    const pixTicket = issueCardTicket({ storeId: s.storeId, orderId: (await orderBy(s.storeId, pix.publicId)).id, publicId: pix.publicId, totalCents: 990, maxInstallments: 1 }, KEY);
    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: pix.publicId, ticket: pixTicket }, KEY))).code).toBe("conflict");

    await t.ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.publicId, card.publicId));
    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: card.publicId, ticket: card.cardTicket }, KEY))).code).toBe("conflict");

    expect((await fail(renewCardTicket({ storeId: s.storeId }, { publicId: "../x y", ticket: card.cardTicket }, KEY))).code).toBe("invalid_input");
  });
});

// ---- Oferta com N produtos: rateio, ordem e produto apagado -------------------------------------------------------

/** Loja com Pix manual e `n` produtos semeados (nomes "PDF 1".."PDF n"). */
async function seedCatalog(n: number) {
  const s = await seed({ bump: false });
  const products: { id: string; name: string }[] = [];
  for (let i = 1; i <= n; i++) products.push({ name: `PDF ${i}`, ...(await seedProduct(s.storeId, `PDF ${i}`)) });
  return { storeId: s.storeId, products };
}

type KitOpts = { name?: string; main: string[]; priceCents: number; bump?: { ids: string[]; priceCents: number; label?: string } };
async function kitOffer(storeId: string, k: KitOpts) {
  const slug = `k-${Math.random().toString(36).slice(2, 10)}`;
  const o = await runAction(createOffer, { storeId, actor: owner, origin: "panel" as const }, {
    slug,
    name: k.name ?? "Almanaque Completo",
    productIds: k.main,
    priceCents: k.priceCents,
    methods: ["pix", "card"],
    pixMode: "manual",
    ...(k.bump ? { bump: { productIds: k.bump.ids, priceCents: k.bump.priceCents, label: k.bump.label ?? (k.bump.ids.length > 1 ? "Kits extras" : null) } } : {}),
  });
  return { slug, offerId: o.id };
}

const itemsOf = (storeId: string, orderId: string) =>
  withStore(storeId, (tx) =>
    tx
      .select({ productId: orderItem.productId, kind: orderItem.kind, position: orderItem.position, priceCents: orderItem.priceCents })
      .from(orderItem)
      .where(eq(orderItem.orderId, orderId))
      .orderBy(desc(orderItem.kind), asc(orderItem.position)),
  );

const sysCtx = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "system" }, origin: "system", tx });
const directOrder = (storeId: string, offerId: string, withBump: boolean, method: Method = "pix_manual") =>
  withStore(storeId, (tx) =>
    createOrder(sysCtx(storeId, tx), {
      offerId,
      withBump,
      method,
      customer: { name: "Maria Souza", email: email(), phone: "11987654321", ...(method === "pix_manual" ? {} : { cpf: CPF }) },
      touch: { first: null, last: null },
      clientIp: nextIp(),
      userAgent: "bun-test",
    }),
  );

const BUMP_GONE = "O acréscimo não está mais disponível. Atualize a página.";

describe("pedido com N itens: rateio em centavos", () => {
  test("Completo (6 principais) por R$ 27,00: 6 itens de 450 na ordem da oferta, soma 2.700", async () => {
    const c = await seedCatalog(6);
    const ids = c.products.map((p) => p.id);
    const k = await kitOffer(c.storeId, { main: ids, priceCents: 2700 });
    const r = await runAction(checkoutStart, pub(c.storeId), startInput(k.slug));
    const o = await orderBy(c.storeId, r.publicId);
    expect(o.totalCents).toBe(2700);
    expect(o.hasBump).toBe(false);
    const items = await itemsOf(c.storeId, o.id);
    expect(items).toEqual(ids.map((productId, position) => ({ productId, kind: "main", position, priceCents: 450 })));
  });

  test("Almanaque (990) + bump de 5 produtos (1.710): 1 item de 990 e 5 de 342; sem o bump, só 1 item", async () => {
    const c = await seedCatalog(6);
    const [main, ...kits] = c.products.map((p) => p.id);
    const k = await kitOffer(c.storeId, { name: "Almanaque", main: [main!], priceCents: 990, bump: { ids: kits, priceCents: 1710, label: "5 Kits Extras" } });
    const withBump = await orderBy(c.storeId, (await runAction(checkoutStart, pub(c.storeId), startInput(k.slug, { withBump: true }))).publicId);
    expect(withBump.totalCents).toBe(2700);
    expect(withBump.hasBump).toBe(true);
    expect(await itemsOf(c.storeId, withBump.id)).toEqual([
      { productId: main!, kind: "main", position: 0, priceCents: 990 },
      ...kits.map((productId, position) => ({ productId, kind: "bump", position, priceCents: 342 })),
    ]);
    const noBump = await orderBy(c.storeId, (await runAction(checkoutStart, pub(c.storeId), startInput(k.slug))).publicId);
    expect(noBump.totalCents).toBe(990);
    expect(await itemsOf(c.storeId, noBump.id)).toEqual([{ productId: main!, kind: "main", position: 0, priceCents: 990 }]);
  });

  test("total com sobra: a sobra fica no primeiro item do grupo (1.000 em 3 = 334, 333, 333)", async () => {
    const c = await seedCatalog(3);
    const k = await kitOffer(c.storeId, { main: c.products.map((p) => p.id), priceCents: 1000 });
    const o = await directOrder(c.storeId, k.offerId, false);
    expect((await itemsOf(c.storeId, o.id)).map((i) => i.priceCents)).toEqual([334, 333, 333]);
  });

  test(
    "propriedade: 1 a 20 itens por grupo, com e sem bump, Pix manual e cartão: soma dos itens = total_cents",
    async () => {
      const c = await seedCatalog(40);
      const ids = c.products.map((p) => p.id);
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 0, max: 20 }),
          fc.integer({ min: 1, max: 500_000 }),
          fc.integer({ min: 1, max: 500_000 }),
          fc.boolean(),
          fc.constantFrom<Method>("pix_manual", "card_asaas"),
          async (nMain, nBump, price, bumpPrice, withBump, method) => {
            const k = await kitOffer(c.storeId, {
              main: ids.slice(0, nMain),
              priceCents: price,
              ...(nBump > 0 ? { bump: { ids: ids.slice(20, 20 + nBump), priceCents: bumpPrice } } : {}),
            });
            const bumped = withBump && nBump > 0;
            const o = await directOrder(c.storeId, k.offerId, bumped, method);
            const items = await itemsOf(c.storeId, o.id);
            expect(o.totalCents).toBe(price + (bumped ? bumpPrice : 0));
            expect(items.reduce((sum, i) => sum + i.priceCents, 0)).toBe(o.totalCents);
            expect(items.filter((i) => i.kind === "main")).toHaveLength(nMain);
            expect(items.filter((i) => i.kind === "bump")).toHaveLength(bumped ? nBump : 0);
            for (const i of items) expect(Number.isInteger(i.priceCents) && i.priceCents >= 0).toBe(true);
            if (method === "pix_manual") {
              // O valor único do Pix manual não entra no rateio: os itens somam o total, não o valor a pagar.
              expect(o.manualAmountCents!).toBeGreaterThan(o.totalCents);
              expect(o.manualAmountCents!).toBeLessThanOrEqual(o.totalCents + 99);
            }
          },
        ),
        { numRuns: 25 },
      );
    },
    HEAVY_TEST_MS * 3,
  );

  test("reordenar ou trocar os produtos da oferta depois do pedido não muda os itens do pedido", async () => {
    const c = await seedCatalog(5);
    const ids = c.products.map((p) => p.id);
    const k = await kitOffer(c.storeId, { main: ids.slice(0, 3), priceCents: 1000 });
    const before = await directOrder(c.storeId, k.offerId, false);
    const snapshot = await itemsOf(c.storeId, before.id);
    const call = { storeId: c.storeId, actor: owner, origin: "panel" as const };
    await runAction(setOfferProducts, call, { id: k.offerId, productIds: [ids[2]!, ids[0]!, ids[1]!], bump: null });
    expect(await itemsOf(c.storeId, before.id)).toEqual(snapshot);
    await runAction(setOfferProducts, call, { id: k.offerId, productIds: [ids[3]!, ids[4]!], bump: null });
    expect(await itemsOf(c.storeId, before.id)).toEqual(snapshot);
    // Pedido novo segue a lista atual.
    const after = await directOrder(c.storeId, k.offerId, false);
    expect((await itemsOf(c.storeId, after.id)).map((i) => [i.productId, i.position, i.priceCents])).toEqual([
      [ids[3]!, 0, 500],
      [ids[4]!, 1, 500],
    ]);
  });

  test("qualquer principal apagado: a oferta não vende (not_found); bump marcado e indisponível: conflict e nenhum pedido (R4)", async () => {
    const c = await seedCatalog(6);
    const ids = c.products.map((p) => p.id);
    const k = await kitOffer(c.storeId, { main: ids.slice(0, 3), priceCents: 2700, bump: { ids: ids.slice(3), priceCents: 1710 } });
    const countOrders = async () => (await withStore(c.storeId, (tx) => tx.select({ id: orders.id }).from(orders))).length;
    // Apaga o 3º produto do bump (não o 1º): bump marcado -> recusa; sem o bump o pedido sai normal.
    await t.ownerDb.update(product).set({ deletedAt: new Date() }).where(eq(product.id, ids[5]!));
    const e1 = await fail(runAction(checkoutStart, pub(c.storeId), startInput(k.slug, { withBump: true })));
    expect([e1.code, e1.message]).toEqual(["conflict", BUMP_GONE]);
    expect(await countOrders()).toBe(0);
    const ok = await orderBy(c.storeId, (await runAction(checkoutStart, pub(c.storeId), startInput(k.slug))).publicId);
    expect([ok.hasBump, ok.totalCents]).toEqual([false, 2700]);
    // Apaga o 2º principal (não o 1º).
    await t.ownerDb.update(product).set({ deletedAt: new Date() }).where(eq(product.id, ids[1]!));
    const e = await fail(runAction(checkoutStart, pub(c.storeId), startInput(k.slug)));
    expect(e.code).toBe("not_found");
    expect(await countOrders()).toBe(1);
  });

  test("bump retirado da oferta depois de a página carregar: bump marcado -> conflict, nenhum pedido (R4)", async () => {
    const c = await seedCatalog(3);
    const ids = c.products.map((p) => p.id);
    const k = await kitOffer(c.storeId, { main: [ids[0]!], priceCents: 990, bump: { ids: ids.slice(1), priceCents: 1710 } });
    await runAction(setOfferProducts, { storeId: c.storeId, actor: owner, origin: "panel" as const }, { id: k.offerId, productIds: [ids[0]!], bump: null });
    const e = await fail(runAction(checkoutStart, pub(c.storeId), startInput(k.slug, { withBump: true })));
    expect([e.code, e.message]).toEqual(["conflict", BUMP_GONE]);
    expect(await withStore(c.storeId, (tx) => tx.select({ id: orders.id }).from(orders))).toHaveLength(0);
  });
});

describe("página do pedido: sem preço rateado", () => {
  test("Completo de 6: uma linha com o nome da oferta e o preço dela; nunca R$ 4,50", async () => {
    const c = await seedCatalog(6);
    const k = await kitOffer(c.storeId, { name: "Almanaque Completo", main: c.products.map((p) => p.id), priceCents: 2700 });
    const r = await runAction(checkoutStart, pub(c.storeId), startInput(k.slug));
    const view = (await getOrderPublic(c.storeId, r.publicId))!;
    expect(view.items).toEqual([{ name: "Almanaque Completo", priceCents: 2700 }]);
  });

  test("total com sobra (1.000 em 3): uma linha de R$ 10,00, nunca 3,34 / 3,33", async () => {
    const c = await seedCatalog(3);
    const k = await kitOffer(c.storeId, { name: "Trio", main: c.products.map((p) => p.id), priceCents: 1000 });
    const r = await runAction(checkoutStart, pub(c.storeId), startInput(k.slug));
    const view = (await getOrderPublic(c.storeId, r.publicId))!;
    expect(view.items).toEqual([{ name: "Trio", priceCents: 1000 }]);
    expect(JSON.stringify(view)).not.toMatch(/\b33[34]\b/);
  });

  test("1 principal + bump de 5: o principal e o rótulo do bump, cada um com o preço do grupo", async () => {
    const c = await seedCatalog(6);
    const [main, ...kits] = c.products.map((p) => p.id);
    const k = await kitOffer(c.storeId, { name: "Almanaque", main: [main!], priceCents: 990, bump: { ids: kits, priceCents: 1710, label: "5 Kits Extras" } });
    const r = await runAction(checkoutStart, pub(c.storeId), startInput(k.slug, { withBump: true }));
    const view = (await getOrderPublic(c.storeId, r.publicId))!;
    expect(view.items).toEqual([
      { name: "PDF 1", priceCents: 990 },
      { name: "5 Kits Extras", priceCents: 1710 },
    ]);
  });
});

describe("setProducts e checkout concorrentes na mesma oferta", () => {
  /** Espera (por condição, sem tempo fixo) até outra sessão deste banco ficar bloqueada numa trava, ou `done` virar true. */
  async function blockedOnLock(done: () => boolean): Promise<boolean> {
    for (let i = 0; i < 20_000; i++) {
      if (done()) return false;
      const [row] = (await t.ownerDb.execute(
        sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      )) as unknown as { n: number }[];
      if (row!.n > 0) return true;
    }
    return false;
  }

  async function setup() {
    const c = await seedCatalog(7);
    const ids = c.products.map((p) => p.id);
    const old = { main: ids.slice(0, 2), bump: [ids[2]!], bumpPrice: 1000 };
    const neu = { main: ids.slice(3, 6), bump: [ids[6]!, ids[2]!], bumpPrice: 2000 };
    const k = await kitOffer(c.storeId, { main: old.main, priceCents: 1200, bump: { ids: old.bump, priceCents: old.bumpPrice } });
    const setNew = (tx: Ctx["tx"]) =>
      setOfferProducts.run({ storeId: c.storeId, actor: owner, origin: "panel", tx }, { id: k.offerId, productIds: neu.main, bump: { productIds: neu.bump, priceCents: neu.bumpPrice, label: "Extras" } }, undefined, undefined);
    const shape = (s: typeof old) => [
      ...splitOf(1200, s.main).map(([productId, priceCents], position) => ({ productId, kind: "main", position, priceCents })),
      ...splitOf(s.bumpPrice, s.bump).map(([productId, priceCents], position) => ({ productId, kind: "bump", position, priceCents })),
    ];
    return { c, k, old, neu, setNew, oldItems: shape(old), newItems: shape(neu) };
  }
  const splitOf = (total: number, ids: string[]) => ids.map((id, i) => [id, Math.floor(total / ids.length) + (i === 0 ? total % ids.length : 0)] as const);

  test("setProducts com a trava: o checkout espera e sai inteiro com a lista e o preço novos", async () => {
    const { c, k, setNew, newItems } = await setup();
    let order: Promise<{ id: string }> | undefined;
    let finished = false;
    await withStore(c.storeId, async (tx) => {
      await setNew(tx);
      order = directOrder(c.storeId, k.offerId, true, "card_asaas").finally(() => {
        finished = true;
      });
      // O pedido não pode terminar enquanto a lista nova não foi gravada (commit): fica bloqueado na trava da oferta.
      expect(await blockedOnLock(() => finished)).toBe(true);
    });
    const o = await order!;
    expect(await itemsOf(c.storeId, o.id)).toEqual(newItems);
  });

  test("pedido com a trava: o setProducts espera; o pedido sai inteiro com a lista e o preço antigos", async () => {
    const { c, k, setNew, oldItems } = await setup();
    let change: Promise<unknown> | undefined;
    let finished = false;
    const o = await withStore(c.storeId, async (tx) => {
      const created = await createOrder(sysCtx(c.storeId, tx), {
        offerId: k.offerId,
        withBump: true,
        method: "card_asaas",
        customer: { name: "Maria Souza", email: email(), phone: "11987654321", cpf: CPF },
        touch: { first: null, last: null },
        clientIp: nextIp(),
        userAgent: "bun-test",
      });
      change = withStore(c.storeId, (tx2) => setNew(tx2)).finally(() => {
        finished = true;
      });
      expect(await blockedOnLock(() => finished)).toBe(true);
      return created;
    });
    await change;
    expect(await itemsOf(c.storeId, o.id)).toEqual(oldItems);
  });

  test("corrida sem ordem combinada (10 rodadas): cada pedido é inteiro antigo ou inteiro novo", async () => {
    for (let i = 0; i < 10; i++) {
      const { c, k, setNew, oldItems, newItems } = await setup();
      const [, o] = await Promise.all([withStore(c.storeId, (tx) => setNew(tx)), directOrder(c.storeId, k.offerId, true, "card_asaas")]);
      const items = await itemsOf(c.storeId, o.id);
      expect([JSON.stringify(oldItems), JSON.stringify(newItems)]).toContain(JSON.stringify(items));
    }
  }, HEAVY_TEST_MS);
});

describe("checkout.start: converte o contato guardado antes da compra", () => {
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const leadsOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(checkoutLead).where(eq(checkoutLead.storeId, storeId)));

  /** Loja com captura ligada e uma segunda oferta (outra página da mesma loja). */
  async function seedCapture() {
    const s = await seed();
    await t.ownerDb.update(store).set({ leadCapture: true, privacyEmail: "privacidade@example.com" }).where(eq(store.id, s.storeId));
    const prod = await seedProduct(s.storeId, "Outro produto");
    const other = await runAction(createOffer, { storeId: s.storeId, actor: owner, origin: "panel" as const }, {
      slug: `o-${Math.random().toString(36).slice(2, 10)}`,
      name: "Outra oferta",
      productIds: [prod.id],
      priceCents: 1500,
      methods: ["pix"],
      pixMode: "manual",
    });
    return { ...s, otherSlug: other.slug };
  }
  const saveLead = (storeId: string, slug: string, input: { leadKey: string; email?: string; phone?: string }) =>
    runAction(checkoutSaveLead, pub(storeId), { slug, clientIp: nextIp(), ...input });

  test("pedido criado com o mesmo e-mail (outra oferta) converte o contato e zera e-mail e celular", async () => {
    const s = await seedCapture();
    const mail = email();
    const leadKey = randomUUID();
    await saveLead(s.storeId, s.slug, { leadKey, email: mail });
    await saveLead(s.storeId, s.slug, { leadKey, phone: "(11) 98765-4321" });
    const [before] = await leadsOf(s.storeId);
    expect(before).toMatchObject({ status: "open", email: mail, phone: "11987654321" });

    const out = await runAction(checkoutStart, pub(s.storeId), startInput(s.otherSlug, { customer: { email: mail.toUpperCase() } }));
    const rows = await leadsOf(s.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, status: "converted", orderId: out.orderId, email: null, phone: null, emailHash: sha(mail) });
  });

  test("pedido com a mesma leadKey e outro e-mail também converte", async () => {
    const s = await seedCapture();
    const leadKey = randomUUID();
    await saveLead(s.storeId, s.slug, { leadKey, email: email() });
    const out = await runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { leadKey }));
    expect((await leadsOf(s.storeId))[0]).toMatchObject({ status: "converted", orderId: out.orderId, email: null, phone: null });
  });

  test("contato de outra loja com o mesmo e-mail não muda; contato de outra pessoa na mesma loja também não", async () => {
    const a = await seedCapture();
    const b = await seedCapture();
    const mail = email();
    const keyB = randomUUID();
    await saveLead(b.storeId, b.slug, { leadKey: keyB, email: mail, phone: "(11) 98765-4321" });
    // mesma chave na loja de A (outra linha) e outro e-mail na mesma loja
    await saveLead(a.storeId, a.slug, { leadKey: randomUUID(), email: email() });

    await runAction(checkoutStart, pub(a.storeId), startInput(a.slug, { customer: { email: mail }, leadKey: keyB }));
    expect((await leadsOf(b.storeId))[0]).toMatchObject({ status: "open", email: mail, phone: "11987654321", orderId: null });
    expect((await leadsOf(a.storeId))[0]).toMatchObject({ status: "open", orderId: null });
    expect((await leadsOf(a.storeId))[0]!.email).not.toBeNull();
  });

  test("pedido recusado (acréscimo indisponível) não converte o contato", async () => {
    const s = await seedCapture();
    const mail = email();
    await saveLead(s.storeId, s.slug, { leadKey: randomUUID(), email: mail });
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.otherSlug, { withBump: true, customer: { email: mail } })));
    expect(e.code).toBe("conflict");
    expect((await leadsOf(s.storeId))[0]).toMatchObject({ status: "open", email: mail });
  });

  test("leadKey inválida na entrada: invalid_input", async () => {
    const s = await seedCapture();
    const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { leadKey: "nao-e-uuid" })));
    expect(e.code).toBe("invalid_input");
  });
});

describe("oferta de app no checkout (Task 5)", () => {
  async function seedApp() {
    const fake = createFakeAsaas();
    const { storeId } = await seedStore("PeticionaAqui");
    const call = { storeId, actor: owner, origin: "panel" as const };
    setAsaasFetchForTests(fake.fetch);
    await runAction(saveAsaas, call, { env: "sandbox", apiKey: fake.apiKey });
    await runAction(createOffer, call, {
      slug: "start-anual", name: "Plano Start anual", delivery: "app", appCode: "start_anual",
      productIds: [], priceCents: 49_700, methods: ["pix", "card"], pixMode: "asaas",
    });
    return { storeId, slug: "start-anual" };
  }

  test("checkoutOffer expõe delivery (app com o nome da oferta; download como antes)", async () => {
    const s = await seedApp();
    const v = checkoutOffer(await runAction(getPublicOffer, pub(s.storeId), { slug: s.slug }), ["pix", "card"]);
    expect(v).toMatchObject({ delivery: "app", productName: "Plano Start anual", includes: null, bump: null, maxInstallments: 1 });
    const d = await seed();
    expect(checkoutOffer(await runAction(getPublicOffer, pub(d.storeId), { slug: d.slug }), ["pix"]).delivery).toBe("download");
  });

  test("checkout.start numa oferta app (sem sessão do app) é invalid_input e não cria pedido", async () => {
    const s = await seedApp();
    for (const method of ["pix", "card"]) {
      const e = await fail(runAction(checkoutStart, pub(s.storeId), startInput(s.slug, { method, customer: { cpf: CPF } })));
      expect([e.code, e.message]).toEqual(["invalid_input", "Abra o pagamento pelo app"]);
    }
    expect(await withStore(s.storeId, (tx) => tx.select().from(orders))).toEqual([]);
  });
});
