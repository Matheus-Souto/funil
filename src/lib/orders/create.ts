import { and, eq, isNull, sql } from "drizzle-orm";
import { ActionError, type Ctx } from "@/lib/actions/core";
import { randomToken } from "@/lib/crypto";
import { isUniqueViolation, allocateManualAmount, ALLOCATION_ATTEMPTS } from "@/lib/payments/manual";
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
  /**
   * Pix manual esgotado (sem valor único livre) com Asaas conectado: permite `pix_asaas` numa oferta `pix_mode = 'manual'`.
   * Só `checkout.start` usa.
   */
  asaasPixFallback?: boolean;
};

/** Validade de um Pix pendente antes de expirar. Cartão não expira por tempo. */
export const PIX_TTL_MS = 24 * 60 * 60 * 1000;

function methodAllowed(method: Method, methods: string[], pixMode: string, asaasPixFallback = false): boolean {
  if (method === "card_asaas") return methods.includes("card");
  if (method === "pix_asaas" && asaasPixFallback) return methods.includes("pix");
  return methods.includes("pix") && pixMode === (method === "pix_manual" ? "manual" : "asaas");
}

/** Cria o pedido recalculando preços a partir do banco (nunca do cliente). Roda na transação de `ctx`. */
export async function createOrder(ctx: Ctx, input: CreateOrderInput): Promise<Order> {
  const [o] = await ctx.tx.select().from(offer).where(and(eq(offer.id, input.offerId), eq(offer.active, true)));
  if (!o) throw new ActionError("not_found", "Oferta não encontrada");
  if (!methodAllowed(input.method, o.methods, o.pixMode, input.asaasPixFallback)) throw new ActionError("invalid_input", "Método de pagamento indisponível nesta oferta");

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
  const cpf = input.customer.cpf ?? null;
  // Cliente é por e-mail: outro comprador com o mesmo e-mail NÃO sobrescreve nome, telefone nem CPF já gravados
  // (só preenche o CPF vazio). Os dados deste pedido ficam no retrato do pedido (buyer_*).
  const [cust] = await ctx.tx
    .insert(customer)
    .values({ storeId: ctx.storeId, email, name: input.customer.name, phone: input.customer.phone, cpf })
    .onConflictDoUpdate({
      target: [customer.storeId, customer.email],
      set: { cpf: sql`coalesce(${customer.cpf}, excluded.cpf)` },
    })
    .returning({ id: customer.id });

  const insertOrder = async (tx: Ctx["tx"], manual: { amountCents: number; expiresAt: Date } | null) => {
    const [row] = await tx
      .insert(orders)
      .values({
        storeId: ctx.storeId,
        publicId: randomToken(16),
        offerId: o.id,
        customerId: cust!.id,
        buyerName: input.customer.name,
        buyerPhone: input.customer.phone,
        buyerCpf: cpf,
        status: "pending",
        method: input.method,
        subtotalCents: total,
        totalCents: total,
        manualAmountCents: manual?.amountCents ?? null,
        hasBump: bump !== null,
        expiresAt: manual ? manual.expiresAt : input.method === "card_asaas" ? null : new Date(Date.now() + PIX_TTL_MS),
        firstTouch: input.touch.first,
        lastTouch: input.touch.last,
        ref: input.ref ?? null,
        fbc: input.fbc ?? null,
        fbp: input.fbp ?? null,
        clientIp: input.clientIp,
        userAgent: input.userAgent,
      })
      .returning();
    return row!;
  };

  let order: Order;
  if (input.method === "pix_manual") {
    // Valor único por pedido: o lock da alocação já serializa; o índice único parcial é a rede de segurança
    // (savepoint por tentativa, para a violação não abortar a transação do chamador).
    const skip: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const manual = await allocateManualAmount(ctx, total, { skip });
      try {
        order = await ctx.tx.transaction((sp) => insertOrder(sp as Ctx["tx"], manual));
        break;
      } catch (e) {
        if (!isUniqueViolation(e) || attempt >= ALLOCATION_ATTEMPTS) {
          throw isUniqueViolation(e) ? new ActionError("conflict", "pix_manual_exhausted") : e;
        }
        skip.push(manual.amountCents);
      }
    }
  } else {
    order = await insertOrder(ctx.tx, null);
  }
  await ctx.tx.insert(orderItem).values([
    { storeId: ctx.storeId, orderId: order.id, productId: o.productId, priceCents: o.priceCents, kind: "main" },
    ...(bump ? [{ storeId: ctx.storeId, orderId: order.id, productId: bump.productId, priceCents: bump.priceCents, kind: "bump" }] : []),
  ]);
  return order;
}
