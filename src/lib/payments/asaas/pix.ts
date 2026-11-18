import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { randomToken } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { customer, orders, payment } from "@/lib/db/schema";
import { env as appEnv } from "@/lib/env";
import { getIntegration, saveIntegration } from "@/lib/integrations";
import { log } from "@/lib/log";
import { asaasAccountKey, asaasClientFor, asaasConnectionFor, asaasDueDate, centsToReais, createAsaasClient, type AsaasEnv } from "./client";
import { SUPERSEDED } from "./webhook";

/** Estado "aberto" da cobrança Pix (índice único parcial: uma por pedido). */
const OPEN = "PENDING";
const PIX_TIMEOUT_MS = 15_000;

/**
 * Cria (uma vez por conta Asaas) o cliente no Asaas e guarda `asaas_customer_id` + `asaas_account_key`.
 * Se o id guardado veio de outra conta/ambiente (a loja trocou a conexão), cria de novo na conta atual.
 * Não segura transação durante o HTTP: lê, chama o Asaas e grava com UPDATE condicional
 * (se outra chamada gravou antes, devolve o id gravado; o cadastro sobrando no Asaas é inofensivo).
 * Não chamar dentro de uma transação do chamador.
 */
export async function ensureAsaasCustomer(call: { storeId: string }, customerId: string): Promise<string> {
  const { storeId } = call;
  const { c, client, accountKey } = await withStore(storeId, async (tx) => {
    const [row] = await tx.select().from(customer).where(eq(customer.id, customerId));
    if (!row) throw new ActionError("not_found", "Cliente não encontrado");
    return { c: row, ...(await asaasConnectionFor(tx, storeId)) };
  });
  if (c.asaasCustomerId && c.asaasAccountKey === accountKey) return c.asaasCustomerId;
  if (!c.cpf) throw new ActionError("invalid_input", "CPF ou CNPJ do cliente é obrigatório para pagar pelo Asaas");
  const created = await client.createCustomer({
    name: c.name,
    email: c.email,
    cpfCnpj: c.cpf,
    mobilePhone: c.phone,
    externalReference: c.id,
  });
  return withStore(storeId, async (tx) => {
    // Só grava se ninguém mudou o id desde a leitura (o id velho de outra conta conta como "não mudou").
    const won = await tx
      .update(customer)
      .set({ asaasCustomerId: created.id, asaasAccountKey: accountKey })
      .where(and(eq(customer.id, c.id), c.asaasCustomerId === null ? isNull(customer.asaasCustomerId) : eq(customer.asaasCustomerId, c.asaasCustomerId)))
      .returning({ id: customer.asaasCustomerId });
    if (won.length > 0) return created.id;
    const [now] = await tx.select({ id: customer.asaasCustomerId, key: customer.asaasAccountKey }).from(customer).where(eq(customer.id, c.id));
    if (!now) throw new ActionError("not_found", "Cliente não encontrado");
    return now.id && now.key === accountKey ? now.id : created.id;
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
  opts: { now?: Date } = {},
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
        // Amanhã no calendário de São Paulo: a cobrança não vence (OVERDUE) antes da validade local de 24 h.
        dueDate: asaasDueDate(opts.now ?? new Date(), 1),
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
          surplus = open.providerId !== created.id;
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

export { SUPERSEDED };

/**
 * Conecta o Asaas: `prepare` testa a chave (GET /finance/balance) e identifica a conta (GET /wallets/) fora de
 * transação, e lê a conexão anterior (só leitura); só então `run` grava. Chave inválida => provider_error e nada é
 * salvo (a rejeição é auditada).
 * Conta diferente da anterior (outra conta ou outro ambiente): as cobranças PENDING da loja viram `superseded`, para o
 * próximo `startAsaasPix` criar a cobrança na conta atual; os clientes são recriados sob demanda (`ensureAsaasCustomer`).
 * Depois do commit (`afterCommit`), as cobranças descartadas são canceladas na conta ANTERIOR com a chave antiga
 * (melhor esforço: falha só vai para o log; o webhook trata evento dessas cobranças sem loop de 500).
 */
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
  async prepare(call, input) {
    const client = createAsaasClient({ apiKey: input.apiKey, env: input.env });
    await client.getBalance();
    const accountKey = await asaasAccountKey(client, input.env, input.apiKey);
    // Só leitura: a chave anterior fica em memória para cancelar, depois do commit, as cobranças da conta anterior.
    const prev = await withStore(call.storeId, (tx) => getIntegration(tx, call.storeId, "asaas"));
    const prevEnv: AsaasEnv = (prev?.config as { env?: string } | undefined)?.env === "production" ? "production" : "sandbox";
    const previous = prev?.secret ? { apiKey: prev.secret, env: prevEnv } : null;
    return { accountKey, previous };
  },
  async run(ctx, input, { accountKey }) {
    const current = await getIntegration(ctx.tx, ctx.storeId, "asaas");
    const cfg = current?.config as { webhookToken?: string; accountKey?: string } | undefined;
    const kept = cfg?.webhookToken;
    const webhookToken = kept && !input.rotateWebhookToken ? kept : randomToken();
    const accountChanged = current !== null && cfg?.accountKey !== accountKey;
    let supersededCharges: string[] = [];
    if (accountChanged) {
      const rows = await ctx.tx
        .update(payment)
        .set({ status: SUPERSEDED })
        .where(and(eq(payment.provider, "asaas"), eq(payment.status, "PENDING")))
        .returning({ providerId: payment.providerId });
      supersededCharges = rows.flatMap((r) => (r.providerId ? [r.providerId] : []));
      log.info("conta Asaas trocada; cobranças abertas da conta anterior descartadas", { storeId: ctx.storeId, count: rows.length });
    }
    await saveIntegration(ctx.tx, ctx.storeId, "asaas", { env: input.env, webhookToken, accountKey }, input.apiKey);
    return { env: input.env, webhookToken, webhookUrl: webhookUrl(ctx.storeId), accountChanged, supersededCharges };
  },
  async afterCommit(call, _input, out, { previous }) {
    if (!out.accountChanged || !previous || out.supersededCharges.length === 0) return;
    const old = createAsaasClient(previous);
    for (const id of out.supersededCharges) {
      try {
        await old.deletePayment(id);
      } catch (e) {
        log.warn("não foi possível cancelar a cobrança na conta Asaas anterior; confira lá", { storeId: call.storeId, paymentId: id, error: e });
      }
    }
  },
});
