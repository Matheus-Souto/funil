// Captura do contato de quem digita e-mail/celular no checkout e ainda não comprou (abandono antes de comprar).
//
// - `checkout.saveLead` (público, sem auditoria): só com a captura ligada na loja (`store.lead_capture`, que exige o
//   e-mail público de privacidade). Upsert por `(store_id, key_hash)`: a `leadKey` do visitante é o que dá direito de
//   alterar a linha (saber o e-mail não basta). Celular sozinho só atualiza linha existente. Linha convertida não muda.
//   Quem já fez pedido da mesma oferta nas últimas 24 h (cliente da loja com o mesmo e-mail) não vira contato novo.
//   Ao CRIAR a linha (nunca ao atualizar), agenda o aviso `lead_abandoned` do Telegram para criada + prazo, na mesma
//   transação, se a loja tem o evento ligado (lê só a config pública; o job confere tudo de novo no envio).
// - `checkout.forgetLead` (público, sem auditoria): "Não salvar meus dados" apaga a linha da chave (nunca a convertida);
//   chave sem linha também é ok (não revela nada).
// - `convertLeads`: na criação do pedido (mesma transação) o contato vira `converted` e perde e-mail e celular.
// - Limites contra abuso (contatos novos por IP e por loja contam só a linha criada; gravações por chave contam toda
//   tentativa). As chaves usam o `key_hash`, nunca e-mail, celular nem a `leadKey` em claro.
// - Nunca grava e-mail, celular nem `leadKey` em log ou auditoria (as duas ações são `audit: false`).
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Ctx } from "@/lib/actions/core";
import { UNKNOWN_IP } from "@/lib/client-ip";
import { checkoutLead, customer, offer, orders, store } from "@/lib/db/schema";
import { enqueue } from "@/lib/jobs";
import { telegramSettings } from "@/lib/notify/telegram-connection";
import { checkRateLimit, hitRateLimit, ipRateKey, peekRateLimit } from "@/lib/payments/ratelimit";
import { normalizeBrMobile, validEmail } from "@/lib/validation/br";

/** Retenção do contato: a linha vence 30 dias depois de criada (varredura diária). */
export const LEAD_TTL_DAYS = 30;
export const LEAD_LIMITS = { newPerIpPerHour: 10, newPerStorePerHour: 500, writesPerKeyPerHour: 20 } as const;
const HOUR = 3600;
const DAY_MS = 86_400_000;
/** Quem fez pedido da mesma oferta nesta janela (qualquer status) não vira contato numa visita nova. */
const RECENT_ORDER_MS = DAY_MS;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const newIpKey = (storeId: string, ip: string) => `leads:new:ip:${storeId}:${ipRateKey(ip)}`;
const newStoreKey = (storeId: string) => `leads:new:store:${storeId}`;
const writeKey = (storeId: string, keyHash: string) => `leads:key:${storeId}:${keyHash}`;
const forgetKey = (storeId: string, keyHash: string) => `leads:forget:${storeId}:${keyHash}`;

const leadKey = z.uuid();

const saveInput = z
  .object({
    slug: z.string().min(1).max(100),
    leadKey,
    email: z.string().trim().toLowerCase().max(254).refine(validEmail, "Confira o e-mail").optional(),
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
  /**
   * `checkRateLimit` conta toda tentativa da chave. Os limites de contato NOVO (IP e loja) só são lidos aqui (`peek`):
   * quem decide se vale é `run` (só linha nova) e quem soma é `afterCommit` (só linha criada).
   */
  async prepare(call, input) {
    const keyHash = sha256(input.leadKey);
    if (!(await checkRateLimit(writeKey(call.storeId, keyHash), LEAD_LIMITS.writesPerKeyPerHour, HOUR))) {
      throw new ActionError("rate_limited", "Muitas gravações");
    }
    const knownIp = input.clientIp !== UNKNOWN_IP;
    const [ipOk, storeOk] = await Promise.all([
      knownIp ? peekRateLimit(newIpKey(call.storeId, input.clientIp), LEAD_LIMITS.newPerIpPerHour, HOUR) : true,
      peekRateLimit(newStoreKey(call.storeId), LEAD_LIMITS.newPerStorePerHour, HOUR),
    ]);
    return { keyHash, newOk: ipOk && storeOk };
  },
  /** Soma o contato novo (melhor esforço; falha só vai para o log). */
  async afterCommit(call, input, out: SaveOutput) {
    if (!out.created) return;
    if (input.clientIp !== UNKNOWN_IP) await hitRateLimit(newIpKey(call.storeId, input.clientIp), HOUR);
    await hitRateLimit(newStoreKey(call.storeId), HOUR);
  },
  async run(ctx, input, prepared): Promise<SaveOutput> {
    const [s] = await ctx.tx.select({ on: store.leadCapture, privacyEmail: store.privacyEmail }).from(store).where(eq(store.id, ctx.storeId));
    if (!s?.on || !s.privacyEmail) throw new ActionError("conflict", "Captura de contato desligada");
    const [o] = await ctx.tx.select({ id: offer.id }).from(offer).where(and(eq(offer.slug, input.slug), eq(offer.active, true)));
    if (!o) throw new ActionError("not_found", "Oferta não encontrada");

    const [existing] = await ctx.tx
      .select({ id: checkoutLead.id, status: checkoutLead.status })
      .from(checkoutLead)
      .where(and(eq(checkoutLead.storeId, ctx.storeId), eq(checkoutLead.keyHash, prepared.keyHash)));
    if (existing) {
      if (existing.status !== "converted") await touchLead(ctx, prepared.keyHash, input);
      return { created: false, leadId: existing.id };
    }
    // Celular sozinho nunca cria linha; contato novo respeita os limites de IP e de loja.
    if (input.email === undefined) return { created: false, leadId: null };
    // Já tem pedido desta oferta (visita nova depois de gerar o Pix): não é abandono antes de comprar.
    if (await orderedRecently(ctx, o.id, input.email)) return { created: false, leadId: null };
    if (!prepared.newOk) throw new ActionError("rate_limited", "Muitos contatos novos");

    const [row] = await ctx.tx
      .insert(checkoutLead)
      .values({
        storeId: ctx.storeId,
        offerId: o.id,
        keyHash: prepared.keyHash,
        email: input.email,
        emailHash: sha256(input.email),
        phone: input.phone ?? null,
        expiresAt: new Date(Date.now() + LEAD_TTL_DAYS * DAY_MS),
      })
      .onConflictDoNothing({ target: [checkoutLead.storeId, checkoutLead.keyHash] })
      .returning({ id: checkoutLead.id, createdAt: checkoutLead.createdAt });
    if (row) {
      await enqueueLeadNotice(ctx, row);
      return { created: true, leadId: row.id };
    }
    // Outra requisição da mesma chave criou a linha entre a leitura e a gravação: atualiza essa.
    return { created: false, leadId: await touchLead(ctx, prepared.keyHash, input) };
  },
});

export const checkoutForgetLead = defineAction({
  name: "checkout.forgetLead",
  description: "\"Não salvar meus dados\": apaga o contato guardado para a chave do visitante (nunca o já convertido em pedido).",
  input: z.object({ leadKey }),
  permission: "public",
  audit: false,
  /** Chave própria (não divide a contagem com as gravações: o visitante sempre consegue pedir para apagar). */
  async prepare(call, input) {
    const keyHash = sha256(input.leadKey);
    if (!(await checkRateLimit(forgetKey(call.storeId, keyHash), LEAD_LIMITS.writesPerKeyPerHour, HOUR))) {
      throw new ActionError("rate_limited", "Muitas tentativas");
    }
    return { keyHash };
  },
  async run(ctx, _input, prepared) {
    await ctx.tx
      .delete(checkoutLead)
      .where(and(eq(checkoutLead.storeId, ctx.storeId), eq(checkoutLead.keyHash, prepared.keyHash), inArray(checkoutLead.status, ["open", "contacted"])));
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
