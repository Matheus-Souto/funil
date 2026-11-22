// Regras de equipe: quem pode conceder qual papel, limites, lock por loja, donos, assentos e revogação dos tokens MCP
// de quem deixa de ser dono (spec "Equipe e convites", seção 4). Só lógica e consultas: as ações usam estas funções
// dentro da própria transação.
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { ROLE_PERMISSIONS, type Role } from "@/lib/actions/permissions";
import { sha256 } from "@/lib/crypto";
import type { Tx } from "@/lib/db/client";
import { mcpToken, membership, teamInvite } from "@/lib/db/schema";
import { revokeToken } from "@/lib/mcp/tokens";

export const TEAM = {
  /** Validade do convite. */
  inviteDays: 7,
  /** Convites pendentes por loja (contam também os que falharam no envio). */
  maxPending: 20,
  /** Membros mais convites pendentes por loja. */
  maxSeats: 50,
  /** E-mails de convite por loja a cada 24 h (envios e reenvios). */
  invitesPerDay: 30,
  /** Intervalo mínimo entre reenvios do mesmo convite. */
  resendGapSec: 120,
  /** Envios por convite (o primeiro mais os reenvios). */
  maxSends: 5,
  /** Tentativas de aceite por IP na janela. */
  acceptPerIp: 10,
  /** Tentativas de aceite por convite na janela. */
  acceptPerInvite: 10,
  acceptWindowSec: 900,
  /** Dias que um convite encerrado fica no banco antes da limpeza. */
  retentionDays: 30,
} as const;

/** Papéis que um convite pode dar: nunca `owner` (vira dono por promoção de quem já é membro). */
export const INVITE_ROLES = ["admin", "support", "traffic"] as const;

/** O papel-alvo só tem permissões que o ator também tem. Vale ao convidar, trocar papel e remover. */
export function canGrant(actor: Role, target: Role): boolean {
  const has = new Set<string>(ROLE_PERMISSIONS[actor]);
  return ROLE_PERMISSIONS[target].every((p) => has.has(p));
}

export { lockTeam } from "./lock";

export async function ownerCount(tx: Tx, storeId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(membership)
    .where(and(eq(membership.storeId, storeId), eq(membership.role, "owner")));
  return row!.n;
}

/** Membros mais convites `pending` ainda no prazo. */
export async function seatsUsed(tx: Tx, storeId: string): Promise<number> {
  const [members] = await tx.select({ n: sql<number>`count(*)::int` }).from(membership).where(eq(membership.storeId, storeId));
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(teamInvite)
    .where(and(eq(teamInvite.storeId, storeId), eq(teamInvite.status, "pending"), gt(teamInvite.expiresAt, sql`now()`)));
  return members!.n + pending!.n;
}

/**
 * Revoga os tokens MCP ainda ativos que o usuário criou nesta loja (cancelando os pedidos pendentes deles, como
 * `mcpTokens.revoke`). Devolve quantos foram revogados.
 */
export async function revokeTokensCreatedBy(tx: Tx, storeId: string, userId: string): Promise<number> {
  const rows = await tx
    .select({ id: mcpToken.id })
    .from(mcpToken)
    .where(and(eq(mcpToken.storeId, storeId), eq(mcpToken.createdBy, userId), isNull(mcpToken.revokedAt)))
    .orderBy(mcpToken.id);
  let n = 0;
  for (const { id } of rows) if (await revokeToken(tx, id)) n++;
  return n;
}

export const inviteTokenHash = (token: string): string => sha256(token);
