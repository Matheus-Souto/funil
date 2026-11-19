import { and, between, count, eq, gt, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { orders, payment } from "@/lib/db/schema";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { PIX_MANUAL_RESERVE_MS } from "@/lib/orders/labels";
import { transitionOrder } from "@/lib/orders/state";
import { validCpf } from "@/lib/validation/br";
import { SUPERSEDED, hasOldAccountEvent } from "./asaas/webhook";
import { PIX_KEY_MAX, buildPixBrCode, sanitizeText } from "./brcode";

export const MANUAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MANUAL_BUSY_TTL_MS = 2 * 60 * 60 * 1000;
/** A partir de quantos pendentes no mesmo total a validade cai para 2 h. */
export const MANUAL_BUSY_THRESHOLD = 50;
export const MAX_OFFSET = 99;
export const ALLOCATION_ATTEMPTS = 3;
/**
 * Quarentena do valor único: o valor de um Pix manual expirado fica reservado por 48 h depois da validade.
 * Quem paga o QR antigo depois de expirar não pode colidir com um pedido novo de mesmo valor (o vendedor liberaria o errado).
 */
export const MANUAL_RESERVE_AFTER_EXPIRY_MS = PIX_MANUAL_RESERVE_MS;

export function isUniqueViolation(e: unknown): boolean {
  const c = (e as { code?: string; cause?: { code?: string } } | null) ?? {};
  return c.code === "23505" || c.cause?.code === "23505";
}

/** Marca como expirados os Pix manuais pendentes já vencidos da loja, liberando o valor. */
async function expireStale(ctx: Ctx, beforeExpire?: (ctx: Ctx, orderId: string) => Promise<void>): Promise<void> {
  const stale = await ctx.tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.method, "pix_manual"), eq(orders.status, "pending"), lt(orders.expiresAt, new Date())));
  for (const o of stale) {
    await beforeExpire?.(ctx, o.id);
    try {
      await transitionOrder(ctx, o.id, "expired", "expirou");
    } catch (e) {
      // Liberado/pago entre o select e a transição: já não segura o valor; o comprador novo não pode falhar por isso.
      if (e instanceof ActionError && e.code === "conflict") continue;
      throw e;
    }
  }
}

/**
 * Escolhe o valor único (total + offset de 1 a 99) de um novo Pix manual.
 * O valor não pode coincidir com nenhum outro Pix manual pendente da loja, nem com um que expirou há menos de 48 h
 * (a validade, `expires_at`, marca quando expirou); a reserva dos expirados é feita só aqui, sob o lock,
 * porque o índice único parcial cobre apenas os pendentes (o índice único vale para a loja inteira,
 * então totais diferentes também disputam valores). Um lock consultivo por loja serializa as alocações concorrentes
 * até o commit; o índice único parcial é a rede de segurança, e `skip` permite ao chamador tentar o próximo offset.
 */
export async function allocateManualAmount(
  ctx: Ctx,
  totalCents: number,
  opts: { skip?: readonly number[]; beforeExpire?: (ctx: Ctx, orderId: string) => Promise<void> } = {},
): Promise<{ amountCents: number; expiresAt: Date }> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"pix_manual:" + ctx.storeId}, 0))`);
  await expireStale(ctx, opts.beforeExpire);

  const reservedSince = new Date(Date.now() - MANUAL_RESERVE_AFTER_EXPIRY_MS);
  const taken = await ctx.tx
    .select({ amount: orders.manualAmountCents })
    .from(orders)
    .where(
      and(
        eq(orders.method, "pix_manual"),
        or(eq(orders.status, "pending"), and(eq(orders.status, "expired"), gt(orders.expiresAt, reservedSince))),
        between(orders.manualAmountCents, totalCents + 1, totalCents + MAX_OFFSET),
      ),
    );
  const used = new Set<number>([...taken.map((r) => r.amount!), ...(opts.skip ?? [])]);
  let offset = 1;
  while (offset <= MAX_OFFSET && used.has(totalCents + offset)) offset++;
  if (offset > MAX_OFFSET) throw new ActionError("conflict", "pix_manual_exhausted");

  const [row] = await ctx.tx
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.method, "pix_manual"), eq(orders.status, "pending"), eq(orders.totalCents, totalCents)));
  const ttl = (row?.n ?? 0) >= MANUAL_BUSY_THRESHOLD ? MANUAL_BUSY_TTL_MS : MANUAL_TTL_MS;
  return { amountCents: totalCents + offset, expiresAt: new Date(Date.now() + ttl) };
}

/** BR Code do pedido, a partir da conexão `pix_manual` da loja. `null` se a loja não configurou a chave. */
export async function manualPixBrCode(
  ctx: Ctx,
  order: { publicId: string; manualAmountCents: number | null },
): Promise<string | null> {
  if (order.manualAmountCents === null) return null;
  const conn = await getIntegration(ctx.tx, ctx.storeId, "pix_manual");
  const cfg = conn?.config as { key?: string; name?: string; city?: string } | undefined;
  if (!cfg?.key) return null;
  return buildPixBrCode({
    key: cfg.key,
    name: cfg.name ?? "",
    city: cfg.city ?? "",
    amountCents: order.manualAmountCents,
    txid: order.publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 25),
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validCnpj(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  for (const n of [12, 13]) {
    const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * w[i]!;
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== Number(d[n])) return false;
  }
  return true;
}

/** Validação frouxa do formato da chave; devolve a forma normalizada ou null. */
export function normalizePixKey(raw: string): string | null {
  const v = raw.trim();
  if (EMAIL.test(v) && v.length <= PIX_KEY_MAX && /^[\x21-\x7e]+$/.test(v)) return v.toLowerCase();
  if (UUID.test(v)) return v.toLowerCase();
  if (/^\+55\d{10,11}$/.test(v)) return v;
  const digits = v.replace(/[.\-/\s]/g, "");
  if (validCpf(digits) || validCnpj(digits)) return digits;
  return null;
}

export const savePixManual = defineAction({
  name: "connections.savePixManual",
  description: "Salva a chave Pix própria da loja (chave, nome e cidade do recebedor).",
  input: z.object({
    key: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    city: z.string().trim().min(1).max(100),
  }),
  permission: "connections.write",
  // Trocar a chave redireciona todo o dinheiro do Pix manual: MCP/IA precisam de aprovação.
  sensitive: true,
  async run(ctx, input) {
    const key = normalizePixKey(input.key);
    if (!key) throw new ActionError("invalid_input", "Chave Pix inválida: use CPF ou CNPJ válidos, e-mail, telefone no formato +55DDDNÚMERO (ex.: +5511999999999) ou chave aleatória");
    const config = { key, name: sanitizeText(input.name, 25, "LOJA"), city: sanitizeText(input.city, 15, "BRASIL") };
    await saveIntegration(ctx.tx, ctx.storeId, "pix_manual", config);
    return config;
  },
});

/**
 * Libera à mão: Pix manual pendente ou expirado (o vendedor viu o Pix no extrato) ou Pix Asaas cujo comprador pagou uma
 * cobrança da conta Asaas ANTERIOR da loja (linha `superseded` que recebeu evento depois da troca de conta: a chave
 * atual não enxerga essa cobrança, então o webhook nunca confirma o pedido sozinho).
 */
export const releaseOrder = defineAction({
  name: "orders.release",
  description:
    "Libera manualmente um pedido pendente ou expirado depois de conferir o recebimento (Pix manual, ou Pix Asaas pago na conta Asaas anterior da loja).",
  input: z.object({ orderId: z.uuid() }),
  permission: "orders.release",
  sensitive: true,
  async run(ctx, { orderId }) {
    const [o] = await ctx.tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    let oldAccountPayment: string | null = null;
    if (o.method === "pix_asaas") {
      const rows = await ctx.tx
        .select({ providerId: payment.providerId, raw: payment.raw })
        .from(payment)
        .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas"), eq(payment.status, SUPERSEDED)));
      const withEvent = rows.find((r) => hasOldAccountEvent(r.raw));
      if (!withEvent) {
        throw new ActionError("conflict", "Só pedidos de Pix manual, ou de Pix Asaas com cobrança movimentada na conta Asaas anterior, podem ser liberados à mão");
      }
      oldAccountPayment = withEvent.providerId;
    } else if (o.method !== "pix_manual") {
      throw new ActionError("conflict", "Só pedidos de Pix manual podem ser liberados à mão");
    }
    // Pendente ou já expirado: quem pagou depois da validade ainda precisa ser liberado.
    if (o.status !== "pending" && o.status !== "expired") throw new ActionError("conflict", `Pedido não está pendente (${o.status})`);
    const r = await transitionOrder(ctx, o.id, "paid", "liberado manualmente", { allowFromExpired: true });
    if (!r.changed) throw new ActionError("conflict", "Pedido já foi liberado");
    await ctx.tx.insert(payment).values({
      storeId: ctx.storeId,
      orderId: o.id,
      provider: "manual",
      providerId: null,
      status: "paid",
      amountCents: o.manualAmountCents ?? o.totalCents,
      ...(oldAccountPayment !== null ? { raw: { releasedFrom: "asaas_conta_anterior", paymentId: oldAccountPayment } } : {}),
    });
    return { orderId: o.id };
  },
});
