// Avisos operacionais ao vendedor: gravados em `store_alert` (painel) e enviados por e-mail (`notify_seller`) na MESMA
// transação. Todo caminho que avisa o vendedor com um motivo passa por `alertSeller`. As entregas que falharam vêm do
// `email_log` (último e-mail de entrega do pedido com falha), sem tabela própria.
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import type { Tx } from "@/lib/db/client";
import { emailLog, orders, storeAlert } from "@/lib/db/schema";
import { brl, orderCode } from "@/lib/format";
import { enqueue } from "@/lib/jobs";

export type AlertReason =
  | "chave_asaas_invalida"
  | "evento_conta_asaas_anterior"
  | "estorno_cancelado"
  | "estorno_falhou"
  | "estorno_parcial"
  | "disjuntor_cartao"
  | "monitor_pagina_pagamento";

/** Detalhes do aviso: só códigos e números (nunca texto de provedor nem dado de comprador). */
export interface AlertExtra {
  orderId?: string;
  httpStatus?: number;
  paymentId?: string;
  /** Código curto (ex.: código de erro do Asaas, problema do monitor de página). */
  code?: string;
  /** Estorno parcial: quanto já voltou ao comprador (centavos). */
  refundedCents?: number;
  /** Monitor de página de pagamento: qual página (`/form` = o iframe do cartão no domínio do serviço de cartão). */
  page?: "/c" | "/o" | "/form";
}

const safeCode = (v: string) => v.replace(/[^\w.:-]/g, "").slice(0, 64);

/** Grava o aviso do painel e enfileira o e-mail ao vendedor (`notify_seller` com `reason`), na transação `tx`. */
export async function alertSeller(tx: Tx, storeId: string, reason: AlertReason, extra: AlertExtra = {}): Promise<void> {
  const detail = {
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra.paymentId !== undefined ? { paymentId: extra.paymentId } : {}),
    ...(extra.code !== undefined ? { code: safeCode(extra.code) } : {}),
    ...(extra.refundedCents !== undefined ? { refundedCents: extra.refundedCents } : {}),
    ...(extra.page === "/c" || extra.page === "/o" || extra.page === "/form" ? { page: extra.page } : {}),
  };
  await tx.insert(storeAlert).values({ storeId, kind: reason, orderId: extra.orderId ?? null, detail });
  await enqueue(tx, { storeId, type: "notify_seller", payload: { ...(extra.orderId ? { orderId: extra.orderId } : {}), reason, ...detail } });
}

/** Título e orientação curtos para o painel (o e-mail tem o texto completo: noticeFor em delivery/jobs.ts). */
export function alertText(
  kind: string,
  detail: { httpStatus?: unknown; paymentId?: unknown; code?: unknown; refundedCents?: unknown; page?: unknown },
  code: string | null,
): { title: string; body: string } {
  const pedido = code ? ` (pedido #${code})` : "";
  const motivo = typeof detail.code === "string" && detail.code ? ` (motivo: ${detail.code})` : "";
  switch (kind) {
    case "chave_asaas_invalida":
      return {
        title: `O Asaas recusou a chave de API da loja${typeof detail.httpStatus === "number" ? ` (HTTP ${detail.httpStatus})` : ""}`,
        body: "Pagamentos do Asaas não estão sendo confirmados. Gere uma chave nova, salve em Conexões e reative a fila de webhooks no Asaas.",
      };
    case "evento_conta_asaas_anterior":
      return {
        title: `Movimento numa cobrança da conta Asaas anterior${pedido}`,
        body: "Confira na conta anterior do Asaas se o comprador pagou. Se pagou, abra o pedido e use “Liberar pedido” (ou devolva o valor pela conta anterior).",
      };
    case "estorno_cancelado":
      return {
        title: `Estorno cancelado no Asaas${pedido}`,
        body: "O pedido continua pago e o comprador mantém o acesso. Confira o motivo no Asaas e peça o reembolso de novo, se for o caso.",
      };
    case "estorno_falhou":
      return {
        title: `O Asaas recusou o estorno${pedido}${motivo}`,
        body: "O pedido continua pago e o comprador mantém o acesso. Confira no Asaas (saldo, chave de API, se a cobrança ainda pode ser estornada) e peça o reembolso de novo.",
      };
    case "estorno_parcial":
      return {
        title: `Estorno parcial no Asaas${pedido}${typeof detail.refundedCents === "number" ? `: ${brl(detail.refundedCents)} devolvidos` : ""}`,
        body: "Parte do valor foi devolvida pelo Asaas e o pedido continua pago (o comprador mantém o acesso). Para devolver o resto e encerrar o acesso, use “Reembolsar” no pedido.",
      };
    case "monitor_pagina_pagamento":
      return {
        title: `A página de pagamento mudou${typeof detail.page === "string" ? ` (${detail.page})` : ""}${motivo}`,
        body: "A verificação semanal encontrou cabeçalho de segurança ou scripts diferentes do esperado na página do checkout, do pedido ou do formulário do cartão. Se você não atualizou o sistema, investigue antes de continuar vendendo com cartão.",
      };
    case "disjuntor_cartao":
      return {
        title: "Muitas recusas de cartão em pouco tempo",
        body: "Por 1 hora, compras com cartão exigem verificação anti-robô. Se continuar, desligue o cartão na oferta por um tempo.",
      };
    default:
      return { title: "Aviso da loja", body: "Confira o painel." };
  }
}

const FAILED_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const listAlerts = defineAction({
  name: "alerts.list",
  description: "Avisos da loja ainda não confirmados (chave do Asaas, estorno cancelado, disjuntor do cartão...) e entregas com falha.",
  input: z.object({}),
  permission: "connections.read",
  audit: false,
  async run(ctx) {
    const rows = await ctx.tx
      .select({
        id: storeAlert.id,
        kind: storeAlert.kind,
        orderId: storeAlert.orderId,
        detail: storeAlert.detail,
        createdAt: storeAlert.createdAt,
        publicId: orders.publicId,
      })
      .from(storeAlert)
      .leftJoin(orders, eq(orders.id, storeAlert.orderId))
      .where(isNull(storeAlert.acknowledgedAt))
      .orderBy(desc(storeAlert.createdAt))
      .limit(20);
    const alerts = rows.map((r) => {
      const code = r.publicId ? orderCode(r.publicId) : null;
      return { id: r.id, kind: r.kind, orderId: r.orderId, code, createdAt: r.createdAt, ...alertText(r.kind, r.detail as object, code) };
    });

    return { alerts, failedDeliveries: await deliveryFailures(ctx.tx) };
  },
});

/** Pedido pago cujo e-mail de entrega mais recente (últimos 7 dias) falhou: o worker ainda re-tenta, mas o painel mostra. */
async function deliveryFailures(tx: Tx): Promise<Array<{ orderId: string; code: string; at: Date }>> {
  const since = new Date(Date.now() - FAILED_DELIVERY_WINDOW_MS);
  const latest = tx
    .selectDistinctOn([emailLog.orderId], { orderId: emailLog.orderId, status: emailLog.status, at: emailLog.at })
    .from(emailLog)
    .where(and(eq(emailLog.kind, "delivery"), gte(emailLog.at, since)))
    .orderBy(emailLog.orderId, desc(emailLog.at))
    .as("latest");
  const failed = await tx
    .select({ orderId: latest.orderId, at: latest.at, publicId: orders.publicId })
    .from(latest)
    .innerJoin(orders, eq(orders.id, latest.orderId))
    .where(and(eq(latest.status, "failed"), eq(orders.status, "paid")))
    .orderBy(desc(latest.at))
    .limit(20);
  return failed.map((f) => ({ orderId: f.orderId!, code: orderCode(f.publicId), at: f.at }));
}

/** Entregas com falha para quem atende pedidos (orders.read; ex.: support, que não vê os demais avisos da loja). */
export const listDeliveryFailures = defineAction({
  name: "orders.deliveryFailures",
  description: "Pedidos pagos cujo último e-mail de acesso (7 dias) falhou.",
  input: z.object({}),
  permission: "orders.read",
  audit: false,
  run: (ctx) => deliveryFailures(ctx.tx),
});

export const ackAlert = defineAction({
  name: "alerts.ack",
  description: "Marca um aviso da loja como visto (some do painel).",
  input: z.object({ id: z.uuid() }),
  // Confirmar some com o aviso para todos: só quem resolve as conexões da loja.
  permission: "connections.write",
  async run(ctx, { id }) {
    const [row] = await ctx.tx
      .update(storeAlert)
      .set({ acknowledgedAt: sql`coalesce(${storeAlert.acknowledgedAt}, now())` })
      .where(eq(storeAlert.id, id))
      .returning({ id: storeAlert.id });
    if (!row) throw new ActionError("not_found", "Aviso não encontrado");
    return row;
  },
});
