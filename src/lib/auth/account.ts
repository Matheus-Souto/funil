// Conta e equipe: troca da própria senha (exige a atual; derruba todas as sessões do usuário) e, para o dono, a lista
// de membros da loja com o número de sessões ativas e o encerramento das sessões de um membro.
// `users`, `membership` e `session` são tabelas globais (sem RLS): toda consulta aqui filtra pela loja do ator.
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { db } from "@/lib/db/client";
import { mcpToken, membership, session, teamInvite, users } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/payments/ratelimit";
import { expireStaleInvites } from "@/lib/team/invites";
import { lockTeam, requireCurrentManager } from "@/lib/team/lock";
import { hashPassword, verifyPassword } from "./password";

const MAX_PASSWORD = 256;
/** Tentativas de senha atual por usuário em 15 min (cada uma custa um scrypt). */
const CHANGE_ATTEMPTS = 5;
const CHANGE_WINDOW_SEC = 15 * 60;

const userIdOf = (actor: { kind: string; userId?: string }) => {
  if (actor.kind !== "user" || !actor.userId) throw new ActionError("forbidden", "Só usuários do painel");
  return actor.userId;
};

/**
 * Troca a própria senha. A senha atual é conferida e a nova é gerada no `prepare` (scrypt fora de transação); a
 * transação grava o hash, desliga a troca obrigatória e apaga TODAS as sessões do usuário (todas as lojas e aparelhos):
 * quem chamou recebe uma sessão nova logo depois (server action). Senhas nunca vão para a auditoria.
 */
export const changePassword = defineAction({
  name: "account.changePassword",
  description: "Troca a senha de quem está no painel (exige a senha atual) e encerra as outras sessões.",
  input: z.object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD),
    newPassword: z.string().min(10, "A senha nova precisa ter no mínimo 10 caracteres").max(MAX_PASSWORD),
  }),
  permission: "account.self",
  // Trocar a senha tira o acesso do dono da conta: MCP/IA nunca fazem isso sem aprovação.
  sensitive: true,
  auditInput: () => ({}),
  async prepare(call, input) {
    const userId = userIdOf(call.actor);
    if (!(await checkRateLimit(`account:password:${userId}`, CHANGE_ATTEMPTS, CHANGE_WINDOW_SEC))) {
      throw new ActionError("rate_limited", "Muitas tentativas. Espere 15 minutos e tente de novo.");
    }
    const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u || !(await verifyPassword(input.currentPassword, u.passwordHash))) {
      throw new ActionError("forbidden", "A senha atual não confere");
    }
    if (input.newPassword === input.currentPassword) throw new ActionError("invalid_input", "A senha nova precisa ser diferente da atual");
    return { passwordHash: await hashPassword(input.newPassword) };
  },
  async run(ctx, _input, prepared) {
    const userId = userIdOf(ctx.actor);
    await ctx.tx.update(users).set({ passwordHash: prepared.passwordHash, mustChangePassword: false }).where(eq(users.id, userId));
    const ended = await ctx.tx.delete(session).where(eq(session.userId, userId)).returning({ idHash: session.idHash });
    return { userId, sessionsEnded: ended.length };
  },
});

export const listTeam = defineAction({
  name: "team.list",
  description:
    "Membros da loja (nome, e-mail, papel) com o número de sessões ativas no painel desta loja e os convites pendentes (e-mail, papel, validade, resultado do envio).",
  input: z.object({}),
  permission: "team.manage",
  audit: false,
  async run(ctx) {
    // Convites com prazo vencido viram `expired` (sem e-mail) na leitura, sob o lock da equipe.
    await lockTeam(ctx.tx, ctx.storeId);
    await expireStaleInvites(ctx.tx, ctx.storeId);
    const active = ctx.tx
      .select({ userId: session.userId, n: count().as("n") })
      .from(session)
      .where(and(eq(session.storeId, ctx.storeId), gt(session.expiresAt, sql`now()`)))
      .groupBy(session.userId)
      .as("active");
    // Tokens MCP ainda ativos que cada pessoa criou nesta loja (o aviso de quantos serão revogados ao rebaixar/remover).
    const tokens = ctx.tx
      .select({ createdBy: mcpToken.createdBy, tokenCount: count().as("token_count") })
      .from(mcpToken)
      .where(and(eq(mcpToken.storeId, ctx.storeId), isNull(mcpToken.revokedAt)))
      .groupBy(mcpToken.createdBy)
      .as("tokens");
    const rows = await ctx.tx
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: membership.role,
        mustChangePassword: users.mustChangePassword,
        activeSessions: sql<number>`coalesce(${active.n}, 0)::int`,
        tokensCreated: sql<number>`coalesce(${tokens.tokenCount}, 0)::int`,
      })
      .from(membership)
      .innerJoin(users, eq(users.id, membership.userId))
      .leftJoin(active, eq(active.userId, membership.userId))
      .leftJoin(tokens, eq(tokens.createdBy, membership.userId))
      .where(eq(membership.storeId, ctx.storeId))
      .orderBy(users.email);
    const me = ctx.actor.kind === "user" ? ctx.actor.userId : null;
    const members = rows.map((r) => ({ ...r, activeSessions: Number(r.activeSessions), tokensCreated: Number(r.tokensCreated), isYou: r.userId === me }));
    const invites = await ctx.tx
      .select({
        id: teamInvite.id,
        email: teamInvite.email,
        role: teamInvite.role,
        expiresAt: teamInvite.expiresAt,
        sendStatus: teamInvite.sendStatus,
        sendError: teamInvite.sendError,
        lastSentAt: teamInvite.lastSentAt,
      })
      .from(teamInvite)
      .where(and(eq(teamInvite.storeId, ctx.storeId), eq(teamInvite.status, "pending")))
      .orderBy(desc(teamInvite.createdAt), teamInvite.id);
    return { members, invites };
  },
});

/**
 * Encerra todas as sessões de um membro NESTA loja (as de outras lojas, no MODE=multi, não são da conta do dono). Nunca
 * as de outro dono.
 */
export const revokeMemberSessions = defineAction({
  name: "team.revokeSessions",
  description: "Encerra todas as sessões de um membro da loja no painel (ele precisa entrar de novo).",
  input: z.object({ userId: z.uuid() }),
  permission: "team.manage",
  sensitive: true,
  async run(ctx, { userId }) {
    const me = await requireCurrentManager(ctx.tx, ctx.storeId, ctx.actor);
    if (me.userId === userId) throw new ActionError("conflict", "Para encerrar as suas outras sessões, troque a sua senha");
    const [m] = await ctx.tx
      .select({ role: membership.role })
      .from(membership)
      .where(and(eq(membership.storeId, ctx.storeId), eq(membership.userId, userId)))
      .limit(1);
    if (!m) throw new ActionError("not_found", "Membro não encontrado");
    // P1, como em `team.changeRole`: um sócio não derruba o outro (o próprio caso já foi recusado acima).
    if (m.role === "owner") throw new ActionError("forbidden", "Um dono não encerra as sessões de outro dono");
    const ended = await ctx.tx
      .delete(session)
      .where(and(eq(session.userId, userId), eq(session.storeId, ctx.storeId)))
      .returning({ idHash: session.idHash });
    return { revoked: ended.length };
  },
});
