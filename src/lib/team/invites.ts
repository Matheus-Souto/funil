// Convites da equipe por e-mail (spec "Equipe e convites", seções 4 e 5): convidar, reenviar, revogar e consultar o
// resultado do envio. O token (`inv_` + 32 bytes) nasce no `prepare`, vai para o `afterCommit` pelo 3º argumento e
// existe só na memória do processo e no e-mail: no banco fica o sha256. Nunca e-mail, token nem link em log, auditoria
// ou resposta de ação.
import { and, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { randomToken, sha256 } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { membership, store, teamInvite, users } from "@/lib/db/schema";
import { storeBaseUrl } from "@/lib/delivery/links";
import { logEmail, sendMail, type EmailProvider } from "@/lib/delivery/mailer";
import { EMAIL } from "@/lib/delivery/resend";
import { teamInviteEmail } from "@/lib/delivery/templates";
import { errorFields, log } from "@/lib/log";
import { ROLE_LABEL } from "@/lib/orders/labels";
import { checkRateLimit } from "@/lib/payments/ratelimit";
import { emailProviderReady } from "@/lib/recovery/settings";
import { lockTeam, requireCurrentManager } from "./lock";
import { INVITE_ROLES, TEAM, canGrant, inviteTokenHash, seatsUsed } from "./rules";

const DAY_MS = 86_400_000;
const DAY_SEC = 86_400;
const NOT_CONNECTED = "Para convidar alguém, conecte o e-mail da loja em Conexões";
const SEND_FAILED = "Não foi possível enviar o e-mail";
/** Qualquer coisa com cara de endereço de e-mail: o provedor pode ecoar o destinatário na recusa. */
const EMAIL_LIKE = /[^\s@<>"']+@[^\s@<>"']+/;

const inviteToken = (): string => "inv" + "_" + randomToken(32);
const expiryFrom = (now: Date): Date => new Date(now.getTime() + TEAM.inviteDays * DAY_MS);
const emailHashOf = (email: string): string => sha256(email.trim().toLowerCase());
const userIdOf = (actor: { kind: string; userId?: string }): string | null => (actor.kind === "user" && actor.userId ? actor.userId : null);

/**
 * Marca como `expired` (e apaga o e-mail) os convites `pending` da loja cujo prazo passou. Chamar sob `lockTeam`: assim o
 * índice único de convite pendente por e-mail não barra um convite novo para o mesmo endereço.
 */
export async function expireStaleInvites(tx: Tx, storeId: string): Promise<number> {
  const rows = await tx
    .update(teamInvite)
    .set({ status: "expired", email: null, endedAt: sql`now()` })
    .where(and(eq(teamInvite.storeId, storeId), eq(teamInvite.status, "pending"), lte(teamInvite.expiresAt, sql`now()`)))
    .returning({ id: teamInvite.id });
  return rows.length;
}

/**
 * Retenção dos convites de uma loja: pendente vencido vira `expired` (sem e-mail) e convite encerrado há mais de
 * `TEAM.retentionDays` dias, contados a partir de `now`, é apagado.
 */
export async function sweepInvites(storeId: string, now: Date): Promise<{ expired: number; removed: number }> {
  const cutoff = new Date(now.getTime() - TEAM.retentionDays * DAY_MS);
  return withStore(storeId, async (tx) => {
    await lockTeam(tx, storeId);
    const expired = await expireStaleInvites(tx, storeId);
    const gone = await tx
      .delete(teamInvite)
      .where(and(eq(teamInvite.storeId, storeId), isNotNull(teamInvite.endedAt), lt(teamInvite.endedAt, cutoff)))
      .returning({ id: teamInvite.id });
    return { expired, removed: gone.length };
  });
}

/**
 * Texto curto do motivo da falha de envio. Só a mensagem de um `provider_error` nosso é aproveitada (como em
 * `recovery/send.ts`); qualquer outro erro (ex.: a recusa do SMTP, que pode ecoar o destinatário) vira um texto fixo.
 * Máximo de 500 caracteres.
 */
function sendReason(e: unknown): string {
  if (!(e instanceof ActionError) || e.code !== "provider_error") return SEND_FAILED;
  const msg = e.message.trim();
  return (EMAIL_LIKE.test(msg) || msg === "" ? SEND_FAILED : msg).slice(0, 500);
}

/** Lê o convite pelo id, sempre desta loja. */
async function load(tx: Tx, storeId: string, inviteId: string) {
  const [row] = await tx
    .select()
    .from(teamInvite)
    .where(and(eq(teamInvite.id, inviteId), eq(teamInvite.storeId, storeId)))
    .limit(1);
  if (!row) throw new ActionError("not_found", "Convite não encontrado");
  return row;
}

async function requireEmailProvider(storeId: string, message: string): Promise<void> {
  if (await withStore(storeId, (tx) => emailProviderReady(tx, storeId))) return;
  throw new ActionError("invalid_input", message, [{ path: ["email"], message, code: "custom" }]);
}

/** Conta o envio no limite diário da loja (na transação da ação: recusa e rollback não gastam o limite). */
async function chargeDailyLimit(tx: Tx, storeId: string): Promise<void> {
  if (!(await checkRateLimit(`team:invite:${storeId}`, TEAM.invitesPerDay, DAY_SEC, new Date(), tx))) {
    throw new ActionError("rate_limited", `Limite de ${TEAM.invitesPerDay} e-mails de convite por dia atingido. Tente de novo amanhã`);
  }
}

type Prepared = { token: string; senderId: string | null };

/**
 * Depois do commit, fora de transação: envia o e-mail e grava o resultado no convite (`send_status`, `send_error`,
 * e no `email_log`. Só vale para o token que ainda é o do convite (um reenvio
 * concorrente ou uma revogação encerra este envio sem mandar nada). Falha de envio não é erro da ação: vira "Não enviado".
 */
async function deliver(storeId: string, inviteId: string, p: Prepared): Promise<void> {
  const tokenHash = inviteTokenHash(p.token);
  const info = await withStore(storeId, async (tx) => {
    const [inv] = await tx
      .select({ email: teamInvite.email, role: teamInvite.role, status: teamInvite.status, tokenHash: teamInvite.tokenHash, expiresAt: teamInvite.expiresAt })
      .from(teamInvite)
      .where(and(eq(teamInvite.id, inviteId), eq(teamInvite.storeId, storeId)));
    if (!inv || inv.status !== "pending" || inv.email === null || inv.tokenHash !== tokenHash) return null;
    const [s] = await tx.select({ name: store.name, brandColor: store.brandColor, domain: store.domain, slug: store.slug }).from(store).where(eq(store.id, storeId));
    const [u] = p.senderId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, p.senderId)) : [];
    return s ? { to: inv.email, role: inv.role, expiresAt: inv.expiresAt, store: s, inviterName: u?.name?.trim() || s.name } : null;
  });
  if (!info) return;

  const acceptUrl = `${storeBaseUrl(info.store)}/admin/convite/${p.token}`;
  const mail = teamInviteEmail({
    storeName: info.store.name,
    brandColor: info.store.brandColor,
    inviterName: info.inviterName,
    roleLabel: ROLE_LABEL[info.role as keyof typeof ROLE_LABEL] ?? info.role,
    acceptUrl,
    expiresAt: info.expiresAt,
  });
  let provider: EmailProvider | null = null;
  let reason: string | null = null;
  try {
    await sendMail(storeId, { to: info.to, ...mail }, { onProvider: (v) => (provider = v) });
  } catch (e) {
    reason = sendReason(e);
    log.warn("convite: falha no envio do e-mail", { storeId, inviteId, ...errorFields(e) });
  }
  await withStore(storeId, async (tx) => {
    await tx
      .update(teamInvite)
      .set({ sendStatus: reason === null ? "sent" : "failed", sendError: reason })
      .where(and(eq(teamInvite.id, inviteId), eq(teamInvite.tokenHash, tokenHash)));
    await logEmail(tx, { storeId, to: info.to, kind: "team_invite", status: reason === null ? "sent" : "failed", ...(reason === null ? {} : { error: reason }), provider });
  });
}

const preparedFor = (call: { actor: { kind: string; userId?: string } }): Prepared => ({ token: inviteToken(), senderId: userIdOf(call.actor) });

export const inviteMember = defineAction({
  name: "team.invite",
  description: "Convida uma pessoa para a equipe da loja por e-mail (Administrador, Atendimento ou Tráfego). O link vale 7 dias.",
  input: z.object({ email: EMAIL, role: z.enum(INVITE_ROLES) }),
  permission: "team.manage",
  // `team.manage` está em TOKEN_DENIED: nenhum token MCP chega aqui, então não há o que aprovar.
  sensitive: false,
  auditInput: (i) => ({ role: i.role, emailHash: emailHashOf(i.email) }),
  auditResult: (o: { inviteId: string }) => ({ inviteId: o.inviteId }),
  async prepare(call, input) {
    const role = call.actor.kind === "user" || call.actor.kind === "token" ? call.actor.role : null;
    if (!role || !canGrant(role, input.role)) throw new ActionError("forbidden", "Você não pode dar um papel acima do seu");
    await requireEmailProvider(call.storeId, NOT_CONNECTED);
    return preparedFor(call);
  },
  async run(ctx, input, prepared): Promise<{ inviteId: string }> {
    const { storeId, tx } = ctx;
    // O `prepare` já recusou pelo papel da sessão; aqui vale o papel relido sob o lock.
    const me = await requireCurrentManager(tx, storeId, ctx.actor);
    if (!canGrant(me.role, input.role)) throw new ActionError("forbidden", "Você não pode dar um papel acima do seu");
    await expireStaleInvites(tx, storeId);
    const hash = emailHashOf(input.email);
    const [member] = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .innerJoin(users, eq(users.id, membership.userId))
      .where(and(eq(membership.storeId, storeId), sql`lower(${users.email}) = ${input.email}`))
      .limit(1);
    if (member) throw new ActionError("conflict", "Essa pessoa já faz parte da equipe");
    const [dup] = await tx
      .select({ id: teamInvite.id })
      .from(teamInvite)
      .where(and(eq(teamInvite.storeId, storeId), eq(teamInvite.emailHash, hash), eq(teamInvite.status, "pending")))
      .limit(1);
    if (dup) throw new ActionError("conflict", "Já existe um convite para esse e-mail. Use Reenviar");
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(teamInvite)
      .where(and(eq(teamInvite.storeId, storeId), eq(teamInvite.status, "pending")));
    if (pending!.n >= TEAM.maxPending) {
      throw new ActionError("conflict", `A loja já tem ${TEAM.maxPending} convites pendentes. Revogue algum antes de convidar`);
    }
    if ((await seatsUsed(tx, storeId)) >= TEAM.maxSeats) {
      throw new ActionError("conflict", `A equipe chegou a ${TEAM.maxSeats} pessoas, contando os convites pendentes`);
    }
    await chargeDailyLimit(tx, storeId);
    const [row] = await tx
      .insert(teamInvite)
      .values({
        storeId,
        email: input.email,
        emailHash: hash,
        role: input.role,
        tokenHash: inviteTokenHash(prepared.token),
        invitedBy: prepared.senderId,
        // O envio é reservado aqui, sob o lock: o primeiro envio conta 1.
        sendCount: 1,
        lastSentAt: sql`now()`,
        expiresAt: expiryFrom(new Date()),
      })
      .returning({ id: teamInvite.id });
    return { inviteId: row!.id };
  },
  async afterCommit(call, _input, out, prepared) {
    await deliver(call.storeId, out.inviteId, prepared);
  },
});

const inviteIdInput = z.object({ inviteId: z.uuid() });

export const resendInvite = defineAction({
  name: "team.resendInvite",
  description: "Reenvia um convite pendente: gera um link novo (o antigo deixa de valer) e renova o prazo de 7 dias.",
  input: inviteIdInput,
  permission: "team.manage",
  sensitive: false,
  async prepare(call) {
    // O vencimento precisa ficar gravado mesmo quando a ação recusa (a transação da ação desfaria): varre antes.
    await withStore(call.storeId, async (tx) => {
      await lockTeam(tx, call.storeId);
      await expireStaleInvites(tx, call.storeId);
    });
    await requireEmailProvider(call.storeId, "Para reenviar um convite, conecte o e-mail da loja em Conexões");
    return preparedFor(call);
  },
  async run(ctx, { inviteId }, prepared): Promise<{ inviteId: string }> {
    const { storeId, tx } = ctx;
    await requireCurrentManager(tx, storeId, ctx.actor);
    const inv = await load(tx, storeId, inviteId);
    if (inv.status === "expired" || (inv.status === "pending" && inv.expiresAt.getTime() <= Date.now())) {
      throw new ActionError("conflict", "Este convite venceu. Convide de novo");
    }
    if (inv.status !== "pending") throw new ActionError("conflict", "Este convite não está mais pendente");
    if (inv.sendCount >= TEAM.maxSends) {
      throw new ActionError("rate_limited", `Este convite já foi enviado ${TEAM.maxSends} vezes. Revogue e convide de novo`);
    }
    const last = (inv.lastSentAt ?? inv.createdAt).getTime();
    if (Date.now() - last < TEAM.resendGapSec * 1000) {
      throw new ActionError("rate_limited", "Espere 2 minutos para reenviar este convite");
    }
    await chargeDailyLimit(tx, storeId);
    await tx
      .update(teamInvite)
      // Reserva do envio sob o lock (reenvios em paralelo não furam o limite); o resultado antigo não vale para o link novo.
      .set({
        tokenHash: inviteTokenHash(prepared.token),
        expiresAt: expiryFrom(new Date()),
        sendCount: sql`${teamInvite.sendCount} + 1`,
        lastSentAt: sql`now()`,
        sendStatus: null,
        sendError: null,
      })
      .where(and(eq(teamInvite.id, inviteId), eq(teamInvite.status, "pending")));
    return { inviteId };
  },
  async afterCommit(call, _input, out, prepared) {
    await deliver(call.storeId, out.inviteId, prepared);
  },
});

export const revokeInvite = defineAction({
  name: "team.revokeInvite",
  description: "Revoga um convite pendente: o link deixa de valer e o e-mail do convidado é apagado.",
  input: inviteIdInput,
  permission: "team.manage",
  sensitive: false,
  async run(ctx, { inviteId }) {
    await requireCurrentManager(ctx.tx, ctx.storeId, ctx.actor);
    const [row] = await ctx.tx
      .update(teamInvite)
      .set({ status: "revoked", email: null, endedAt: sql`now()` })
      .where(and(eq(teamInvite.id, inviteId), eq(teamInvite.storeId, ctx.storeId), eq(teamInvite.status, "pending")))
      .returning({ id: teamInvite.id });
    if (!row) {
      await load(ctx.tx, ctx.storeId, inviteId);
      throw new ActionError("conflict", "Este convite já foi encerrado");
    }
    return { inviteId: row.id };
  },
});

export const inviteStatus = defineAction({
  name: "team.inviteStatus",
  description: "Resultado do último envio do e-mail de um convite (enviado ou não), com o motivo curto da falha.",
  input: inviteIdInput,
  permission: "team.manage",
  audit: false,
  async run(ctx, { inviteId }) {
    const inv = await load(ctx.tx, ctx.storeId, inviteId);
    return { sendStatus: inv.sendStatus as "sent" | "failed" | null, sendError: inv.sendError };
  },
});
