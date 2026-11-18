import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { randomToken } from "@/lib/crypto";
import { customer, orders, payment } from "@/lib/db/schema";
import { env as appEnv } from "@/lib/env";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { asaasClientFor, centsToReais, createAsaasClient } from "./client";

/** Cria (uma vez) o cliente no Asaas e guarda `asaas_customer_id`. */
export async function ensureAsaasCustomer(ctx: Ctx, customerId: string): Promise<string> {
  // FOR UPDATE: duas requisições do mesmo cliente não criam dois cadastros no Asaas.
  const [c] = await ctx.tx.select().from(customer).where(eq(customer.id, customerId)).for("update");
  if (!c) throw new ActionError("not_found", "Cliente não encontrado");
  if (c.asaasCustomerId) return c.asaasCustomerId;
  if (!c.cpf) throw new ActionError("invalid_input", "CPF ou CNPJ do cliente é obrigatório para pagar pelo Asaas");
  const client = await asaasClientFor(ctx.tx, ctx.storeId);
  const created = await client.createCustomer({
    name: c.name,
    email: c.email,
    cpfCnpj: c.cpf,
    mobilePhone: c.phone,
    externalReference: c.id,
  });
  await ctx.tx.update(customer).set({ asaasCustomerId: created.id }).where(eq(customer.id, c.id));
  return created.id;
}

/** Cobrança Pix do Asaas para o pedido; reaproveita a cobrança já criada (sem duplicar). */
export async function startAsaasPix(ctx: Ctx, orderId: string): Promise<{ qrImage: string; copyPaste: string; expiresAt: string }> {
  const [o] = await ctx.tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  if (!o) throw new ActionError("not_found", "Pedido não encontrado");
  if (o.method !== "pix_asaas") throw new ActionError("conflict", "Pedido não é de Pix automático");
  if (o.status !== "pending") throw new ActionError("conflict", `Pedido não está pendente (${o.status})`);

  const client = await asaasClientFor(ctx.tx, ctx.storeId);
  const [existing] = await ctx.tx
    .select()
    .from(payment)
    .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas")));
  let providerId = existing?.providerId ?? null;
  if (!providerId) {
    const asaasCustomer = await ensureAsaasCustomer(ctx, o.customerId);
    const created = await client.createPayment(
      {
        customer: asaasCustomer,
        billingType: "PIX",
        value: centsToReais(o.totalCents),
        dueDate: new Date().toISOString().slice(0, 10),
        externalReference: o.id,
      },
      { timeoutMs: 60_000 },
    );
    providerId = created.id;
    // O webhook pode ter chegado antes deste commit e já criado a linha: não duplica.
    await ctx.tx
      .insert(payment)
      .values({ storeId: ctx.storeId, orderId: o.id, provider: "asaas", providerId, status: created.status, amountCents: o.totalCents })
      .onConflictDoNothing();
  }
  const qr = await client.getPixQrCode(providerId);
  return { qrImage: qr.encodedImage, copyPaste: qr.payload, expiresAt: qr.expirationDate };
}

const webhookUrl = (storeId: string) => `${appEnv.BASE_URL.replace(/\/+$/, "")}/api/webhooks/asaas/${storeId}`;

export const saveAsaas = defineAction({
  name: "connections.saveAsaas",
  description: "Conecta o Asaas da loja: testa a chave (saldo) e só então salva; gera o token do webhook.",
  input: z.object({
    env: z.enum(["sandbox", "production"]),
    apiKey: z.string().trim().min(8).max(500),
    rotateWebhookToken: z.boolean().optional(),
  }),
  permission: "connections.write",
  sensitive: true,
  // Nunca grava a chave de API na auditoria.
  auditInput: (i) => ({ env: i.env, rotateWebhookToken: i.rotateWebhookToken ?? false }),
  async run(ctx, input) {
    // Testa antes de salvar: chave inválida => provider_error e nada é gravado.
    await createAsaasClient({ apiKey: input.apiKey, env: input.env }).getBalance();
    const current = await getIntegration(ctx.tx, ctx.storeId, "asaas");
    const kept = (current?.config as { webhookToken?: string } | undefined)?.webhookToken;
    const webhookToken = kept && !input.rotateWebhookToken ? kept : randomToken();
    await saveIntegration(ctx.tx, ctx.storeId, "asaas", { env: input.env, webhookToken }, input.apiKey);
    return { env: input.env, webhookToken, webhookUrl: webhookUrl(ctx.storeId) };
  },
});
