import { and, eq, sql } from "drizzle-orm";
import { ActionError, type Ctx } from "@/lib/actions/core";
import { loadOfferProducts, type ProductRef } from "@/lib/catalog/offer-products";
import { couponInvalid } from "@/lib/coupons/apply";
import { computeDiscount, type CouponRule } from "@/lib/coupons/rules";
import { randomToken } from "@/lib/crypto";
import { coupon, customer, offer, orderItem, orders } from "@/lib/db/schema";
import { enqueue } from "@/lib/jobs";
import { convertLeads } from "@/lib/leads/capture";
import { splitCents } from "@/lib/money";
import { telegramSettings } from "@/lib/notify/telegram-connection";
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
  /** Chave do visitante (a mesma do `checkout.saveLead`): converte o contato guardado dessa página, mesmo com outro e-mail. */
  leadKey?: string;
  /**
   * Cupom já conferido por `resolveCoupon` na MESMA transação (o lock do cupom vale até o commit). O desconto é
   * recalculado aqui a partir do cupom no banco; desconto 0 (o piso de R$ 5,00 come tudo) -> cupom inválido.
   */
  coupon?: { id: string };
};

/** Bump marcado que não está mais disponível: o checkout mostra a mensagem como veio (ramo `conflict`). */
export const BUMP_UNAVAILABLE = "O acréscimo não está mais disponível. Atualize a página.";

/** Validade de um Pix pendente antes de expirar. Cartão não expira por tempo. */
export const PIX_TTL_MS = 24 * 60 * 60 * 1000;

function methodAllowed(method: Method, methods: string[], pixMode: string, asaasPixFallback = false): boolean {
  if (method === "card_asaas") return methods.includes("card");
  if (method === "pix_asaas" && asaasPixFallback) return methods.includes("pix");
  return methods.includes("pix") && pixMode === (method === "pix_manual" ? "manual" : "asaas");
}

type OfferRow = typeof offer.$inferSelect;

/**
 * Produtos do pedido de uma oferta: os principais e, com o bump marcado, os do bump com o preço dele. Mesmas recusas do
 * `createOrder` (a prévia do cupom usa esta função para calcular o mesmo total): principal apagado -> `not_found`; bump
 * marcado e indisponível -> `conflict` com `BUMP_UNAVAILABLE`.
 */
export async function orderParts(
  tx: Ctx["tx"],
  o: OfferRow,
  withBump: boolean,
): Promise<{ main: ProductRef[]; bump: { products: ProductRef[]; priceCents: number } | null }> {
  const list = (await loadOfferProducts(tx, [o.id])).get(o.id)!;
  const live = (ps: ProductRef[]) => ps.length > 0 && ps.every((p) => p.deletedAt === null);
  if (!live(list.main)) throw new ActionError("not_found", "Oferta não encontrada");
  if (!withBump) return { main: list.main, bump: null };
  if (!live(list.bump) || o.bumpPriceCents === null) throw new ActionError("conflict", BUMP_UNAVAILABLE);
  return { main: list.main, bump: { products: list.bump, priceCents: o.bumpPriceCents } };
}

/**
 * Cria o pedido recalculando preços a partir do banco (nunca do cliente). Roda na transação de `ctx`.
 * Um `order_item` por produto da oferta (`offer_product`), na ordem da oferta: os principais dividem o preço da oferta e
 * os do bump (se marcado) o preço do bump (`splitCents`: sobra no primeiro item do grupo), e a soma dá `total_cents`.
 * Com cupom: `subtotal` = principal + bump; o desconto do principal sai do grupo principal e o do bump do grupo do bump
 * (`splitCents` sobre o preço já descontado de cada grupo), então a soma dos itens continua igual a `total_cents`.
 * Nunca vende combo incompleto nem diferente do que o comprador viu: qualquer principal apagado -> a oferta não vende
 * (`not_found`); bump marcado e indisponível (retirado da oferta ou com qualquer produto apagado) -> `conflict` com
 * `BUMP_UNAVAILABLE` e nenhum pedido (Ruling R4: o comprador nunca paga outro valor nem leva outro combo).
 */
export async function createOrder(ctx: Ctx, input: CreateOrderInput): Promise<Order> {
  // FOR SHARE: espera um offers.setProducts em andamento (FOR UPDATE na mesma linha) e lê preço e lista do mesmo estado.
  const [o] = await ctx.tx.select().from(offer).where(and(eq(offer.id, input.offerId), eq(offer.active, true))).for("share");
  if (!o) throw new ActionError("not_found", "Oferta não encontrada");
  if (!methodAllowed(input.method, o.methods, o.pixMode, input.asaasPixFallback)) throw new ActionError("invalid_input", "Método de pagamento indisponível nesta oferta");

  const { main, bump } = await orderParts(ctx.tx, o, input.withBump);
  const subtotal = o.priceCents + (bump?.priceCents ?? 0);
  let discount = { discountCents: 0, mainDiscountCents: 0, bumpDiscountCents: 0 };
  let couponId: string | null = null;
  if (input.coupon) {
    const [c] = await ctx.tx.select().from(coupon).where(eq(coupon.id, input.coupon.id));
    if (!c) throw couponInvalid();
    discount = computeDiscount(
      { kind: c.kind as CouponRule["kind"], percentBp: c.percentBp, amountCents: c.amountCents, appliesTo: c.appliesTo as CouponRule["appliesTo"] },
      { mainCents: o.priceCents, bumpCents: bump?.priceCents ?? 0 },
    );
    // O banco exige cupom <-> desconto > 0: cupom que não desconta nada é tratado como inválido.
    if (discount.discountCents === 0) throw couponInvalid();
    couponId = c.id;
  }
  const total = subtotal - discount.discountCents;

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
        subtotalCents: subtotal,
        discountCents: discount.discountCents,
        couponId,
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
  // Soma dos grupos = (principal - desconto do principal) + (bump - desconto do bump) = total.
  await ctx.tx
    .insert(orderItem)
    .values([
      ...items("main", main, o.priceCents - discount.mainDiscountCents),
      ...(bump ? items("bump", bump.products, bump.priceCents - discount.bumpDiscountCents) : []),
    ]);
  // O contato guardado antes da compra (mesmo e-mail na loja ou mesma chave da página) vira "comprou" e perde e-mail e celular.
  await convertLeads(ctx.tx, ctx.storeId, { email, leadKey: input.leadKey, orderId: order.id });
  await enqueueTelegramNotices(ctx, order);
  return order;
}

/**
 * Avisos do Telegram da loja na criação do pedido (mesma transação), só para os eventos ligados agora (lê só a config
 * pública, sem abrir o token); o job confere de novo no envio. "Pix gerado" em pedido Pix; abandono agendado para
 * criado + prazo, com o prazo no payload (o vendedor pode mudá-lo depois).
 */
async function enqueueTelegramNotices(ctx: Ctx, order: Order): Promise<void> {
  const tg = await telegramSettings(ctx.tx, ctx.storeId);
  if (!tg) return;
  const notice = (payload: { event: "pix_generated" } | { event: "abandoned"; afterMinutes: number }, runAt?: Date) =>
    enqueue(ctx.tx, { storeId: ctx.storeId, type: "notify_telegram", payload: { ...payload, orderId: order.id }, runAt });
  if (tg.events.pixGenerated && (order.method === "pix_asaas" || order.method === "pix_manual")) await notice({ event: "pix_generated" });
  if (tg.events.abandoned) {
    const afterMinutes = tg.abandonAfterMinutes;
    await notice({ event: "abandoned", afterMinutes }, new Date(order.createdAt.getTime() + afterMinutes * 60_000));
  }
}
