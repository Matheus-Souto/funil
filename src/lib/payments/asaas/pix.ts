import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction, type Actor, type Origin } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { randomToken } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { customer, orders, payment } from "@/lib/db/schema";
import { env as appEnv } from "@/lib/env";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { asaasClientFor, centsToReais, createAsaasClient } from "./client";

/** Estado "aberto" da cobrança Pix (índice único parcial: uma por pedido). */
const OPEN = "PENDING";
const PIX_TIMEOUT_MS = 15_000;

/**
 * Cria (uma vez) o cliente no Asaas e guarda `asaas_customer_id`.
 * Não segura transação durante o HTTP: lê, chama o Asaas e grava com UPDATE condicional
 * (se outra chamada gravou antes, devolve o id gravado; o cadastro sobrando no Asaas é inofensivo).
 * Não chamar dentro de uma transação do chamador.
 */
export async function ensureAsaasCustomer(call: { storeId: string }, customerId: string): Promise<string> {
  const { storeId } = call;
  const c = await withStore(storeId, async (tx) => (await tx.select().from(customer).where(eq(customer.id, customerId)))[0]);
  if (!c) throw new ActionError("not_found", "Cliente não encontrado");
  if (c.asaasCustomerId) return c.asaasCustomerId;
  if (!c.cpf) throw new ActionError("invalid_input", "CPF ou CNPJ do cliente é obrigatório para pagar pelo Asaas");
  const client = await withStore(storeId, (tx) => asaasClientFor(tx, storeId));
  const created = await client.createCustomer({
    name: c.name,
    email: c.email,
    cpfCnpj: c.cpf,
    mobilePhone: c.phone,
    externalReference: c.id,
  });
  return withStore(storeId, async (tx) => {
    const won = await tx
      .update(customer)
      .set({ asaasCustomerId: created.id })
      .where(and(eq(customer.id, c.id), isNull(customer.asaasCustomerId)))
      .returning({ id: customer.asaasCustomerId });
    if (won.length > 0) return created.id;
    const [now] = await tx.select({ id: customer.asaasCustomerId }).from(customer).where(eq(customer.id, c.id));
    return now!.id ?? created.id;
  });
}

/**
 * Cobrança Pix do Asaas para o pedido; reaproveita a cobrança já criada (sem duplicar).
 * Três fases, nenhuma com HTTP dentro de transação: (a) valida e lê a cobrança existente; (b) cliente + cobrança no Asaas;
 * (c) trava o pedido e grava a linha (se outra chamada ganhou, usa a dela e apaga a sobra); depois busca o QR.
 * Não chamar dentro de uma transação do chamador.
 */
export async function startAsaasPix(
  call: { storeId: string },
  orderId: string,
): Promise<{ qrImage: string; copyPaste: string; expiresAt: string }> {
  const { storeId } = call;
  const lockAndCheck = async (tx: Parameters<Parameters<typeof withStore>[1]>[0]) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!o) throw new ActionError("not_found", "Pedido não encontrado");
    if (o.method !== "pix_asaas") throw new ActionError("conflict", "Pedido não é de Pix automático");
    if (o.status !== "pending") throw new ActionError("conflict", `Pedido não está pendente (${o.status})`);
    const [open] = await tx
      .select()
      .from(payment)
      .where(and(eq(payment.orderId, o.id), eq(payment.provider, "asaas"), eq(payment.status, OPEN)));
    return { o, open };
  };

  // (a)
  const a = await withStore(storeId, lockAndCheck);
  let providerId = a.open?.providerId ?? null;
  const client = await withStore(storeId, (tx) => asaasClientFor(tx, storeId));

  if (!providerId) {
    // (b) HTTP fora de transação
    const asaasCustomer = await ensureAsaasCustomer(call, a.o.customerId);
    const created = await client.createPayment(
      {
        customer: asaasCustomer,
        billingType: "PIX",
        value: centsToReais(a.o.totalCents),
        dueDate: new Date().toISOString().slice(0, 10),
        externalReference: a.o.id,
      },
      { timeoutMs: PIX_TIMEOUT_MS },
    );
    // (c)
    let surplus = false;
    try {
      providerId = await withStore(storeId, async (tx) => {
        const { o, open } = await lockAndCheck(tx);
        if (open?.providerId) {
          surplus = true;
          return open.providerId;
        }
        // O webhook da própria cobrança pode ter chegado antes e criado a linha: não duplica.
        await tx
          .insert(payment)
          .values({ storeId, orderId: o.id, provider: "asaas", providerId: created.id, status: OPEN, amountCents: o.totalCents })
          .onConflictDoNothing();
        return created.id;
      });
    } catch (e) {
      // Pedido mudou de estado no meio (ou erro): a cobrança nova não serve.
      await discard(client, created.id);
      throw e;
    }
    if (surplus) await discard(client, created.id);
  }

  // QR fora de transação, com a linha já confirmada: se falhar, a nova tentativa reaproveita a cobrança.
  const qr = await client.getPixQrCode(providerId);
  return { qrImage: qr.encodedImage, copyPaste: qr.payload, expiresAt: qr.expirationDate };
}

/** Melhor esforço: cancela no Asaas uma cobrança que sobrou de uma corrida. */
async function discard(client: ReturnType<typeof createAsaasClient>, paymentId: string): Promise<void> {
  try {
    await client.deletePayment(paymentId);
  } catch (e) {
    log.warn("não foi possível apagar a cobrança sobrando no Asaas", { paymentId, error: e });
  }
}

const webhookUrl = (storeId: string) => `${appEnv.BASE_URL.replace(/\/+$/, "")}/api/webhooks/asaas/${storeId}`;

const saveInput = z.object({
  env: z.enum(["sandbox", "production"]),
  apiKey: z.string().trim().min(8).max(500),
  rotateWebhookToken: z.boolean().optional(),
});

/** Grava a conexão. Só roda depois de `saveAsaas` ter testado a chave (`verified`). */
export const persistAsaas = defineAction({
  name: "connections.saveAsaas",
  description: "Conecta o Asaas da loja: testa a chave (saldo) e só então salva; gera o token do webhook.",
  input: saveInput.extend({ verified: z.literal(true) }),
  permission: "connections.write",
  sensitive: true,
  // Nunca grava a chave de API na auditoria.
  auditInput: (i) => ({ env: i.env, rotateWebhookToken: i.rotateWebhookToken ?? false }),
  async run(ctx, input) {
    const current = await getIntegration(ctx.tx, ctx.storeId, "asaas");
    const kept = (current?.config as { webhookToken?: string } | undefined)?.webhookToken;
    const webhookToken = kept && !input.rotateWebhookToken ? kept : randomToken();
    await saveIntegration(ctx.tx, ctx.storeId, "asaas", { env: input.env, webhookToken }, input.apiKey);
    return { env: input.env, webhookToken, webhookUrl: webhookUrl(ctx.storeId) };
  },
});

/**
 * `connections.saveAsaas`: testa a chave com GET /finance/balance ANTES de abrir transação e só então grava
 * (chave inválida => provider_error e nada é salvo). Replica as barreiras da ação (permissão, aprovação, entrada)
 * antes de falar com o Asaas, para não servir de sonda a quem não pode.
 */
export async function saveAsaas(call: { storeId: string; actor: Actor; origin: Origin }, raw: unknown) {
  if (call.origin === "mcp" || call.origin === "ai") throw new ActionError("approval_required", "Ação sensível exige aprovação: connections.saveAsaas");
  if (call.actor.kind !== "user" || !hasPermission(call.actor.role, "connections.write")) {
    throw new ActionError("forbidden", "Sem permissão: connections.write");
  }
  const parsed = saveInput.safeParse(raw);
  if (!parsed.success) throw new ActionError("invalid_input", "Entrada inválida");
  await createAsaasClient({ apiKey: parsed.data.apiKey, env: parsed.data.env }).getBalance();
  return runAction(persistAsaas, call, { ...parsed.data, verified: true as const });
}
