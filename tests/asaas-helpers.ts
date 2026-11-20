import { runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { withStore } from "@/lib/db/client";
import { runDueJobs } from "@/lib/jobs";
import { getHandlers } from "@/lib/jobs/handlers";
import { createOrder } from "@/lib/orders/create";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { seedProduct, seedStore } from "./db";
import { createFakeAsaas, type FakeAsaas } from "./fakes/asaas";

export const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
export const ctxOf = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "public" }, origin: "public", tx });

/** Loja com Asaas conectado (via ação, contra o fake) e uma oferta Pix automático. */
export async function seedAsaasStore(fake: FakeAsaas, priceCents = 990, opts: { maxInstallments?: number } = {}) {
  setAsaasFetchForTests(fake.fetch);
  const { storeId } = await seedStore();
  const call = { storeId, actor: owner, origin: "panel" as const };
  const saved = await runAction(saveAsaas, call, { env: "sandbox", apiKey: fake.apiKey });
  const main = await seedProduct(storeId, "Principal");
  const offer = await runAction(createOffer, call, {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Oferta",
    productIds: [main.id],
    priceCents,
    methods: ["pix", "card"],
    pixMode: "asaas",
    maxInstallments: opts.maxInstallments ?? 1,
  });
  return { storeId, offerId: offer.id, webhookToken: saved.webhookToken };
}

export const newAsaasOrder = (storeId: string, offerId: string, email = "ana@example.com") =>
  withStore(storeId, (tx) =>
    createOrder(ctxOf(storeId, tx), {
      offerId,
      withBump: false,
      method: "pix_asaas",
      customer: { name: "Ana", email, phone: "11999999999", cpf: "52998224725" },
      touch: { first: null, last: null },
      clientIp: "127.0.0.1",
      userAgent: "bun-test",
    }),
  );

export { createFakeAsaas };

/** Pedido de cartão (Asaas). `cpf: null` cria pedido e cliente sem CPF do comprador (pedido antigo: o cartão é recusado antes do Asaas). */
export const newCardOrder = (storeId: string, offerId: string, email: string, cpf: string | null = "52998224725") =>
  withStore(storeId, (tx) =>
    createOrder(ctxOf(storeId, tx), {
      offerId,
      withBump: false,
      method: "card_asaas",
      customer: { name: "Bia", email, phone: "11988887777", ...(cpf ? { cpf } : {}) },
      touch: { first: null, last: null },
      clientIp: "127.0.0.1",
      userAgent: "bun-test",
    }),
  );

/**
 * Roda os jobs `refund_order` vencidos com o handler registrado no módulo de handlers (como o worker faz).
 * Os demais tipos não são tocados; repete até não haver refund_order vencido.
 */
export async function runRefundJobs(now: Date = new Date()): Promise<void> {
  const handler = getHandlers().refund_order;
  if (!handler) throw new Error("refund_order não está registrado em getHandlers()");
  // Só refund_order: os demais jobs acumulados no banco do arquivo (entregas, avisos...) não são reivindicados à toa.
  for (let i = 0; i < 100 && (await runDueJobs({ refund_order: handler }, 50, now, { types: ["refund_order"] })) > 0; i++);
}
