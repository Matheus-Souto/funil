// Links pessoais de download. O token é aleatório (`randomToken`, 256 bits) e só o sha256 dele vai para o banco: o
// link existe apenas no e-mail. Um link por item do pedido; validade de 30 dias e 5 downloads.
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { randomToken, sha256 } from "@/lib/crypto";
import type { Tx } from "@/lib/db/client";
import { downloadLink, orderItem, product } from "@/lib/db/schema";
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

export interface IssuedLink {
  productId: string;
  productName: string;
  kind: "main" | "bump";
  priceCents: number;
  url: string;
}

/**
 * Um link por item do pedido, na transação do chamador (que já conferiu que o pedido está pago).
 * Link ainda utilizável do item (não revogado, dentro da validade e com downloads sobrando) é REAPROVEITADO: a linha
 * fica (mesma validade e mesmo contador), só o token é trocado (o banco não tem o token antigo para remontar o link;
 * o link de um e-mail anterior deixa de valer). Sem link utilizável, cria um novo.
 */
export async function issueDownloadLinks(
  tx: Tx,
  order: { id: string; storeId: string },
  opts: { baseUrl: string; now?: Date },
): Promise<IssuedLink[]> {
  const now = opts.now ?? new Date();
  const items = await tx
    .select({ productId: orderItem.productId, kind: orderItem.kind, priceCents: orderItem.priceCents, name: product.name })
    .from(orderItem)
    .innerJoin(product, eq(product.id, orderItem.productId))
    .where(eq(orderItem.orderId, order.id));
  // Principal primeiro, depois o bump.
  items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "main" ? -1 : 1));

  const usable = await tx
    .select({ id: downloadLink.id, productId: downloadLink.productId })
    .from(downloadLink)
    .where(
      and(
        eq(downloadLink.orderId, order.id),
        isNull(downloadLink.revokedAt),
        gt(downloadLink.expiresAt, now),
        lt(downloadLink.downloads, downloadLink.maxDownloads),
      ),
    )
    .orderBy(asc(downloadLink.createdAt));

  const out: IssuedLink[] = [];
  for (const item of items) {
    const token = randomToken();
    const tokenHash = sha256(token);
    const reuse = usable.find((l) => l.productId === item.productId);
    if (reuse) {
      await tx.update(downloadLink).set({ tokenHash }).where(eq(downloadLink.id, reuse.id));
    } else {
      await tx.insert(downloadLink).values({
        storeId: order.storeId,
        orderId: order.id,
        productId: item.productId,
        tokenHash,
        expiresAt: new Date(now.getTime() + LINK_TTL_MS),
        maxDownloads: MAX_DOWNLOADS,
      });
    }
    out.push({ productId: item.productId, productName: item.name, kind: item.kind as "main" | "bump", priceCents: item.priceCents, url: `${opts.baseUrl}/d/${token}` });
  }
  return out;
}

/** Revoga os links ainda ativos do pedido (`order_status`: reembolso/contestação; `renewed`: reenvio com renew). */
export async function revokeLinks(tx: Tx, orderId: string, reason: "order_status" | "renewed"): Promise<number> {
  const rows = await tx
    .update(downloadLink)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(downloadLink.orderId, orderId), isNull(downloadLink.revokedAt)))
    .returning({ id: downloadLink.id });
  return rows.length;
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
