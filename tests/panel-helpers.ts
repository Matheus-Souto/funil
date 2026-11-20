// Semeadura direta (papel dono) para os testes do painel: loja, produtos, oferta, clientes e pedidos em qualquer estado.
import { randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { ownerDb } from "@/lib/db/client";
import { checkoutView, customer, offer, offerProduct, orderItem, orders, product } from "@/lib/db/schema";
import { seedStore } from "./db";

export const actorOf = (role: Role): Extract<Actor, { kind: "user" }> => ({ kind: "user", userId: randomUUID(), role });
export const panelCall = (storeId: string, role: Role = "owner") => ({ storeId, actor: actorOf(role), origin: "panel" as const });

export interface PanelStore {
  storeId: string;
  offerId: string;
  mainId: string;
  bumpId: string;
}

/** Loja com dois produtos e uma oferta de R$ 9,90 com bump de R$ 17,10. */
export async function seedPanelStore(name = "Loja"): Promise<PanelStore> {
  const { storeId } = await seedStore(name);
  const mk = (n: string) =>
    ownerDb
      .insert(product)
      .values({ storeId, name: n, fileKey: `products/${storeId}/${randomUUID()}.pdf`, fileName: `${n}.pdf`, fileSize: 1000 })
      .returning({ id: product.id });
  const [main] = await mk("Maná básica");
  const [bump] = await mk("Maná completa");
  const [o] = await ownerDb
    .insert(offer)
    .values({
      storeId,
      slug: `oferta-${randomBytes(4).toString("hex")}`,
      name: "Maná bíblico",
      productId: main!.id,
      priceCents: 990,
      methods: ["pix", "card"],
      pixMode: "manual",
      bumpProductId: bump!.id,
      bumpPriceCents: 1710,
    })
    .returning({ id: offer.id });
  // A lista da oferta (offer_product) é a fonte de quem lê os produtos; as colunas antigas acima saem na Task 5.
  await ownerDb.insert(offerProduct).values([
    { storeId, offerId: o!.id, productId: main!.id, kind: "main", position: 0 },
    { storeId, offerId: o!.id, productId: bump!.id, kind: "bump", position: 0 },
  ]);
  return { storeId, offerId: o!.id, mainId: main!.id, bumpId: bump!.id };
}

export interface SeedOrder {
  status?: "pending" | "paid" | "refunded" | "disputed" | "expired" | "declined";
  method?: "pix_manual" | "pix_asaas" | "card_asaas";
  totalCents?: number;
  paidAt?: Date | null;
  createdAt?: Date;
  utmSource?: string;
  utmCampaign?: string;
  ref?: string;
  email?: string;
  name?: string;
  cpf?: string | null;
  hasBump?: boolean;
  manualAmountCents?: number | null;
  refundRequestedAt?: Date | null;
}

/** Pedido com item principal (e bump, se `hasBump`). Datas e estados livres (sem passar pela máquina de estados). */
export async function seedOrder(s: PanelStore, o: SeedOrder = {}) {
  const email = o.email ?? `c.${randomBytes(4).toString("hex")}@exemplo.com`;
  const [c] = await ownerDb
    .insert(customer)
    .values({ storeId: s.storeId, email, name: o.name ?? "Carla Mendes", phone: "21998123044", cpf: o.cpf ?? null })
    .onConflictDoUpdate({ target: [customer.storeId, customer.email], set: { name: o.name ?? "Carla Mendes" } })
    .returning({ id: customer.id });
  const status = o.status ?? "paid";
  const total = o.totalCents ?? (o.hasBump ? 2700 : 990);
  const last = o.utmSource ? { utm_source: o.utmSource, ...(o.utmCampaign ? { utm_campaign: o.utmCampaign } : {}) } : null;
  const method = o.method ?? "pix_asaas";
  const [row] = await ownerDb
    .insert(orders)
    .values({
      storeId: s.storeId,
      publicId: randomBytes(12).toString("base64url"),
      offerId: s.offerId,
      customerId: c!.id,
      buyerName: o.name ?? "Carla Mendes",
      buyerPhone: "21998123044",
      buyerCpf: o.cpf ?? null,
      status,
      method,
      subtotalCents: total,
      totalCents: total,
      manualAmountCents: method === "pix_manual" ? (o.manualAmountCents ?? total + 3) : null,
      hasBump: o.hasBump ?? false,
      expiresAt: method === "card_asaas" ? null : new Date(Date.now() + 86_400_000),
      paidAt: o.paidAt !== undefined ? o.paidAt : status === "paid" || status === "refunded" || status === "disputed" ? new Date() : null,
      refundRequestedAt: o.refundRequestedAt ?? null,
      firstTouch: last,
      lastTouch: last,
      ref: o.ref ?? null,
      clientIp: "127.0.0.1",
      userAgent: "bun-test",
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning();
  await ownerDb.insert(orderItem).values([
    { storeId: s.storeId, orderId: row!.id, productId: s.mainId, priceCents: 990, kind: "main" },
    ...(o.hasBump ? [{ storeId: s.storeId, orderId: row!.id, productId: s.bumpId, priceCents: 1710, kind: "bump" }] : []),
  ]);
  return row!;
}

export async function seedViews(s: PanelStore, n: number, at: Date = new Date()): Promise<void> {
  if (n === 0) return;
  await ownerDb.insert(checkoutView).values(Array.from({ length: n }, () => ({ storeId: s.storeId, offerId: s.offerId, touch: null, at })));
}

/** `n` pedidos pagos de R$ 9,90 (um cliente só), criados a 1 min um do outro a partir de `start`: inserção em lote. */
export async function seedManyOrders(s: PanelStore, n: number, start: Date): Promise<void> {
  const [c] = await ownerDb
    .insert(customer)
    .values({ storeId: s.storeId, email: `lote.${randomBytes(4).toString("hex")}@exemplo.com`, name: "Lote", phone: "11999999999" })
    .returning({ id: customer.id });
  await ownerDb.insert(orders).values(
    Array.from({ length: n }, (_, i) => ({
      storeId: s.storeId,
      publicId: randomBytes(12).toString("base64url"),
      offerId: s.offerId,
      customerId: c!.id,
      buyerName: "Lote",
      status: "paid",
      method: "pix_asaas",
      subtotalCents: 990,
      totalCents: 990,
      paidAt: new Date(start.getTime() + i * 60_000),
      clientIp: "127.0.0.1",
      userAgent: "bun-test",
      createdAt: new Date(start.getTime() + i * 60_000),
    })),
  );
}
