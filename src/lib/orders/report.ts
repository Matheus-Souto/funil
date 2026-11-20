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
/** Letras (qualquer alfabeto), dígitos, espaço e `_ . : + - | / ( ) [ ] #`: nomes reais de campanha ("Kids ABO | Natal 25/11"). */
const LABEL_RE = /^[\p{L}0-9 _.:+\-|/()[\]#]+$/u;
const MAX_LABEL_CHARS = 100;
const MAX_LABEL_WORDS = 12;
/** Rótulo presente mas recusado: aparece assim (em vez de sumir), para a soma das origens fechar. */
export const HIDDEN_LABEL = "(oculto)";

/** paid_at com microssegundos (o Date do JS só tem milissegundos e o cursor repetiria o pedido). */
const paidAtIso = sql<string>`to_char(${orders.paidAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Cursor decodificado, ou null se o formato ou a data forem inválidos (ex.: mês 99). */
function parseCursor(cursor: string): { at: string; id: string } | null {
  const m = CURSOR_RE.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!m) return null;
  // Date.parse aceita 30/02 e 24:00 (rolam para o dia seguinte) e o Postgres não: a data reconstruída tem de ser a mesma.
  // Os 3 dígitos de microssegundos são só números.
  const ms = m[1]!.slice(0, 23);
  const parsed = Date.parse(`${ms}Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 23) !== ms) return null;
  return { at: m[1]!, id: m[2]! };
}

/**
 * Texto livre do visitante (UTM, src, ref) só passa se parecer um rótulo: nada de e-mail, endereço, telefone ou frase.
 * Espaços repetidos colapsam e as pontas são aparadas; até 100 caracteres e 12 palavras. Recusa `@`, `://` e `www.`.
 * Total de 8 a 14 dígitos (em qualquer posição, com pontuação) é telefone ou CPF e é recusado; 15 ou mais passa,
 * porque os ids de anúncio e campanha do Meta (ex.: 120212345678901234) são o principal uso do relatório.
 * Nulo quando recusado (ou vazio, ou não é texto).
 */
export function safeLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/ +/g, " ").trim();
  if (t === "" || t.length > MAX_LABEL_CHARS || t.split(" ").length > MAX_LABEL_WORDS || !LABEL_RE.test(t)) return null;
  if (t.includes("://") || /www\./i.test(t)) return null;
  const digits = t.replace(/\D/g, "").length;
  return digits >= 8 && digits <= 14 ? null : t;
}

/** Valor ausente (nulo/indefinido) continua nulo; presente e recusado por `safeLabel` vira "(oculto)". */
export function labelOrHidden(v: unknown): string | null {
  return v === null || v === undefined ? null : (safeLabel(v) ?? HIDDEN_LABEL);
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

/** Só as chaves da lista branca; valor recusado por `safeLabel` vira "(oculto)" (não some); nada sobrando → nulo. */
export function cleanTouch(v: unknown): Record<string, string> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const k of TOUCH_KEYS) {
    const x = labelOrHidden((v as Record<string, unknown>)[k]);
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
          ref: labelOrHidden(r.ref),
        };
      }),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.paidAtIso}|${last.id}`).toString("base64url") : null,
    };
  },
});
