import { and, eq, sql } from "drizzle-orm";
import { ActionError, type Ctx } from "@/lib/actions/core";
import { loadOfferProducts, type ProductRef } from "@/lib/catalog/offer-products";
import { randomToken } from "@/lib/crypto";
import { customer, offer, orderItem, orders } from "@/lib/db/schema";
import { splitCents } from "@/lib/money";
import { isUniqueViolation, allocateManualAmount, ALLOCATION_ATTEMPTS } from "@/lib/payments/manual";

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

/**
 * Cria o pedido recalculando preços a partir do banco (nunca do cliente). Roda na transação de `ctx`.
 * Um `order_item` por produto da oferta (`offer_product`), na ordem da oferta: os principais dividem o preço da oferta e
 * os do bump (se marcado) o preço do bump (`splitCents`: sobra no primeiro item do grupo), e a soma dá `total_cents`.
 * Nunca vende combo incompleto: qualquer principal apagado -> a oferta não vende; qualquer produto do bump apagado ->
 * o pedido sai sem o bump.
 */
export async function createOrder(ctx: Ctx, input: CreateOrderInput): Promise<Order> {
  // FOR SHARE: espera um offers.setProducts em andamento (FOR UPDATE na mesma linha) e lê preço e lista do mesmo estado.
  const [o] = await ctx.tx.select().from(offer).where(and(eq(offer.id, input.offerId), eq(offer.active, true))).for("share");
  if (!o) throw new ActionError("not_found", "Oferta não encontrada");
  if (!methodAllowed(input.method, o.methods, o.pixMode, input.asaasPixFallback)) throw new ActionError("invalid_input", "Método de pagamento indisponível nesta oferta");

  const list = (await loadOfferProducts(ctx.tx, [o.id])).get(o.id)!;
  const live = (ps: ProductRef[]) => ps.length > 0 && ps.every((p) => p.deletedAt === null);
  if (!live(list.main)) throw new ActionError("not_found", "Oferta não encontrada");
  let bump: { products: ProductRef[]; priceCents: number } | null = null;
  if (input.withBump) {
    if (list.bump.length === 0 || o.bumpPriceCents === null) throw new ActionError("invalid_input", "Esta oferta não tem order bump");
    // Produto do bump apagado: o checkout já esconde o bump; quem o marcou numa página antiga compra sem ele.
    if (live(list.bump)) bump = { products: list.bump, priceCents: o.bumpPriceCents };
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
  const items = (kind: "main" | "bump", products: ProductRef[], priceCents: number) => {
    const prices = splitCents(priceCents, products.length);
    return products.map((p, position) => ({ storeId: ctx.storeId, orderId: order.id, productId: p.id, priceCents: prices[position]!, kind, position }));
  };
  await ctx.tx.insert(orderItem).values([...items("main", list.main, o.priceCents), ...(bump ? items("bump", bump.products, bump.priceCents) : [])]);
  return order;
}
