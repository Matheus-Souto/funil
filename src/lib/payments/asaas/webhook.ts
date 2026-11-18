import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction } from "@/lib/actions/core";
import { timingSafeEqualStr } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { orders, payment } from "@/lib/db/schema";
import { getIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { transitionOrder, type OrderStatus } from "@/lib/orders/state";
import { asaasClientFor, reaisToCents } from "./client";

export function mapAsaasStatus(s: string): OrderStatus | null {
  switch (s) {
    case "CONFIRMED":
    case "RECEIVED":
    case "RECEIVED_IN_CASH":
      return "paid";
    case "REFUNDED":
    case "REFUND_IN_PROGRESS":
      return "refunded";
    case "CHARGEBACK_REQUESTED":
    case "CHARGEBACK_DISPUTE":
    case "AWAITING_CHARGEBACK_REVERSAL":
      return "disputed";
    case "OVERDUE":
      return "expired";
    default:
      return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = z.object({ event: z.string().optional(), payment: z.object({ id: z.string().min(1).max(100) }) });

/** Aplica o estado JÁ reconsultado no Asaas ao pedido (nunca o corpo do webhook). Idempotente. */
export const applyAsaasPayment = defineAction({
  name: "payments.applyAsaasPayment",
  description: "Aplica ao pedido o estado de uma cobrança do Asaas reconsultada pelo webhook.",
  input: z.object({
    paymentId: z.string().min(1),
    status: z.string(),
    valueCents: z.number().int(),
    externalReference: z.string().nullable(),
  }),
  permission: "system",
  auditInput: (i) => ({ paymentId: i.paymentId, status: i.status, valueCents: i.valueCents }),
  async run(ctx, p) {
    if (!p.externalReference || !UUID.test(p.externalReference)) return { applied: false, reason: "sem_pedido" };
    const [o] = await ctx.tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, p.externalReference), eq(orders.storeId, ctx.storeId)))
      .for("update");
    if (!o || (o.method !== "pix_asaas" && o.method !== "card_asaas")) return { applied: false, reason: "pedido_de_outra_loja_ou_metodo" };

    const rows = await ctx.tx.select().from(payment).where(and(eq(payment.provider, "asaas"), eq(payment.orderId, o.id)));
    const [global] = await ctx.tx
      .select()
      .from(payment)
      .where(and(eq(payment.provider, "asaas"), eq(payment.providerId, p.paymentId)));
    if (global && global.orderId !== o.id) return { applied: false, reason: "pagamento_de_outro_pedido" };
    const row = rows.find((r) => r.providerId === p.paymentId);
    const target0 = mapAsaasStatus(p.status);
    const orphan = !row && rows.length > 0;

    // Cobrança marcada como duplicada (pagamento em dobro): só acompanha o status da linha, nunca mexe no pedido.
    if (row && (row.raw as { duplicate?: boolean } | null)?.duplicate === true) {
      if (row.status !== p.status) await ctx.tx.update(payment).set({ status: p.status }).where(eq(payment.id, row.id));
      return { applied: false, reason: "cobranca_duplicada" };
    }

    if (orphan) {
      // Cobrança que o pedido não conhece (ex.: criada e perdida numa falha). Só importa se o dinheiro chegou.
      if (target0 !== "paid") return { applied: false, reason: "cobranca_orfa" };
      await ctx.tx
        .insert(payment)
        .values({
          storeId: ctx.storeId,
          orderId: o.id,
          provider: "asaas",
          providerId: p.paymentId,
          status: p.status,
          amountCents: p.valueCents,
          // Só é duplicada se o pedido já estava resolvido; se esta cobrança é quem paga o pedido, é a cobrança "boa".
          raw: o.status !== "pending" && o.status !== "expired" ? { duplicate: true } : null,
        })
        .onConflictDoNothing();
      if (o.status !== "pending" && o.status !== "expired") {
        log.warn("pagamento em dobro: cobrança órfã paga em pedido já resolvido; devolver ao comprador", {
          orderId: o.id,
          paymentId: p.paymentId,
          orderStatus: o.status,
        });
        return { applied: false, reason: "pagamento_em_dobro" };
      }
    } else if (!row) {
      await ctx.tx
        .insert(payment)
        .values({ storeId: ctx.storeId, orderId: o.id, provider: "asaas", providerId: p.paymentId, status: p.status, amountCents: o.totalCents })
        .onConflictDoNothing();
    } else if (row.status !== p.status) {
      await ctx.tx.update(payment).set({ status: p.status }).where(eq(payment.id, row.id));
    }

    const target = mapAsaasStatus(p.status);
    if (!target) return { applied: false, reason: "status_ignorado" };
    if (target === "paid" && p.valueCents < o.totalCents) {
      log.warn("pagamento do Asaas abaixo do total; pedido não liberado", { orderId: o.id, paid: p.valueCents, total: o.totalCents });
      return { applied: false, reason: "valor_menor" };
    }
    try {
      // Asaas confirmou (reconsultado): um Pix pago depois de expirar o prazo local ainda libera o pedido.
      const r = await transitionOrder(ctx, o.id, target, `asaas ${p.status}`, { allowFromExpired: target === "paid" });
      return { applied: r.changed, reason: r.changed ? "ok" : "ja_processado" };
    } catch (e) {
      if (e instanceof ActionError && e.code === "conflict") return { applied: false, reason: "transicao_invalida" };
      throw e;
    }
  },
});

/**
 * Webhook do Asaas. Nunca confia no corpo: valida o token da loja, reconsulta `GET /payments/{id}` e aplica o estado real.
 * 401 sem revelar se a loja existe; 200 para eventos ignorados/repetidos; 500 só se o Asaas falhar (para o Asaas reenviar).
 */
export async function handleAsaasWebhook(storeId: string, headers: Headers, raw: unknown): Promise<{ status: number }> {
  if (!UUID.test(storeId)) return { status: 404 };
  const conn = await withStore(storeId, (tx) => getIntegration(tx, storeId, "asaas"));
  const expected = (conn?.config as { webhookToken?: string } | undefined)?.webhookToken;
  const given = headers.get("asaas-access-token") ?? "";
  // Compara sempre (mesmo sem loja/conexão) para não vazar por tempo qual caso ocorreu.
  const ok = timingSafeEqualStr(given, expected ?? "\0no-token");
  if (!conn || !expected || !given || !ok) return { status: 401 };

  const parsed = body.safeParse(raw);
  if (!parsed.success) return { status: 200 };

  let fresh;
  try {
    const client = await withStore(storeId, (tx) => asaasClientFor(tx, storeId));
    fresh = await client.getPayment(parsed.data.payment.id);
  } catch (e) {
    log.warn("webhook Asaas: falha ao reconsultar cobrança", { storeId, error: e });
    return { status: 500 };
  }
  if (fresh.id !== parsed.data.payment.id) return { status: 200 };

  try {
    await runAction(
      applyAsaasPayment,
      { storeId, actor: { kind: "system" }, origin: "webhook" },
      {
        paymentId: fresh.id,
        status: String(fresh.status),
        valueCents: reaisToCents(Number(fresh.value)),
        externalReference: typeof fresh.externalReference === "string" ? fresh.externalReference : null,
      },
    );
  } catch (e) {
    log.error("webhook Asaas: falha ao aplicar estado", { storeId, error: e });
    return { status: 500 };
  }
  return { status: 200 };
}
