// Captura do contato de quem digita e-mail/celular no checkout e ainda não comprou (abandono antes de comprar).
//
// - `checkout.saveLead` (público, sem auditoria): só com a captura ligada na loja (`store.lead_capture`, que exige o
//   e-mail público de privacidade). Upsert por `(store_id, key_hash)`: a `leadKey` do visitante é o que dá direito de
//   alterar a linha (saber o e-mail não basta). Celular sozinho só atualiza linha existente. Linha convertida não muda.
//   Quem já fez pedido da mesma oferta nas últimas 24 h (cliente da loja com o mesmo e-mail) não vira contato novo.
//   Ao CRIAR a linha (nunca ao atualizar), agenda o aviso `lead_abandoned` do Telegram para criada + prazo, na mesma
//   transação, se a loja tem o evento ligado (lê só a config pública; o job confere tudo de novo no envio).
// - `checkout.forgetLead` (público, sem auditoria): "Não salvar meus dados" apaga a linha da chave e, se veio o e-mail
//   digitado, as linhas abertas ou contatadas da loja com o mesmo `email_hash` (outra visita); nunca a convertida.
//   Responde sempre `{ ok: true }` (não revela se havia algo guardado). Limites por chave e por IP.
// - `convertLeads`: na criação do pedido (mesma transação) o contato vira `converted` e perde e-mail e celular.
// - Limites contra abuso, contados na transação da ação (atômicos contra rajada; rollback desfaz a contagem): contatos
//   novos por IP e por loja contam só a linha criada; gravações por chave contam toda tentativa depois de conferir
//   captura e oferta. As chaves usam o `key_hash`, nunca e-mail, celular nem a `leadKey` em claro.
// - Nunca grava e-mail, celular nem `leadKey` em log ou auditoria (as duas ações são `audit: false`).
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { UNKNOWN_IP } from "@/lib/client-ip";
import { checkoutLead, customer, offer, orders, store } from "@/lib/db/schema";
import { enqueue } from "@/lib/jobs";
import { telegramSettings } from "@/lib/notify/telegram-connection";
import { checkRateLimit, ipRateKey } from "@/lib/payments/ratelimit";
import { normalizeBrMobile, validEmail } from "@/lib/validation/br";

/** Retenção do contato: a linha vence 30 dias depois de criada (varredura de hora em hora; vencido já some da lista e do aviso antes dela). */
export const LEAD_TTL_DAYS = 30;
export const LEAD_LIMITS = { newPerIpPerHour: 10, newPerStorePerHour: 500, writesPerKeyPerHour: 20, forgetPerIpPerHour: 20 } as const;
const HOUR = 3600;
const DAY_MS = 86_400_000;
/** Quem fez pedido da mesma oferta nesta janela (qualquer status) não vira contato numa visita nova. */
const RECENT_ORDER_MS = DAY_MS;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const newIpKey = (storeId: string, ip: string) => `leads:new:ip:${storeId}:${ipRateKey(ip)}`;
const newStoreKey = (storeId: string) => `leads:new:store:${storeId}`;
const writeKey = (storeId: string, keyHash: string) => `leads:key:${storeId}:${keyHash}`;
const forgetKey = (storeId: string, keyHash: string) => `leads:forget:${storeId}:${keyHash}`;
const forgetIpKey = (storeId: string, ip: string) => `leads:forget:ip:${storeId}:${ipRateKey(ip)}`;

const leadKey = z.uuid();
const emailInput = z.string().trim().toLowerCase().max(254).refine(validEmail, "Confira o e-mail");

const saveInput = z
  .object({
    slug: z.string().min(1).max(100),
    leadKey,
    email: emailInput.optional(),
    phone: z
      .string()
      .max(30)
      .transform((p, ctx) => {
        const n = normalizeBrMobile(p);
        if (n === null) {
          ctx.addIssue({ code: "custom", message: "Informe um celular com DDD" });
          return z.NEVER;
        }
        return n;
      })
      .optional(),
    /** Preenchido pela borda HTTP (nunca pelo navegador). */
    clientIp: z.string().min(1).max(64),
  })
  .refine((i) => i.email !== undefined || i.phone !== undefined, { message: "Informe o e-mail ou o celular", path: ["email"] });

type SaveOutput = { created: boolean; leadId: string | null };

/** Atualiza a linha da chave (nunca a convertida) com o que veio; devolve o id, ou `null` se não há linha para mudar. */
async function touchLead(ctx: Ctx, keyHash: string, input: { email?: string; phone?: string }): Promise<string | null> {
  const [row] = await ctx.tx
    .update(checkoutLead)
    .set({
      ...(input.email !== undefined ? { email: input.email, emailHash: sha256(input.email) } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(checkoutLead.storeId, ctx.storeId), eq(checkoutLead.keyHash, keyHash), inArray(checkoutLead.status, ["open", "contacted"])))
    .returning({ id: checkoutLead.id });
  return row?.id ?? null;
}

/**
 * A pessoa já fez pedido desta oferta nas últimas 24 h (qualquer status: gerou o Pix e reabriu o link, por exemplo)?
 * O cliente é o da loja com o mesmo e-mail normalizado (único por loja).
 */
async function orderedRecently(ctx: Ctx, offerId: string, email: string): Promise<boolean> {
  const [hit] = await ctx.tx
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(customer, eq(customer.id, orders.customerId))
    .where(
      and(
        eq(orders.storeId, ctx.storeId),
        eq(orders.offerId, offerId),
        eq(customer.email, email),
        gt(orders.createdAt, new Date(Date.now() - RECENT_ORDER_MS)),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

/**
 * Contato criado: agenda o aviso do Telegram para criado + prazo (o prazo vai no payload: o vendedor pode mudá-lo depois).
 * Só com a conexão do Telegram e o evento ligados agora.
 */
async function enqueueLeadNotice(ctx: Ctx, lead: { id: string; createdAt: Date }): Promise<void> {
  const tg = await telegramSettings(ctx.tx, ctx.storeId);
  if (!tg?.events.leadAbandoned) return;
  const afterMinutes = tg.abandonAfterMinutes;
  await enqueue(ctx.tx, {
    storeId: ctx.storeId,
    type: "notify_telegram",
    payload: { event: "lead_abandoned", leadId: lead.id, afterMinutes },
    runAt: new Date(lead.createdAt.getTime() + afterMinutes * 60_000),
  });
}

export const checkoutSaveLead = defineAction({
  name: "checkout.saveLead",
  description: "Guarda o e-mail (e o celular) de quem está preenchendo o checkout, quando a loja liga a captura. Anônima, com limites por IP, loja e chave.",
  input: saveInput,
  permission: "public",
  // Anônima e repetida a cada campo preenchido; e-mail e celular nunca vão para a auditoria.
  audit: false,
  async run(ctx, input): Promise<SaveOutput> {
    const [s] = await ctx.tx.select({ on: store.leadCapture, privacyEmail: store.privacyEmail }).from(store).where(eq(store.id, ctx.storeId));
    if (!s?.on || !s.privacyEmail) throw new ActionError("conflict", "Captura de contato desligada");
    const [o] = await ctx.tx
      .select({ id: offer.id, delivery: offer.delivery })
      .from(offer)
      .where(and(eq(offer.slug, input.slug), eq(offer.active, true)));
    if (!o) throw new ActionError("not_found", "Oferta não encontrada");
    // Oferta de app: o comprador já é conhecido pela sessão do app (e o app fala com ele); nada é guardado nem avisado.
    if (o.delivery === "app") return { created: false, leadId: null };

    // Limites na transação (contagem atômica; rollback desfaz linha, job e contagem). A chave conta toda gravação, mas
    // só depois de conferir captura e oferta: chave inventada em loja sem captura não enche `rate_limit`.
    const keyHash = sha256(input.leadKey);
    if (!(await checkRateLimit(writeKey(ctx.storeId, keyHash), LEAD_LIMITS.writesPerKeyPerHour, HOUR, new Date(), ctx.tx))) {
      throw new ActionError("rate_limited", "Muitas gravações");
    }
    const [existing] = await ctx.tx
      .select({ id: checkoutLead.id, status: checkoutLead.status })
      .from(checkoutLead)
      .where(and(eq(checkoutLead.storeId, ctx.storeId), eq(checkoutLead.keyHash, keyHash)));
    if (existing) {
      if (existing.status !== "converted") await touchLead(ctx, keyHash, input);
      return { created: false, leadId: existing.id };
    }
    // Celular sozinho nunca cria linha.
    if (input.email === undefined) return { created: false, leadId: null };
    // Já tem pedido desta oferta (visita nova depois de gerar o Pix): não é abandono antes de comprar.
    if (await orderedRecently(ctx, o.id, input.email)) return { created: false, leadId: null };

    const [row] = await ctx.tx
      .insert(checkoutLead)
      .values({
        storeId: ctx.storeId,
        offerId: o.id,
        keyHash,
        email: input.email,
        emailHash: sha256(input.email),
        phone: input.phone ?? null,
        expiresAt: new Date(Date.now() + LEAD_TTL_DAYS * DAY_MS),
      })
      .onConflictDoNothing({ target: [checkoutLead.storeId, checkoutLead.keyHash] })
      .returning({ id: checkoutLead.id, createdAt: checkoutLead.createdAt });
    // Outra requisição da mesma chave criou a linha entre a leitura e a gravação: atualiza essa.
    if (!row) return { created: false, leadId: await touchLead(ctx, keyHash, input) };
    // Contato novo conta por IP (se conhecido) e por loja, logo depois de criado: estourou, a transação desfaz tudo.
    const ipOk = input.clientIp === UNKNOWN_IP || (await checkRateLimit(newIpKey(ctx.storeId, input.clientIp), LEAD_LIMITS.newPerIpPerHour, HOUR, new Date(), ctx.tx));
    if (!ipOk || !(await checkRateLimit(newStoreKey(ctx.storeId), LEAD_LIMITS.newPerStorePerHour, HOUR, new Date(), ctx.tx))) {
      throw new ActionError("rate_limited", "Muitos contatos novos");
    }
    await enqueueLeadNotice(ctx, row);
    return { created: true, leadId: row.id };
  },
});

export const checkoutForgetLead = defineAction({
  name: "checkout.forgetLead",
  description:
    "\"Não salvar meus dados\": apaga o contato guardado para a chave do visitante e, com o e-mail digitado, os contatos abertos da loja com esse e-mail (nunca o já convertido em pedido). Responde sempre ok.",
  input: z.object({
    leadKey,
    /** E-mail digitado no formulário (mesma normalização do `saveLead`): alcança o contato de uma visita anterior. */
    email: emailInput.optional(),
    /** Preenchido pela borda HTTP (nunca pelo navegador). */
    clientIp: z.string().min(1).max(64),
  }),
  permission: "public",
  audit: false,
  async run(ctx, input) {
    // Contadores próprios (não dividem a contagem com as gravações: o visitante sempre consegue pedir para apagar), na
    // transação: por chave e, com IP conhecido, por IP (quem testa e-mails alheios esbarra no teto do IP).
    const keyHash = sha256(input.leadKey);
    const now = new Date();
    const keyOk = await checkRateLimit(forgetKey(ctx.storeId, keyHash), LEAD_LIMITS.writesPerKeyPerHour, HOUR, now, ctx.tx);
    const ipOk = input.clientIp === UNKNOWN_IP || (await checkRateLimit(forgetIpKey(ctx.storeId, input.clientIp), LEAD_LIMITS.forgetPerIpPerHour, HOUR, now, ctx.tx));
    if (!keyOk || !ipOk) throw new ActionError("rate_limited", "Muitas tentativas");

    const same: SQL[] = [eq(checkoutLead.keyHash, keyHash)];
    if (input.email !== undefined) same.push(eq(checkoutLead.emailHash, sha256(input.email)));
    // Sem retorno do que foi apagado: a resposta é a mesma com ou sem contato (não revela se o e-mail estava guardado).
    await ctx.tx.delete(checkoutLead).where(and(eq(checkoutLead.storeId, ctx.storeId), inArray(checkoutLead.status, ["open", "contacted"]), or(...same)));
    return { ok: true as const };
  },
});

/**
 * Pedido criado: o contato da loja com o mesmo e-mail (qualquer oferta) ou com a mesma chave da página (mesmo com outro
 * e-mail) vira `converted`, ligado ao pedido, e perde e-mail e celular na hora. Roda na transação do pedido.
 */
export async function convertLeads(tx: Ctx["tx"], storeId: string, input: { email: string; leadKey?: string; orderId: string }): Promise<void> {
  const same: SQL[] = [eq(checkoutLead.emailHash, sha256(input.email.trim().toLowerCase()))];
  if (input.leadKey) same.push(eq(checkoutLead.keyHash, sha256(input.leadKey)));
  await tx
    .update(checkoutLead)
    .set({ status: "converted", orderId: input.orderId, email: null, phone: null, updatedAt: new Date() })
    .where(and(eq(checkoutLead.storeId, storeId), inArray(checkoutLead.status, ["open", "contacted"]), or(...same)));
}
