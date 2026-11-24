// Ações do painel para cupons (D11). Leitura: `offers.read`; escrita: `offers.write` e sensível (mudam preço: pelo MCP
// passam pela fila de aprovação). Cupom nunca é apagado (os pedidos o referenciam): arquivar desliga e guarda a data.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { coupon, couponOffer, offer, orders } from "@/lib/db/schema";
import { lockCoupon } from "./apply";
import { COUPON_DUPLICATE_MESSAGE, COUPON_USED_CODE_MESSAGE } from "./messages";
import { normalizeCode } from "./rules";
import { couponUses } from "./usage";

type CouponRow = typeof coupon.$inferSelect;

export interface CouponView {
  id: string;
  code: string;
  kind: "percent" | "fixed";
  percentBp: number | null;
  amountCents: number | null;
  appliesTo: "main" | "all";
  startsAt: Date | null;
  endsAt: Date | null;
  maxUses: number | null;
  maxPerEmail: number | null;
  active: boolean;
  archivedAt: Date | null;
  offerIds: string[];
  uses: number;
}

const id = z.uuid();
const code = z
  .string()
  .transform((v, ctx) => {
    const c = normalizeCode(v);
    if (c === null) ctx.addIssue({ code: "custom", message: "Use 3 a 32 caracteres: letras, números, hífen e sublinhado" });
    return c ?? "";
  });
const kind = z.enum(["percent", "fixed"]);
const appliesTo = z.enum(["main", "all"]);
// Faixa plausível (e dentro do que o banco guarda): data absurda vira `invalid_input`, nunca erro interno.
const date = z.coerce.date().refine((d) => d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100, "Use uma data entre os anos 2000 e 2100");
const positiveInt = z.number().int().positive().max(2_147_483_647);
/** Teto do valor fixo (R$ 1.000.000,00), o mesmo dos totais do checkout; o percentual já vai de 1 a 9000 (`ruleIssues`). */
const MAX_AMOUNT_CENTS = 100_000_000;
const amountCents = z.number().int().max(MAX_AMOUNT_CENTS, "Valor fixo: no máximo R$ 1.000.000,00");
const offerIds = z.array(id).max(200).transform((v) => [...new Set(v)]);

interface Rule {
  kind: "percent" | "fixed";
  percentBp: number | null;
  amountCents: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** Consistência entre tipo e valor e da janela de validade; cada problema com o caminho do campo. */
function ruleIssues(r: Rule): { path: string[]; message: string }[] {
  const out: { path: string[]; message: string }[] = [];
  if (r.kind === "percent") {
    if (r.percentBp === null || !Number.isInteger(r.percentBp) || r.percentBp < 1 || r.percentBp > 9000) {
      out.push({ path: ["percentBp"], message: "Percentual: de 1 a 9000 pontos-base (0,01% a 90%)" });
    }
    if (r.amountCents !== null) out.push({ path: ["amountCents"], message: "Cupom percentual não tem valor fixo" });
  } else {
    if (r.amountCents === null || !Number.isInteger(r.amountCents) || r.amountCents <= 0) {
      out.push({ path: ["amountCents"], message: "Valor fixo: centavos inteiros maiores que zero" });
    }
    if (r.percentBp !== null) out.push({ path: ["percentBp"], message: "Cupom de valor fixo não tem percentual" });
  }
  if (r.startsAt && r.endsAt && r.endsAt.getTime() <= r.startsAt.getTime()) {
    out.push({ path: ["endsAt"], message: "O fim da validade deve ser depois do início" });
  }
  return out;
}

const createInput = z
  .strictObject({
    code,
    kind,
    percentBp: z.number().int().nullish().transform((v) => v ?? null),
    amountCents: amountCents.nullish().transform((v) => v ?? null),
    appliesTo: appliesTo.default("main"),
    startsAt: date.nullish().transform((v) => v ?? null),
    endsAt: date.nullish().transform((v) => v ?? null),
    maxUses: positiveInt.nullish().transform((v) => v ?? null),
    maxPerEmail: positiveInt.nullable().default(1),
    active: z.boolean().default(true),
    offerIds: offerIds.default([]),
  })
  .superRefine((v, ctx) => {
    for (const i of ruleIssues(v)) ctx.addIssue({ code: "custom", path: i.path, message: i.message });
  });

const updateInput = z.strictObject({
  id,
  code: code.optional(),
  kind: kind.optional(),
  percentBp: z.number().int().nullable().optional(),
  amountCents: amountCents.nullable().optional(),
  appliesTo: appliesTo.optional(),
  startsAt: date.nullable().optional(),
  endsAt: date.nullable().optional(),
  maxUses: positiveInt.nullable().optional(),
  maxPerEmail: positiveInt.nullable().optional(),
  active: z.boolean().optional(),
  offerIds: offerIds.optional(),
});

function isUniqueViolation(e: unknown): boolean {
  const c = (e as { code?: string; cause?: { code?: string } } | null) ?? {};
  return c.code === "23505" || c.cause?.code === "23505";
}

async function ensureCodeFree(ctx: Ctx, c: string, exceptId?: string): Promise<void> {
  const [row] = await ctx.tx.select({ id: coupon.id }).from(coupon).where(eq(coupon.code, c));
  if (row && row.id !== exceptId) throw new ActionError("conflict", COUPON_DUPLICATE_MESSAGE);
}

/** Toda oferta da lista precisa ser desta loja; senão `not_found`. (Oferta não tem apagamento lógico: só `active`.) */
async function checkOffers(ctx: Ctx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await ctx.tx
    .select({ id: offer.id })
    .from(offer)
    .where(and(eq(offer.storeId, ctx.storeId), inArray(offer.id, ids)));
  if (rows.length !== ids.length) throw new ActionError("not_found", "Oferta não encontrada");
}

async function writeOffers(ctx: Ctx, couponId: string, ids: string[]): Promise<void> {
  await ctx.tx.delete(couponOffer).where(eq(couponOffer.couponId, couponId));
  if (ids.length > 0) await ctx.tx.insert(couponOffer).values(ids.map((offerId) => ({ storeId: ctx.storeId, couponId, offerId })));
}

/** Linhas → visão do painel/MCP (com as ofertas e os usos da regra D5). */
async function toViews(ctx: Ctx, rows: CouponRow[]): Promise<CouponView[]> {
  const ids = rows.map((r) => r.id);
  const links = ids.length === 0 ? [] : await ctx.tx.select().from(couponOffer).where(inArray(couponOffer.couponId, ids));
  const uses = await couponUses(ctx.tx, ids);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    kind: r.kind as CouponView["kind"],
    percentBp: r.percentBp,
    amountCents: r.amountCents,
    appliesTo: r.appliesTo as CouponView["appliesTo"],
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    maxUses: r.maxUses,
    maxPerEmail: r.maxPerEmail,
    active: r.active,
    archivedAt: r.archivedAt,
    offerIds: links.filter((l) => l.couponId === r.id).map((l) => l.offerId).sort(),
    uses: uses.get(r.id) ?? 0,
  }));
}

export const listCoupons = defineAction({
  name: "coupons.list",
  description:
    "Lista os cupons da loja (mais recentes primeiro; includeArchived inclui os arquivados) com ofertas (offerIds, vazio = todas) e usos (pagos e pendentes que ainda podem ser pagos).",
  input: z.strictObject({ includeArchived: z.boolean().optional() }),
  permission: "offers.read",
  audit: false,
  async run(ctx, input) {
    const where = input.includeArchived ? undefined : isNull(coupon.archivedAt);
    return toViews(ctx, await ctx.tx.select().from(coupon).where(where).orderBy(desc(coupon.createdAt)));
  },
});

export const getCoupon = defineAction({
  name: "coupons.get",
  description: "Busca um cupom pelo id.",
  input: z.strictObject({ id }),
  permission: "offers.read",
  audit: false,
  async run(ctx, input) {
    const [row] = await ctx.tx.select().from(coupon).where(eq(coupon.id, input.id));
    if (!row) throw new ActionError("not_found", "Cupom não encontrado");
    return (await toViews(ctx, [row]))[0]!;
  },
});

export const createCoupon = defineAction({
  name: "coupons.create",
  description:
    "Cria um cupom: code (3 a 32: A-Z, 0-9, hífen e sublinhado; guardado em maiúsculas), kind percent (percentBp de 1 a 9000, 1000 = 10%) ou fixed (amountCents em centavos), appliesTo main (só o produto principal, padrão) ou all (inclui o bump), validade startsAt/endsAt, limites maxUses e maxPerEmail (padrão 1; null = sem limite) e offerIds (vazio = todas as ofertas).",
  input: createInput,
  permission: "offers.write",
  // Cupom novo muda o preço cobrado: MCP/IA pedem aprovação.
  sensitive: true,
  async run(ctx, input) {
    await checkOffers(ctx, input.offerIds);
    await ensureCodeFree(ctx, input.code);
    let row: CouponRow;
    try {
      [row] = (await ctx.tx
        .insert(coupon)
        .values({
          storeId: ctx.storeId,
          code: input.code,
          kind: input.kind,
          percentBp: input.percentBp,
          amountCents: input.amountCents,
          appliesTo: input.appliesTo,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          maxUses: input.maxUses,
          maxPerEmail: input.maxPerEmail,
          active: input.active,
        })
        .returning()) as [CouponRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new ActionError("conflict", COUPON_DUPLICATE_MESSAGE);
      throw e;
    }
    await writeOffers(ctx, row.id, input.offerIds);
    return (await toViews(ctx, [row]))[0]!;
  },
});

export const updateCoupon = defineAction({
  name: "coupons.update",
  description:
    "Atualiza um cupom (só os campos enviados; os mesmos de coupons.create). Mudar tipo ou valor vale só para pedidos novos. offerIds troca a lista (vazio = todas as ofertas). Cupom arquivado não é editado. O código de um cupom que já tem pedido não muda (crie outro cupom).",
  input: updateInput,
  permission: "offers.write",
  sensitive: true,
  async run(ctx, input) {
    // Mesmo lock do checkout (nenhuma edição no meio da conferência de um pedido) e a linha travada: edições
    // simultâneas rodam uma depois da outra.
    await lockCoupon(ctx.tx, input.id);
    const [current] = await ctx.tx.select().from(coupon).where(eq(coupon.id, input.id)).for("update");
    if (!current) throw new ActionError("not_found", "Cupom não encontrado");
    if (current.archivedAt) throw new ActionError("conflict", "Cupom arquivado não pode ser editado");
    if (input.code !== undefined && input.code !== current.code) {
      // Qualquer pedido (até expirado ou recusado) guarda o cupom pelo id: renomear mudaria o código no histórico.
      const [used] = await ctx.tx.select({ id: orders.id }).from(orders).where(eq(orders.couponId, current.id)).limit(1);
      if (used) throw new ActionError("conflict", COUPON_USED_CODE_MESSAGE);
    }

    // Ao trocar o tipo, o valor do tipo antigo não vale: só o que veio na entrada.
    const sameKind = input.kind === undefined || input.kind === current.kind;
    const merged: Rule = {
      kind: input.kind ?? (current.kind as Rule["kind"]),
      percentBp: input.percentBp !== undefined ? input.percentBp : sameKind ? current.percentBp : null,
      amountCents: input.amountCents !== undefined ? input.amountCents : sameKind ? current.amountCents : null,
      startsAt: input.startsAt !== undefined ? input.startsAt : current.startsAt,
      endsAt: input.endsAt !== undefined ? input.endsAt : current.endsAt,
    };
    const issues = ruleIssues(merged);
    if (issues.length > 0) throw new ActionError("invalid_input", "Entrada inválida", issues.map((i) => ({ ...i, code: "custom" })));

    if (input.offerIds) await checkOffers(ctx, input.offerIds);
    if (input.code !== undefined) await ensureCodeFree(ctx, input.code, input.id);
    let row: CouponRow;
    try {
      [row] = (await ctx.tx
        .update(coupon)
        .set({
          ...merged,
          ...(input.code !== undefined ? { code: input.code } : {}),
          ...(input.appliesTo !== undefined ? { appliesTo: input.appliesTo } : {}),
          ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
          ...(input.maxPerEmail !== undefined ? { maxPerEmail: input.maxPerEmail } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        })
        .where(eq(coupon.id, input.id))
        .returning()) as [CouponRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new ActionError("conflict", COUPON_DUPLICATE_MESSAGE);
      throw e;
    }
    if (input.offerIds) await writeOffers(ctx, input.id, input.offerIds);
    return (await toViews(ctx, [row]))[0]!;
  },
});

export const archiveCoupon = defineAction({
  name: "coupons.archive",
  description: "Arquiva um cupom: desliga e guarda a data. Nunca apaga (os pedidos o referenciam).",
  input: z.strictObject({ id }),
  permission: "offers.write",
  sensitive: true,
  async run(ctx, input) {
    // Mesmo lock do checkout: o arquivamento não cai no meio da conferência de um pedido.
    await lockCoupon(ctx.tx, input.id);
    const [current] = await ctx.tx.select().from(coupon).where(eq(coupon.id, input.id)).for("update");
    if (!current) throw new ActionError("not_found", "Cupom não encontrado");
    if (current.archivedAt) return (await toViews(ctx, [current]))[0]!;
    const [row] = await ctx.tx.update(coupon).set({ archivedAt: sql`now()`, active: false }).where(eq(coupon.id, input.id)).returning();
    return (await toViews(ctx, [row!]))[0]!;
  },
});
