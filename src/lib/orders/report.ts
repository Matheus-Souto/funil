// Relatório de pedidos pagos para agentes (MCP): só o que serve para analisar vendas, nunca dado pessoal do comprador
// (nome, e-mail, telefone, CPF, IP, user agent, fbc e fbp ficam de fora; as origens passam por lista branca).
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { offer, orderItem, orders, product } from "@/lib/db/schema";
import { orderCode } from "@/lib/format";
import { spDayKey } from "@/lib/metrics";
import { itemOrder } from "./items";

const DAY_MS = 86_400_000;
const MAX_DAYS = 92;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const TOUCH_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src"] as const;
const LABEL_RE = /^[A-Za-z0-9_.:+-]{1,100}$/;

/** paid_at com microssegundos (o Date do JS só tem milissegundos e o cursor repetiria o pedido). */
const paidAtIso = sql<string>`to_char(${orders.paidAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Cursor decodificado, ou null se o formato ou a data forem inválidos (ex.: mês 99). */
function parseCursor(cursor: string): { at: string; id: string } | null {
  const m = CURSOR_RE.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!m) return null;
  // Date.parse confere a data e a hora (milissegundos); os 3 dígitos de microssegundos são só números.
  if (Number.isNaN(Date.parse(m[1]!.slice(0, 23) + "Z"))) return null;
  return { at: m[1]!, id: m[2]! };
}

/** Texto livre do visitante (UTM, src, ref) só passa se parecer um rótulo: nada de e-mail, telefone ou frase. */
function safeLabel(v: unknown): string | null {
  if (typeof v !== "string" || !LABEL_RE.test(v) || /\d{8,}/.test(v)) return null;
  return v;
}

const input = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .refine((r) => r.from.getTime() < r.to.getTime(), { message: "O início do período deve ser antes do fim", path: ["to"] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= MAX_DAYS * DAY_MS, { message: `O período vai até ${MAX_DAYS} dias`, path: ["to"] })
  .refine((r) => r.cursor === undefined || parseCursor(r.cursor) !== null, {
    message: "Cursor inválido",
    path: ["cursor"],
  });

/** Só as chaves da lista branca com valor que passa em `safeLabel`; nada sobrando → nulo. */
function cleanTouch(v: unknown): Record<string, string> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const k of TOUCH_KEYS) {
    const x = safeLabel((v as Record<string, unknown>)[k]);
    if (x !== null) out[k] = x;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const paidReport = defineAction({
  name: "orders.paidReport",
  description:
    "Relatório de pedidos pagos no período (até 92 dias), sem dados pessoais do comprador: código, data, oferta, produtos, valor, método e origem (UTM). Paginado por cursor.",
  input,
  permission: "orders.report",
  audit: false,
  async run(ctx, { from, to, cursor, limit }) {
    const after = cursor ? parseCursor(cursor) : null;
    const rows = await ctx.tx
      .select({
        id: orders.id,
        publicId: orders.publicId,
        paidAt: orders.paidAt,
        paidAtIso,
        offerId: orders.offerId,
        offerName: offer.name,
        totalCents: orders.totalCents,
        method: orders.method,
        firstTouch: orders.firstTouch,
        lastTouch: orders.lastTouch,
        ref: orders.ref,
      })
      .from(orders)
      .innerJoin(offer, eq(offer.id, orders.offerId))
      .where(
        and(
          eq(orders.status, "paid"),
          gte(orders.paidAt, from),
          lt(orders.paidAt, to),
          after ? sql`(${orders.paidAt}, ${orders.id}) > (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(asc(orders.paidAt), asc(orders.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);

    const items = new Map<string, { name: string; kind: string }[]>();
    if (page.length > 0) {
      const found = await ctx.tx
        .select({ orderId: orderItem.orderId, name: product.name, kind: orderItem.kind })
        .from(orderItem)
        // Sem filtro de apagado: o histórico mantém o nome do produto que já foi vendido.
        .innerJoin(product, eq(product.id, orderItem.productId))
        .where(inArray(orderItem.orderId, page.map((r) => r.id)))
        .orderBy(...itemOrder);
      for (const i of found) items.set(i.orderId, [...(items.get(i.orderId) ?? []), { name: i.name, kind: i.kind }]);
    }

    const last = page[page.length - 1];
    return {
      orders: page.map((r) => {
        const paidAt = r.paidAt!;
        return {
          code: orderCode(r.publicId),
          paidAt,
          day: spDayKey(paidAt),
          offerId: r.offerId,
          offerName: r.offerName,
          items: items.get(r.id) ?? [],
          totalCents: r.totalCents,
          method: r.method,
          firstTouch: cleanTouch(r.firstTouch),
          lastTouch: cleanTouch(r.lastTouch),
          ref: safeLabel(r.ref),
        };
      }),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.paidAtIso}|${last.id}`).toString("base64url") : null,
    };
  },
});
