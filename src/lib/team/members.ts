// Gerir a equipe (spec "Equipe e convites", seções 4.1, 4.2, 7 e 8): trocar papel, remover, sair da loja e as lojas da
// própria conta. Toda mutação pega `lockTeam` e relê, sob o lock, o papel ATUAL de quem age (o ator chega com o papel
// lido no início da requisição): uma sessão rebaixada ou removida no meio do caminho não gere mais a equipe.
// `users`, `membership`, `session` e `store` são globais (sem RLS): toda consulta filtra pela loja e pelo usuário.
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, type Actor } from "@/lib/actions/core";
import { hasPermission, type Role } from "@/lib/actions/permissions";
import type { Tx } from "@/lib/db/client";
import { membership, session, store } from "@/lib/db/schema";
import { storeBaseUrl } from "@/lib/delivery/links";
import { env } from "@/lib/env";
import { canGrant, lockTeam, ownerCount, revokeTokensCreatedBy } from "./rules";

/** Papéis de uma pessoa na loja (o `reader` só existe para tokens: `membership_role_check`). */
export const MEMBER_ROLES = ["owner", "admin", "support", "traffic"] as const;

const LAST_OWNER = "A loja precisa de pelo menos um dono";
const ABOVE_YOURS = "Você não pode mexer num papel acima do seu";

const userIdOf = (actor: Actor): string => {
  if (actor.kind !== "user") throw new ActionError("forbidden", "Só usuários do painel");
  return actor.userId;
};

async function roleIn(tx: Tx, storeId: string, userId: string): Promise<Role | null> {
  const [m] = await tx
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.storeId, storeId), eq(membership.userId, userId)))
    .limit(1);
  return (m?.role as Role | undefined) ?? null;
}

/** Sob o lock: o papel atual de quem age, que ainda precisa ter `team.manage`. */
async function managerRole(tx: Tx, storeId: string, actor: Actor): Promise<{ userId: string; role: Role }> {
  const userId = userIdOf(actor);
  const role = await roleIn(tx, storeId, userId);
  if (!role || !hasPermission(role, "team.manage")) throw new ActionError("forbidden", "Sem permissão: team.manage");
  return { userId, role };
}

/** Apaga o vínculo e as sessões da pessoa NESTA loja e revoga os tokens MCP que ela criou aqui. */
async function dropMember(tx: Tx, storeId: string, userId: string): Promise<{ sessionsEnded: number; tokensRevoked: number }> {
  await tx.delete(membership).where(and(eq(membership.storeId, storeId), eq(membership.userId, userId)));
  const ended = await tx
    .delete(session)
    .where(and(eq(session.storeId, storeId), eq(session.userId, userId)))
    .returning({ idHash: session.idHash });
  const tokensRevoked = await revokeTokensCreatedBy(tx, storeId, userId);
  return { sessionsEnded: ended.length, tokensRevoked };
}

/**
 * O papel que a ação leu sob o lock vai para a auditoria: `prepare` devolve esta nota vazia e `run` a preenche (a
 * auditoria é montada depois de `run`, inclusive na falha).
 */
type AuditNote = { from?: Role; userId?: string };
const note = async (): Promise<AuditNote> => ({});

type Removed = { sessionsEnded: number; tokensRevoked: number };
const removedResult = (o: Removed) => ({ sessionsEnded: o.sessionsEnded, tokensRevoked: o.tokensRevoked });

export const changeRole = defineAction({
  name: "team.changeRole",
  description: "Troca o papel de um membro da loja. Rebaixar um dono revoga os tokens MCP que ele criou.",
  input: z.object({ userId: z.uuid(), role: z.enum(MEMBER_ROLES) }),
  permission: "team.manage",
  sensitive: true,
  prepare: note,
  auditInput: (i, p?: AuditNote) => ({ userId: i.userId, from: p?.from, to: i.role }),
  auditResult: (o: { tokensRevoked: number }) => ({ tokensRevoked: o.tokensRevoked }),
  async run(ctx, input, audit): Promise<{ tokensRevoked: number }> {
    const { tx, storeId } = ctx;
    await lockTeam(tx, storeId);
    const me = await managerRole(tx, storeId, ctx.actor);
    const from = await roleIn(tx, storeId, input.userId);
    if (!from) throw new ActionError("not_found", "Membro não encontrado");
    audit.from = from;
    if (!canGrant(me.role, from) || !canGrant(me.role, input.role)) throw new ActionError("forbidden", ABOVE_YOURS);
    const self = input.userId === me.userId;
    if (from === "owner" && !self) throw new ActionError("forbidden", "Um dono não muda o papel de outro dono");
    if (from === input.role) return { tokensRevoked: 0 };
    const leavesOwner = from === "owner";
    if (leavesOwner && (await ownerCount(tx, storeId)) <= 1) throw new ActionError("conflict", LAST_OWNER);
    await tx
      .update(membership)
      .set({ role: input.role })
      .where(and(eq(membership.storeId, storeId), eq(membership.userId, input.userId)));
    // A sessão da pessoa continua: `lookupSession` relê o papel a cada requisição.
    return { tokensRevoked: leavesOwner ? await revokeTokensCreatedBy(tx, storeId, input.userId) : 0 };
  },
});

export const removeMember = defineAction({
  name: "team.remove",
  description: "Remove um membro da loja: apaga o vínculo e as sessões dele nesta loja e revoga os tokens MCP que ele criou aqui.",
  input: z.object({ userId: z.uuid() }),
  permission: "team.manage",
  sensitive: true,
  prepare: note,
  auditInput: (i, p?: AuditNote) => ({ userId: i.userId, role: p?.from }),
  auditResult: removedResult,
  async run(ctx, input, audit): Promise<Removed> {
    const { tx, storeId } = ctx;
    await lockTeam(tx, storeId);
    const me = await managerRole(tx, storeId, ctx.actor);
    if (input.userId === me.userId) throw new ActionError("conflict", "Use Sair da loja");
    const role = await roleIn(tx, storeId, input.userId);
    if (!role) throw new ActionError("not_found", "Membro não encontrado");
    audit.from = role;
    if (!canGrant(me.role, role)) throw new ActionError("forbidden", ABOVE_YOURS);
    if (role === "owner") throw new ActionError("forbidden", "Um dono não remove outro dono");
    return dropMember(tx, storeId, input.userId);
  },
});

export const leaveStore = defineAction({
  name: "team.leave",
  description: "Sai da loja: apaga o próprio vínculo e as próprias sessões desta loja. Um dono só sai se outro dono continuar.",
  input: z.object({}),
  permission: "account.self",
  // `account.self` está em TOKEN_DENIED: um token nunca chega aqui.
  sensitive: true,
  prepare: note,
  auditInput: (_i, p?: AuditNote) => ({ userId: p?.userId, role: p?.from }),
  auditResult: removedResult,
  async run(ctx, _input, audit): Promise<Removed> {
    const { tx, storeId } = ctx;
    const userId = userIdOf(ctx.actor);
    audit.userId = userId;
    await lockTeam(tx, storeId);
    const role = await roleIn(tx, storeId, userId);
    if (!role) throw new ActionError("not_found", "Você não faz parte desta loja");
    audit.from = role;
    if (role === "owner" && (await ownerCount(tx, storeId)) <= 1) throw new ActionError("conflict", LAST_OWNER);
    return dropMember(tx, storeId, userId);
  },
});

type StoresEnv = Pick<typeof env, "MODE" | "BASE_URL" | "PLATFORM_DOMAIN">;

export const accountStores = defineAction({
  name: "account.stores",
  description: "As lojas em que a própria pessoa tem vínculo (nome e endereço do painel). No MODE=single, só a atual.",
  input: z.object({}),
  permission: "account.self",
  audit: false,
  // `server.env` só existe para o teste escolher o modo; quem chama do painel não passa nada (vale o ambiente).
  async run(ctx, _input, _prepared, server?: { env: StoresEnv }) {
    const userId = userIdOf(ctx.actor);
    const e = server?.env ?? env;
    const mine = eq(membership.userId, userId);
    const rows = await ctx.tx
      .select({ storeId: store.id, name: store.name, domain: store.domain, slug: store.slug })
      .from(membership)
      .innerJoin(store, eq(store.id, membership.storeId))
      .where(e.MODE === "single" ? and(mine, eq(membership.storeId, ctx.storeId)) : mine)
      .orderBy(asc(store.name), asc(store.id));
    return rows.map((s) => ({ storeId: s.storeId, name: s.name, panelUrl: `${storeBaseUrl(s, e)}/admin`, current: s.storeId === ctx.storeId }));
  },
});
