// Início do teste de um app (`POST /api/integracao/v1/testes`, §7.3 do design de cobrança de apps): o servidor do app
// avisa logo depois do cadastro. Grava um registro de teste (`app_trial`) por (loja, conta) e enfileira o `StartTrial`
// do Meta. O e-mail nunca é guardado em claro (só os hashes, como na recuperação de vendas); nome e telefone são
// aceitos e descartados. ip e user agent só ficam enquanto o `StartTrial` não sai (o job os apaga ao terminar) e, no
// máximo, 7 dias (`sweep_app_trials`); teste que não virou pagamento some em 180 dias (§7.9). O mesmo job limpa as
// sessões de pagamento vencidas (src/lib/apps/sessions.ts): sem pedido, apagadas 7 dias depois de vencer; com pedido,
// a linha fica (o pedido aponta para ela) sem nome, e-mail e telefone (o pedido guarda os dele).
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { sha256 } from "@/lib/crypto";
import { db, withStore } from "@/lib/db/client";
import { appCheckoutSession, appTrial, orders, store } from "@/lib/db/schema";
import { enqueue, type JobHandler } from "@/lib/jobs";
import { log } from "@/lib/log";
import { mailboxHash, recoveryEmailHash } from "@/lib/recovery/rules";
import { META_MAX_EVENT_AGE_MS, metaConnected } from "@/lib/tracking/meta";
import { META_EVENT_ID_RE, REF_MAX, TOUCH_VALUE_MAX, fbcFromFbclid, type TouchRecord } from "@/lib/tracking/touch";
import { validEmail } from "@/lib/validation/br";

/** Event id do `StartTrial` quando o app não mandou o dele (o Pixel do navegador, se disparar, usa o mesmo). */
export const trialEventId = (trialId: string): string => `trial:${trialId}`;

/**
 * `iniciado_em` aceito até a idade em que o job do Meta ainda envia (7 dias menos a margem do job): mais antigo não
 * viraria `StartTrial` e é recusado na entrada.
 */
export const MAX_START_AGE_MS = META_MAX_EVENT_AGE_MS;
/** Folga para relógio adiantado do servidor do app: até isto no futuro é aceito e gravado como agora. */
export const CLOCK_SKEW_MS = 60_000;
/**
 * Retenção (§7.3, §7.9): ip e user agent em no máximo 7 dias; teste que não virou pagamento em no máximo 180 dias.
 * A varredura roda uma vez por dia, então um registro pode esperar até um ciclo depois de passar do corte: os cortes
 * ficam um dia antes do teto (6 e 179 dias) para o teto valer mesmo no pior caso.
 */
export const TRIAL_CLIENT_DATA_MAX_DAYS = 7;
export const TRIAL_RETENTION_MAX_DAYS = 180;
const SWEEP_CYCLE_DAYS = 1;
export const TRIAL_CLIENT_DATA_SWEEP_DAYS = TRIAL_CLIENT_DATA_MAX_DAYS - SWEEP_CYCLE_DAYS;
export const TRIAL_RETENTION_SWEEP_DAYS = TRIAL_RETENTION_MAX_DAYS - SWEEP_CYCLE_DAYS;
/** Sessão de pagamento sem pedido: apagada este tanto de dias depois de vencer (reexportado por sessions.ts). */
export const SESSION_RETENTION_DAYS = 7;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `No máximo ${max} caracteres`)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * Id da conta no app: texto opaco de 1 a 64 caracteres (o mesmo na criação do pagamento). Nunca o e-mail: a conta fica
 * em claro no registro de teste e nos pedidos, então qualquer `@` é recusado.
 */
export const accountSchema = z
  .string()
  .min(1, "Informe a conta")
  .max(64, "A conta pode ter no máximo 64 caracteres")
  .refine((v) => !v.includes("@"), "Use o id interno da conta, não o e-mail");

/** Origem do cadastro no app (UTMs, clique, indicação e cookies do Pixel), com os limites do toque do checkout. */
export const appOriginSchema = z.object({
  utm_source: optionalText(TOUCH_VALUE_MAX),
  utm_medium: optionalText(TOUCH_VALUE_MAX),
  utm_campaign: optionalText(TOUCH_VALUE_MAX),
  utm_content: optionalText(TOUCH_VALUE_MAX),
  utm_term: optionalText(TOUCH_VALUE_MAX),
  fbclid: optionalText(TOUCH_VALUE_MAX),
  ref: optionalText(REF_MAX),
  fbc: optionalText(500),
  fbp: optionalText(500),
});
export type AppOrigin = z.infer<typeof appOriginSchema>;

const TOUCH_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] as const;

/** Primeiro toque gravado (como o `first_touch` do pedido): só UTMs e fbclid preenchidos; nada → null. */
export function originTouch(o: AppOrigin | undefined): TouchRecord | null {
  const out: TouchRecord = {};
  for (const k of TOUCH_FIELDS) if (o?.[k]) out[k] = o[k];
  return Object.keys(out).length > 0 ? out : null;
}

const registerInput = z.object({
  conta: accountSchema,
  email: z.string().trim().max(254).refine(validEmail, "Confira o e-mail"),
  // Aceitos para o app mandar o cadastro inteiro; não são guardados (o funil não vira base de contatos do app).
  nome: z.string().trim().min(2, "Nome curto demais").max(120, "Nome longo demais").optional(),
  telefone: z.string().max(30).optional(),
  origem: appOriginSchema.optional(),
  ip: optionalText(64),
  user_agent: optionalText(500),
  iniciado_em: z.iso
    .datetime({ offset: true, message: "Data e hora ISO 8601" })
    .transform((v) => new Date(v))
    .refine((d) => d.getTime() <= Date.now() + CLOCK_SKEW_MS, "Data no futuro")
    .refine((d) => d.getTime() >= Date.now() - MAX_START_AGE_MS, "Data antiga demais (no máximo 7 dias)")
    .optional(),
  event_id: z.string().regex(META_EVENT_ID_RE, "event_id: 16 a 64 caracteres (letras, números, _ e -)").optional(),
});

export const registerTrial = defineAction({
  name: "apps.registerTrial",
  description: "Registra o início do teste de uma conta do app (idempotente por conta) e enfileira o StartTrial do Meta.",
  input: registerInput,
  permission: "integration.use",
  // Nunca a conta, o e-mail, o nome ou o telefone em claro.
  auditInput: (i) => ({ conta_hash: sha256(i.conta), emailHash: recoveryEmailHash(i.email) }),
  async run(ctx, input): Promise<{ id: string; criado: boolean }> {
    // Sem Meta conectado o StartTrial não sai: ip e user agent não têm para que ser guardados.
    const connected = await metaConnected(ctx.tx, ctx.storeId);
    const id = randomUUID();
    // Relógio do app até 60 s adiantado: vale agora (o `event_time` do Meta nunca fica no futuro).
    const now = new Date();
    const startedAt = input.iniciado_em && input.iniciado_em < now ? input.iniciado_em : now;
    const o = input.origem;
    const [created] = await ctx.tx
      .insert(appTrial)
      .values({
        id,
        storeId: ctx.storeId,
        account: input.conta,
        emailHash: recoveryEmailHash(input.email),
        mailboxHash: mailboxHash(input.email),
        firstTouch: originTouch(o),
        ref: o?.ref ?? null,
        fbc: o?.fbc ?? fbcFromFbclid(o?.fbclid, startedAt.getTime()) ?? null,
        fbp: o?.fbp ?? null,
        clientIp: connected && input.ip && isIP(input.ip) ? input.ip : null,
        userAgent: connected ? (input.user_agent ?? null) : null,
        eventId: input.event_id ?? trialEventId(id),
        startedAt,
      })
      // Chamada repetida (nova tentativa de rede do app) ou simultânea: a segunda espera a primeira e não insere.
      .onConflictDoNothing({ target: [appTrial.storeId, appTrial.account] })
      .returning({ id: appTrial.id });
    if (created) {
      if (connected) await enqueue(ctx.tx, { storeId: ctx.storeId, type: "meta_event", payload: { event: "StartTrial", trialId: created.id } });
      return { id: created.id, criado: true };
    }
    const [existing] = await ctx.tx
      .select({ id: appTrial.id })
      .from(appTrial)
      .where(and(eq(appTrial.storeId, ctx.storeId), eq(appTrial.account, input.conta)));
    if (!existing) throw new Error("app_trial: conflito sem registro");
    return { id: existing.id, criado: false };
  },
});

/**
 * `sweep_app_trials` (global, diário): loja a loja (a tabela `store` não tem RLS), zera ip e user agent dos testes com
 * mais de 6 dias e apaga os testes com mais de 179 dias (um ciclo antes dos tetos de 7 e 180) cuja conta não tem pedido pago nesta loja (pago e depois
 * reembolsado ou contestado também segura: o teste fica enquanto o pedido existir). Também limpa as sessões de
 * pagamento: vencida com pedido perde nome, e-mail e telefone; sem pedido, apagada 7 dias depois de vencer (como a
 * varredura é diária, até 8 dias no pior caso). Falha numa loja não impede as
 * demais; ao final, se alguma falhou, o job falha para tentar de novo. Log só com `storeId` e contagens.
 */
export const sweepAppTrialsJob: JobHandler = async () => {
  const stores = await db.select({ id: store.id }).from(store);
  let failed = 0;
  for (const { id: storeId } of stores) {
    try {
      const [cleared, deleted, sessionsCleared, sessionsDeleted] = await withStore(storeId, async (tx) => [
        await tx
          .update(appTrial)
          .set({ clientIp: null, userAgent: null })
          .where(
            and(
              lt(appTrial.createdAt, sql`now() - make_interval(days => ${TRIAL_CLIENT_DATA_SWEEP_DAYS})`),
              or(isNotNull(appTrial.clientIp), isNotNull(appTrial.userAgent)),
            ),
          )
          .returning({ id: appTrial.id }),
        await tx
          .delete(appTrial)
          .where(
            and(
              lt(appTrial.createdAt, sql`now() - make_interval(days => ${TRIAL_RETENTION_SWEEP_DAYS})`),
              sql`not exists (select 1 from ${orders} where ${orders.storeId} = ${appTrial.storeId} and ${orders.appAccount} = ${appTrial.account} and ${orders.paidAt} is not null)`,
            ),
          )
          .returning({ id: appTrial.id }),
        // Sessão vencida com pedido: o pedido já tem nome, telefone e o e-mail (no cliente); a sessão perde os dela. As
        // colunas são `not null` desde a 0038: o apagamento grava texto vazio (sem migração nova só para isso).
        await tx
          .update(appCheckoutSession)
          .set({ buyerName: "", buyerEmail: "", buyerPhone: null })
          .where(
            and(
              lt(appCheckoutSession.expiresAt, sql`now()`),
              isNotNull(appCheckoutSession.orderId),
              or(sql`${appCheckoutSession.buyerName} <> ''`, sql`${appCheckoutSession.buyerEmail} <> ''`, isNotNull(appCheckoutSession.buyerPhone)),
              sql`exists (select 1 from ${orders} where ${orders.storeId} = ${appCheckoutSession.storeId} and ${orders.id} = ${appCheckoutSession.orderId} and ${orders.buyerName} is not null)`,
            ),
          )
          .returning({ id: appCheckoutSession.id }),
        // Sessão sem pedido, vencida há mais de 7 dias: some (nenhum pedido aponta para ela).
        await tx
          .delete(appCheckoutSession)
          .where(
            and(
              lt(appCheckoutSession.expiresAt, sql`now() - make_interval(days => ${SESSION_RETENTION_DAYS})`),
              isNull(appCheckoutSession.orderId),
              sql`not exists (select 1 from ${orders} where ${orders.storeId} = ${appCheckoutSession.storeId} and ${orders.appSessionId} = ${appCheckoutSession.id})`,
            ),
          )
          .returning({ id: appCheckoutSession.id }),
      ]);
      if (cleared.length > 0 || deleted.length > 0 || sessionsCleared.length > 0 || sessionsDeleted.length > 0) {
        log.info("retenção dos testes do app", {
          storeId,
          cleared: cleared.length,
          deleted: deleted.length,
          sessionsCleared: sessionsCleared.length,
          sessionsDeleted: sessionsDeleted.length,
        });
      }
    } catch (e) {
      failed++;
      log.error("falha na retenção dos testes do app", { storeId, error: e });
    }
  }
  if (failed > 0) throw new Error(`sweep_app_trials falhou em ${failed} loja(s)`);
};
