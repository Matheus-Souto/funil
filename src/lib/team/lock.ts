// Lock da equipe e o papel ATUAL de quem gere a equipe. Módulo folha (não importa nada de `team/` nem de `mcp/`): as
// ações de equipe e dos tokens MCP usam daqui sem ciclo de import.
// O ator chega com o papel lido no início da requisição e `runAction` não reconsulta `membership`: toda mutação de
// equipe pega o lock e relê o papel aqui, para que uma sessão rebaixada ou removida no meio do caminho não passe.
import { and, eq, sql } from "drizzle-orm";
import { ActionError, type Actor } from "@/lib/actions/core";
import { hasPermission, type Role } from "@/lib/actions/permissions";
import type { Tx } from "@/lib/db/client";
import { membership } from "@/lib/db/schema";

/** Lock da transação por loja: toda mutação de equipe passa por aqui antes de conferir donos e assentos. */
export async function lockTeam(tx: Tx, storeId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"team:" + storeId}))`);
}

/** Papel da pessoa nesta loja, ou `null` sem vínculo. */
export async function memberRole(tx: Tx, storeId: string, userId: string): Promise<Role | null> {
  const [m] = await tx
    .select({ role: membership.role })
    .from(membership)
    .where(and(eq(membership.storeId, storeId), eq(membership.userId, userId)))
    .limit(1);
  return (m?.role as Role | undefined) ?? null;
}

/**
 * Pega o lock da equipe e relê, sob ele, o papel atual de quem age, que precisa ter `team.manage`. Só usuários do
 * painel (um token nunca tem `team.manage`: TOKEN_DENIED). Devolve o id e o papel relido (use este papel, não o do ator).
 */
export async function requireCurrentManager(tx: Tx, storeId: string, actor: Actor): Promise<{ userId: string; role: Role }> {
  await lockTeam(tx, storeId);
  if (actor.kind !== "user") throw new ActionError("forbidden", "Sem permissão: team.manage");
  const role = await memberRole(tx, storeId, actor.userId);
  if (!role || !hasPermission(role, "team.manage")) throw new ActionError("forbidden", "Sem permissão: team.manage");
  return { userId: actor.userId, role };
}
