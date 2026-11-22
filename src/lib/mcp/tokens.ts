// Token MCP da loja: `fnl_` + storeId (32 hex, sem hífens) + `_` + 32 bytes aleatórios em base64url (43 caracteres).
// Só o sha256 do token inteiro é guardado; o token aparece uma vez, no retorno de `mcpTokens.create` (nunca na
// auditoria nem na lista). A autenticação tira a loja do próprio token e consulta SÓ dentro do RLS dela: token com o
// storeId de uma loja e o segredo de outra não acha linha (o hash é do token inteiro).
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction } from "@/lib/actions/core";
import { hasPermission, type Role } from "@/lib/actions/permissions";
import { randomToken, sha256 } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { approvalRequest, mcpToken, membership, users } from "@/lib/db/schema";
import { lockTeam } from "@/lib/team/rules";

/** Papéis que um token pode ter (o `reader` só existe para tokens). */
export const TOKEN_ROLES = ["owner", "admin", "support", "traffic", "reader"] as const satisfies readonly Role[];

const PREFIX = "fnl_";
const TOKEN_RE = /^fnl_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/;

export function mintMcpToken(storeId: string): { token: string; hash: string; last4: string } {
  const token = `${PREFIX}${storeId.replaceAll("-", "").toLowerCase()}_${randomToken(32)}`;
  return { token, hash: sha256(token), last4: token.slice(-4) };
}

/** 32 hex → UUID com hífens (8-4-4-4-12). */
export const toUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/**
 * Loja, token e papel do token, ou `null` (formato inválido, loja inexistente, hash desconhecido ou revogado: o
 * chamador não distingue os casos). Atualiza `last_used_at` no máximo uma vez por minuto, na mesma transação curta.
 */
export async function authenticateMcpToken(raw: string | null): Promise<{ storeId: string; tokenId: string; role: Role } | null> {
  const m = raw === null ? null : TOKEN_RE.exec(raw);
  if (!m) return null;
  const storeId = toUuid(m[1]!);
  const hash = sha256(raw!);
  return withStore(storeId, async (tx) => {
    const [row] = await tx
      .select({ id: mcpToken.id, role: mcpToken.role })
      .from(mcpToken)
      .where(and(eq(mcpToken.tokenHash, hash), isNull(mcpToken.revokedAt)))
      .limit(1);
    if (!row) return null;
    await tx
      .update(mcpToken)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(mcpToken.id, row.id), sql`(${mcpToken.lastUsedAt} is null or ${mcpToken.lastUsedAt} < now() - interval '1 minute')`));
    return { storeId, tokenId: row.id, role: row.role as Role };
  });
}

export const createMcpToken = defineAction({
  name: "mcpTokens.create",
  description: "Cria um token MCP da loja com um papel. O token só aparece nesta resposta.",
  input: z.object({
    name: z.string().trim().min(1, "Informe um nome para o token").max(60, "O nome do token pode ter no máximo 60 caracteres"),
    role: z.enum(TOKEN_ROLES),
  }),
  permission: "team.manage",
  // Um agente não cria credencial para si (nem com papel maior) sem aprovação.
  sensitive: true,
  // Nunca o token: só o que identifica o pedido.
  auditInput: (i) => ({ name: i.name, role: i.role }),
  async run(ctx, input) {
    // Sob o lock da equipe e com o papel ATUAL de quem cria: um dono rebaixado (ou que saiu) ao mesmo tempo não deixa um
    // token novo para trás, que `revokeTokensCreatedBy` não pegaria.
    await lockTeam(ctx.tx, ctx.storeId);
    if (ctx.actor.kind === "user") {
      const [m] = await ctx.tx
        .select({ role: membership.role })
        .from(membership)
        .where(and(eq(membership.storeId, ctx.storeId), eq(membership.userId, ctx.actor.userId)))
        .limit(1);
      if (!m || !hasPermission(m.role as Role, "team.manage")) throw new ActionError("forbidden", "Sem permissão: team.manage");
    }
    const { token, hash, last4 } = mintMcpToken(ctx.storeId);
    const [row] = await ctx.tx
      .insert(mcpToken)
      .values({
        storeId: ctx.storeId,
        name: input.name,
        role: input.role,
        tokenHash: hash,
        last4,
        createdBy: ctx.actor.kind === "user" ? ctx.actor.userId : null,
      })
      .returning({ id: mcpToken.id });
    return { id: row!.id, token, name: input.name, role: input.role, last4 };
  },
});

export const listMcpTokens = defineAction({
  name: "mcpTokens.list",
  description: "Tokens MCP da loja (nome, papel, 4 últimos caracteres, criado por, último uso, revogado em), sem o token nem o hash.",
  input: z.object({}),
  permission: "team.manage",
  audit: false,
  run: (ctx) =>
    ctx.tx
      .select({
        id: mcpToken.id,
        name: mcpToken.name,
        role: mcpToken.role,
        last4: mcpToken.last4,
        createdAt: mcpToken.createdAt,
        createdBy: users.name,
        lastUsedAt: mcpToken.lastUsedAt,
        revokedAt: mcpToken.revokedAt,
      })
      .from(mcpToken)
      .leftJoin(users, eq(users.id, mcpToken.createdBy))
      .orderBy(desc(mcpToken.createdAt), desc(mcpToken.id)),
});

/**
 * Revoga um token (deixa de autenticar na hora) e cancela os pedidos de aprovação pendentes dele. `false` se o token
 * não existe ou já estava revogado. Pedido pendente do token não pode mais ser aprovado: cancela e apaga a entrada
 * selada. A reivindicação de uma aprovação em andamento trava a linha do token (for share): esta revogação espera o
 * commit dela.
 */
export async function revokeToken(tx: Tx, id: string): Promise<boolean> {
  const revoked = await tx
    .update(mcpToken)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(mcpToken.id, id), isNull(mcpToken.revokedAt)))
    .returning({ id: mcpToken.id });
  if (revoked.length === 0) return false;
  await tx
    .update(approvalRequest)
    .set({ status: "canceled", inputSealed: null, decidedAt: sql`now()` })
    .where(and(eq(approvalRequest.tokenId, id), eq(approvalRequest.status, "pending")));
  return true;
}

export const revokeMcpToken = defineAction({
  name: "mcpTokens.revoke",
  description: "Revoga um token MCP da loja (deixa de autenticar na hora e os pedidos de aprovação pendentes dele são cancelados).",
  input: z.object({ id: z.uuid() }),
  permission: "team.manage",
  sensitive: true,
  async run(ctx, { id }) {
    if (await revokeToken(ctx.tx, id)) return { revoked: true };
    const [found] = await ctx.tx.select({ id: mcpToken.id }).from(mcpToken).where(eq(mcpToken.id, id));
    if (!found) throw new ActionError("not_found", "Token não encontrado");
    return { revoked: false };
  },
});
