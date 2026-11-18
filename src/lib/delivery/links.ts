// Links pessoais de download. Um link por item do pedido (validade de 30 dias e 5 downloads, contador e revogação no
// link); cada e-mail enviado acrescenta um token ao link (`download_token`, só o sha256). Os tokens de e-mails
// anteriores continuam valendo; o token novo só é gravado depois que o e-mail saiu (falha no envio não muda nada).
import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomToken, sha256 } from "@/lib/crypto";
import type { Tx } from "@/lib/db/client";
import { downloadLink, downloadToken, orderItem, product } from "@/lib/db/schema";
import { env } from "@/lib/env";

export const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DOWNLOADS = 5;
/** `randomToken()` = 32 bytes em base64url = 43 caracteres. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Origem pública da loja (onde `/d/<token>` resolve para ela): domínio próprio, `<slug>.PLATFORM_DOMAIN` no modo
 * multi, ou BASE_URL no modo single.
 */
export function storeBaseUrl(s: { domain: string | null; slug: string }, e: Pick<typeof env, "MODE" | "BASE_URL" | "PLATFORM_DOMAIN"> = env): string {
  if (s.domain) return `https://${s.domain}`;
  if (e.MODE === "multi" && e.PLATFORM_DOMAIN) return `https://${s.slug}.${e.PLATFORM_DOMAIN}`;
  return e.BASE_URL.replace(/\/+$/, "");
}

export interface DeliveryLink {
  linkId: string;
  productId: string;
  productName: string;
  kind: "main" | "bump";
  priceCents: number;
}

/**
 * Os links do pedido para uma entrega, na transação do chamador (que já conferiu que o pedido está pago): o link não
 * revogado de cada item é reaproveitado (mesmo esgotado ou vencido: o reenvio não ganha downloads; para isso existe o
 * renew); item sem link não revogado ganha um link novo (sem token ainda).
 */
export async function deliveryLinks(tx: Tx, order: { id: string; storeId: string }, now: Date = new Date()): Promise<DeliveryLink[]> {
  const items = await tx
    .select({ productId: orderItem.productId, kind: orderItem.kind, priceCents: orderItem.priceCents, name: product.name })
    .from(orderItem)
    .innerJoin(product, eq(product.id, orderItem.productId))
    .where(eq(orderItem.orderId, order.id));
  // Principal primeiro, depois o bump.
  items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "main" ? -1 : 1));
  const existing = await tx
    .select({ id: downloadLink.id, productId: downloadLink.productId })
    .from(downloadLink)
    .where(and(eq(downloadLink.orderId, order.id), isNull(downloadLink.revokedAt)))
    .orderBy(downloadLink.createdAt);
  const out: DeliveryLink[] = [];
  for (const item of items) {
    let linkId = existing.find((l) => l.productId === item.productId)?.id;
    if (!linkId) {
      const [row] = await tx
        .insert(downloadLink)
        .values({
          storeId: order.storeId,
          orderId: order.id,
          productId: item.productId,
          expiresAt: new Date(now.getTime() + LINK_TTL_MS),
          maxDownloads: MAX_DOWNLOADS,
        })
        .returning({ id: downloadLink.id });
      linkId = row!.id;
    }
    out.push({ linkId, productId: item.productId, productName: item.name, kind: item.kind as "main" | "bump", priceCents: item.priceCents });
  }
  return out;
}

export type TokenizedLink = DeliveryLink & { tokenHash: string; url: string };

/** Tokens novos (ainda não gravados) para os links: só em memória até o e-mail sair. */
export function newTokens(links: DeliveryLink[], baseUrl: string): TokenizedLink[] {
  return links.map((l) => {
    const token = randomToken();
    return { ...l, tokenHash: sha256(token), url: `${baseUrl}/d/${token}` };
  });
}

/** Grava os tokens de um e-mail que já foi enviado. */
export async function saveTokens(tx: Tx, storeId: string, links: TokenizedLink[]): Promise<void> {
  if (links.length === 0) return;
  await tx.insert(downloadToken).values(links.map((l) => ({ storeId, linkId: l.linkId, tokenHash: l.tokenHash })));
}

/**
 * Revoga os links ainda ativos do pedido. `order_status` (reembolso/contestação) fica só no link e o restore desfaz;
 * `renewed` (orders.resend com renew) revoga também todos os tokens desses links, para sempre.
 * Devolve os itens (pedido, produto) afetados.
 */
export async function revokeLinks(tx: Tx, orderId: string, reason: "order_status" | "renewed"): Promise<Array<{ id: string; productId: string }>> {
  const rows = await tx
    .update(downloadLink)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(downloadLink.orderId, orderId), isNull(downloadLink.revokedAt)))
    .returning({ id: downloadLink.id, productId: downloadLink.productId });
  if (reason === "renewed" && rows.length > 0) {
    await tx
      .update(downloadToken)
      .set({ revokedAt: new Date() })
      .where(and(isNull(downloadToken.revokedAt), inArray(downloadToken.linkId, rows.map((r) => r.id))));
  }
  return rows;
}

/** Desfaz só a revogação por status do pedido (a de renovação é definitiva). */
export async function restoreLinks(tx: Tx, orderId: string): Promise<number> {
  const rows = await tx
    .update(downloadLink)
    .set({ revokedAt: null, revokedReason: null })
    .where(and(eq(downloadLink.orderId, orderId), eq(downloadLink.revokedReason, "order_status")))
    .returning({ id: downloadLink.id });
  return rows.length;
}
