import { and, eq, isNull } from "drizzle-orm";
import { ActionError, type Ctx } from "@/lib/actions/core";
import { randomToken } from "@/lib/crypto";
import { customer, offer, orderItem, orders, product } from "@/lib/db/schema";

export type Method = "pix_manual" | "pix_asaas" | "card_asaas";
export type Touch = { first: Record<string, string> | null; last: Record<string, string> | null };
export type Order = typeof orders.$inferSelect;

export type CreateOrderInput = {
  offerId: string;
  withBump: boolean;
  method: Method;
  customer: { name: string; email: string; phone: string; cpf?: string };
  touch: Touch;
  ref?: string;
  fbc?: string;
  fbp?: string;
  clientIp: string;
  userAgent: string;
};

/** Validade de um Pix pendente antes de expirar. Cartão não expira por tempo. */
export const PIX_TTL_MS = 24 * 60 * 60 * 1000;

function methodAllowed(method: Method, methods: string[], pixMode: string): boolean {
  if (method === "card_asaas") return methods.includes("card");
  return methods.includes("pix") && pixMode === (method === "pix_manual" ? "manual" : "asaas");
}

/** Cria o pedido recalculando preços a partir do banco (nunca do cliente). Roda na transação de `ctx`. */
export async function createOrder(ctx: Ctx, input: CreateOrderInput): Promise<Order> {
  const [o] = await ctx.tx.select().from(offer).where(and(eq(offer.id, input.offerId), eq(offer.active, true)));
  if (!o) throw new ActionError("not_found", "Oferta não encontrada");
  if (!methodAllowed(input.method, o.methods, o.pixMode)) throw new ActionError("invalid_input", "Método de pagamento indisponível nesta oferta");

  const live = async (id: string) => {
    const [p] = await ctx.tx.select({ id: product.id }).from(product).where(and(eq(product.id, id), isNull(product.deletedAt)));
    return p !== undefined;
  };
  if (!(await live(o.productId))) throw new ActionError("not_found", "Oferta não encontrada");
  let bump: { productId: string; priceCents: number } | null = null;
  if (input.withBump) {
    if (!o.bumpProductId || o.bumpPriceCents === null || !(await live(o.bumpProductId))) {
      throw new ActionError("invalid_input", "Esta oferta não tem order bump");
    }
    bump = { productId: o.bumpProductId, priceCents: o.bumpPriceCents };
  }
  const total = o.priceCents + (bump?.priceCents ?? 0);

  const email = input.customer.email.trim().toLowerCase();
  const [cust] = await ctx.tx
    .insert(customer)
    .values({ storeId: ctx.storeId, email, name: input.customer.name, phone: input.customer.phone, cpf: input.customer.cpf ?? null })
    .onConflictDoUpdate({
      target: [customer.storeId, customer.email],
      set: { name: input.customer.name, phone: input.customer.phone, ...(input.customer.cpf ? { cpf: input.customer.cpf } : {}) },
    })
    .returning({ id: customer.id });

  const [order] = await ctx.tx
    .insert(orders)
    .values({
      storeId: ctx.storeId,
      publicId: randomToken(16),
      offerId: o.id,
      customerId: cust!.id,
      status: "pending",
      method: input.method,
      subtotalCents: total,
      totalCents: total,
      hasBump: bump !== null,
      expiresAt: input.method === "card_asaas" ? null : new Date(Date.now() + PIX_TTL_MS),
      firstTouch: input.touch.first,
      lastTouch: input.touch.last,
      ref: input.ref ?? null,
      fbc: input.fbc ?? null,
      fbp: input.fbp ?? null,
      clientIp: input.clientIp,
      userAgent: input.userAgent,
    })
    .returning();
  await ctx.tx.insert(orderItem).values([
    { storeId: ctx.storeId, orderId: order!.id, productId: o.productId, priceCents: o.priceCents, kind: "main" },
    ...(bump ? [{ storeId: ctx.storeId, orderId: order!.id, productId: bump.productId, priceCents: bump.priceCents, kind: "bump" }] : []),
  ]);
  return order!;
}
