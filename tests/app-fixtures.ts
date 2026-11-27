// Oferta, teste e pedido de app gravados direto no banco (papel dono), respeitando os checks da 0038. A criação do
// pedido de app pelo checkout (sessão `?s=`) é de outra tarefa; estes helpers só montam o estado que métricas e Meta
// leem. Dados fictícios (nada real).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { randomToken } from "@/lib/crypto";
import { ownerDb } from "@/lib/db/client";
import { appCheckoutSession, appTrial, customer, offer, orders } from "@/lib/db/schema";
import { mailboxHash, recoveryEmailHash } from "@/lib/recovery/rules";

/** Oferta `delivery = 'app'`: à vista, só Pix do Asaas ou cartão, sem produtos nem bump. */
export async function seedAppOffer(
  storeId: string,
  opts: { appCode?: string; active?: boolean; priceCents?: number } = {},
): Promise<{ id: string; slug: string; appCode: string }> {
  const appCode = opts.appCode ?? `app_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const slug = `app-${randomUUID().slice(0, 8)}`;
  const [row] = await ownerDb
    .insert(offer)
    .values({
      storeId,
      slug,
      name: "Plano anual",
      priceCents: opts.priceCents ?? 29_900,
      methods: ["pix", "card"],
      pixMode: "asaas",
      maxInstallments: 1,
      delivery: "app",
      appCode,
      active: opts.active ?? true,
    })
    .returning({ id: offer.id });
  return { id: row!.id, slug, appCode };
}

/** Registro de teste como `apps.registerTrial` grava (sem passar pela API: permite datas antigas). */
export async function seedAppTrial(
  storeId: string,
  opts: { account: string; startedAt?: Date; campaign?: string; fbc?: string; fbp?: string; email?: string },
): Promise<{ id: string }> {
  const id = randomUUID();
  const email = opts.email ?? `${opts.account}@exemplo.test`;
  await ownerDb.insert(appTrial).values({
    id,
    storeId,
    account: opts.account,
    emailHash: recoveryEmailHash(email),
    mailboxHash: mailboxHash(email),
    firstTouch: opts.campaign ? { utm_source: "fb", utm_campaign: opts.campaign } : null,
    fbc: opts.fbc ?? null,
    fbp: opts.fbp ?? null,
    eventId: `trial:${id}`,
    startedAt: opts.startedAt ?? new Date(),
  });
  return { id };
}

type Order = typeof orders.$inferSelect;

/**
 * Pedido de app com `app_account`, `app_session_id` e a sessão de pagamento (válida, apontando para o pedido), como o
 * checkout com `?s=` vai gravar. Padrão: pago agora, Pix do Asaas.
 */
export async function seedAppOrder(
  storeId: string,
  opts: {
    offerId: string;
    account: string;
    status?: "pending" | "paid" | "refunded" | "disputed" | "expired" | "declined";
    paidAt?: Date | null;
    totalCents?: number;
    email?: string;
    name?: string;
    phone?: string;
    fbc?: string;
    fbp?: string;
    clientIp?: string;
    userAgent?: string;
  },
): Promise<Order> {
  const email = opts.email ?? `${opts.account}@exemplo.test`;
  const name = opts.name ?? "Bia Teste";
  const phone = opts.phone ?? "11987654321";
  const status = opts.status ?? "paid";
  await ownerDb.insert(customer).values({ storeId, email, name, phone }).onConflictDoNothing();
  const [c] = await ownerDb.select({ id: customer.id }).from(customer).where(and(eq(customer.storeId, storeId), eq(customer.email, email)));
  const [s] = await ownerDb
    .insert(appCheckoutSession)
    .values({
      storeId,
      offerId: opts.offerId,
      account: opts.account,
      buyerName: name,
      buyerEmail: email,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    .returning({ id: appCheckoutSession.id });
  const total = opts.totalCents ?? 29_900;
  const paidAt = opts.paidAt !== undefined ? opts.paidAt : status === "pending" || status === "expired" || status === "declined" ? null : new Date();
  const [o] = await ownerDb
    .insert(orders)
    .values({
      storeId,
      publicId: randomToken(16),
      offerId: opts.offerId,
      customerId: c!.id,
      buyerName: name,
      buyerPhone: phone,
      status,
      method: "pix_asaas",
      subtotalCents: total,
      totalCents: total,
      appAccount: opts.account,
      appSessionId: s!.id,
      paidAt,
      fbc: opts.fbc ?? null,
      fbp: opts.fbp ?? null,
      clientIp: opts.clientIp ?? "203.0.113.9",
      userAgent: opts.userAgent ?? "Mozilla/5.0 app",
    })
    .returning();
  await ownerDb.update(appCheckoutSession).set({ orderId: o!.id }).where(eq(appCheckoutSession.id, s!.id));
  return o!;
}
