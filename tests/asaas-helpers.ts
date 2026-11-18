import { VALID_PDF } from "./pdf-fixtures";
import { runAction, type Actor, type Ctx } from "@/lib/actions/core";
import { createOffer } from "@/lib/catalog/offers";
import { createProduct } from "@/lib/catalog/products";
import { withStore } from "@/lib/db/client";
import { createOrder } from "@/lib/orders/create";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { saveAsaas } from "@/lib/payments/asaas/pix";
import { seedStore } from "./db";
import { createFakeAsaas, type FakeAsaas } from "./fakes/asaas";

export const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const pdf = VALID_PDF;
export const ctxOf = (storeId: string, tx: Ctx["tx"]): Ctx => ({ storeId, actor: { kind: "public" }, origin: "public", tx });

/** Loja com Asaas conectado (via ação, contra o fake) e uma oferta Pix automático. */
export async function seedAsaasStore(fake: FakeAsaas, priceCents = 990, opts: { maxInstallments?: number } = {}) {
  setAsaasFetchForTests(fake.fetch);
  const { storeId } = await seedStore();
  const call = { storeId, actor: owner, origin: "panel" as const };
  const saved = await runAction(saveAsaas, call, { env: "sandbox", apiKey: fake.apiKey });
  const main = await runAction(createProduct, call, { name: "Principal", fileName: "a.pdf", file: pdf });
  const offer = await runAction(createOffer, call, {
    slug: `o-${Math.random().toString(36).slice(2, 10)}`,
    name: "Oferta",
    productId: main.id,
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

/** Pedido de cartão (Asaas). `cpf: null` cria o cliente sem CPF (o do titular é usado na cobrança). */
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
