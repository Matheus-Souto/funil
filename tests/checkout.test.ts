import { VALID_PDF } from "./pdf-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { createProduct } from "@/lib/catalog/products";
import { withStore } from "@/lib/db/client";
import { auditLog, checkoutView, customer, orderItem, orders } from "@/lib/db/schema";
import {
  CHECKOUT_LIMIT_MESSAGE,
  PIX_UNAVAILABLE_MESSAGE,
  checkoutStart,
  checkoutView as checkoutViewAction,
  getOrderPublic,
  handleOrderStatus,
  startCheckout,
} from "@/lib/checkout";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { payWithCard } from "@/lib/payments/asaas/card";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { savePixManual } from "@/lib/payments/manual";
import { resetCardFingerprintsForTests } from "@/lib/payments/ratelimit";
import { createTestDb, seedStore, type TestDb } from "./db";
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
  const main = await runAction(createProduct, call, { name: "Maná básica", fileName: "a.pdf", file: VALID_PDF });
  const extra = await runAction(createProduct, call, { name: "Maná completa", fileName: "b.pdf", file: VALID_PDF });
  const slug = `o-${Math.random().toString(36).slice(2, 10)}`;
  const offer = await runAction(createOffer, call, {
    slug,
    name: "Maná bíblico para crianças",
    productId: main.id,
    priceCents: opts.priceCents ?? 990,
    methods: opts.methods ?? ["pix", "card"],
    pixMode: opts.pixMode ?? "manual",
    ...(opts.bump === false ? {} : { bumpProductId: extra.id, bumpPriceCents: 1710, bumpLabel: "Quero a versão completa" }),
    thankYouText: "Que essas histórias tragam momentos especiais em família!",
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
    await runAction(checkoutViewAction, pub(s.storeId), { slug: s.slug, touch: { first: null, last: { utm_source: "ig" } } });
    const rows = await withStore(s.storeId, (tx) => tx.select().from(checkoutView).where(eq(checkoutView.offerId, s.offerId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.touch).toEqual({ first: null, last: { utm_source: "ig" } });
  });
});
