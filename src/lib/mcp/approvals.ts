// Fila de aprovação do MCP. Ação sensível pedida por um token vira um pedido (`approvals.request`): entrada validada
// pelo schema da ação-alvo, guardada só selada, com resumo mascarado para o painel, por até 7 dias. Um membro com a
// permissão da ação-alvo aprova (`approvals.approve`: executa a ação em nome dele, com a concessão do runAction que
// reivindica o pedido na mesma transação) ou recusa. O token só lê os próprios pedidos (`approvals.status`), sem resumo
// nem quem decidiu. A entrada selada vira null ao decidir, expirar (varredura `sweep_mcp`) ou cancelar (token revogado).
import "@/lib/actions/all";
import { and, count, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, approvalInputSha256, defineAction, runAction, TOKEN_DENIED, type Action } from "@/lib/actions/core";
import { hasPermission, type Permission, type Role } from "@/lib/actions/permissions";
import { registry } from "@/lib/actions/registry";
import { open, seal } from "@/lib/crypto";
import { db, withStore, type Tx } from "@/lib/db/client";
import { approvalRequest, mcpToken, store, uploadLink, users } from "@/lib/db/schema";
import type { JobHandler } from "@/lib/jobs";
import { log, redact } from "@/lib/log";
import { summarizeRequest, type ApprovalSummary } from "./approval-summary";

/** Entrada da ação-alvo: até 16 KB de JSON. */
const MAX_ARGS_BYTES = 16 * 1024;
const REQUESTS_PER_TOKEN_PER_HOUR = 30;
const PENDING_PER_STORE = 50;
const MAX_ERROR = 500;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "failed" | "canceled";

/** Pendente vencido aparece como `expired` em toda leitura, mesmo antes da varredura (relógio do banco). */
const shownStatus = sql<ApprovalStatus>`case when ${approvalRequest.status} = 'pending' and ${approvalRequest.expiresAt} <= now() then 'expired' else ${approvalRequest.status} end`;
const livePending = and(eq(approvalRequest.status, "pending"), gt(approvalRequest.expiresAt, sql`now()`));

const toolName = (action: string) => action.replaceAll(".", "_");

/** Permissão de membro da ação (nulo se pública ou de sistema: nunca passa pela fila). */
function memberPermission(action: Action<unknown, unknown>): Permission | null {
  return action.permission === "public" || action.permission === "system" ? null : action.permission;
}

/** O token deste papel pode pedir esta ação pela fila: sensível, de permissão que o papel tem e fora de TOKEN_DENIED. */
function requestable(action: Action<unknown, unknown>, role: Role): boolean {
  const p = memberPermission(action);
  return action.sensitive === true && p !== null && !TOKEN_DENIED.includes(p) && hasPermission(role, p);
}

/** O membro deste papel decide pedidos desta ação (D9: quem tem a permissão da ação-alvo). */
function canDecide(action: Action<unknown, unknown> | undefined, role: Role): boolean {
  const p = action ? memberPermission(action) : null;
  return p !== null && hasPermission(role, p);
}

const isUnclaimed = (e: unknown) =>
  e instanceof ActionError && e.code === "conflict" && (e.details as { approval?: unknown } | undefined)?.approval === "unclaimed";

export const requestApproval = defineAction({
  name: "approvals.request",
  description: "Pede a execução de uma ação sensível: fica pendente até alguém da loja aprovar no painel (até 7 dias).",
  input: z.object({ action: z.string().min(1).max(100), args: z.unknown() }),
  permission: "approvals.request",
  // Nunca a entrada da ação-alvo (pode trazer segredo): só qual ação.
  auditInput: (i) => ({ action: i.action }),
  async run(ctx, input) {
    const { actor } = ctx;
    if (actor.kind !== "token") throw new ActionError("forbidden", "Só um token MCP pede pela fila de aprovação");
    const target = registry.get(input.action) as Action<unknown, unknown> | undefined;
    if (!target || !requestable(target, actor.role)) throw new ActionError("forbidden", `Ação indisponível pela fila: ${input.action}`);

    const text = JSON.stringify(input.args ?? null);
    if (new TextEncoder().encode(text).length > MAX_ARGS_BYTES) {
      const message = "Entrada grande demais (máximo 16 KB)";
      throw new ActionError("invalid_input", message, [{ path: ["args"], message, code: "too_big" }]);
    }
    // O que se valida é o que será executado: a entrada como volta do selo (JSON.parse do mesmo texto).
    const args: unknown = JSON.parse(text);
    const parsed = target.input.safeParse(args);
    if (!parsed.success) {
      // Como no runAction: só caminho, mensagem e código, nunca valores.
      const issues = parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code }));
      throw new ActionError("invalid_input", "Entrada inválida", issues);
    }
    const inputSha256 = approvalInputSha256(args);
    const same = and(
      eq(approvalRequest.tokenId, actor.tokenId),
      eq(approvalRequest.action, target.name),
      eq(approvalRequest.inputSha256, inputSha256),
      eq(approvalRequest.status, "pending"),
    );

    // Um pedido por vez na loja: limites e deduplicação sem corrida.
    await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`approvals:${ctx.storeId}`}))`);
    // Pendente vencido igual sai do índice único (vira expired) antes de procurar o existente.
    await ctx.tx
      .update(approvalRequest)
      .set({ status: "expired", inputSealed: null })
      .where(and(same, lte(approvalRequest.expiresAt, sql`now()`)));
    const [existing] = await ctx.tx.select({ id: approvalRequest.id, expiresAt: approvalRequest.expiresAt }).from(approvalRequest).where(same);
    if (existing) return { requestId: existing.id, status: "pending" as const, expiresAt: existing.expiresAt };

    const [{ n: lastHour } = { n: 0 }] = await ctx.tx
      .select({ n: count() })
      .from(approvalRequest)
      .where(and(eq(approvalRequest.tokenId, actor.tokenId), gt(approvalRequest.createdAt, sql`now() - interval '1 hour'`)));
    if (lastHour >= REQUESTS_PER_TOKEN_PER_HOUR) {
      throw new ActionError("rate_limited", `Limite de ${REQUESTS_PER_TOKEN_PER_HOUR} pedidos de aprovação por hora deste token`);
    }
    const [{ n: pending } = { n: 0 }] = await ctx.tx.select({ n: count() }).from(approvalRequest).where(livePending);
    if (pending >= PENDING_PER_STORE) throw new ActionError("rate_limited", `A loja já tem ${PENDING_PER_STORE} pedidos esperando aprovação`);

    const summary = await summarizeRequest(ctx.tx, target, parsed.data);
    const [row] = await ctx.tx
      .insert(approvalRequest)
      .values({
        storeId: ctx.storeId,
        tokenId: actor.tokenId,
        action: target.name,
        inputSealed: seal(text),
        inputSha256,
        summary,
        expiresAt: sql`now() + interval '7 days'`,
      })
      .returning({ id: approvalRequest.id, expiresAt: approvalRequest.expiresAt });
    return { requestId: row!.id, status: "pending" as const, expiresAt: row!.expiresAt };
  },
});

/** O que o agente vê de um pedido (D10): sem resumo, sem entrada e sem quem decidiu. */
export const approvalStatus = defineAction({
  name: "approvals.status",
  description: "Estado dos pedidos de aprovação deste token: um pelo id, ou os 20 mais recentes.",
  input: z.object({ id: z.uuid().optional() }),
  permission: "approvals.request",
  audit: false,
  async run(ctx, input) {
    const { actor } = ctx;
    if (actor.kind !== "token") throw new ActionError("forbidden", "Só um token MCP consulta os próprios pedidos");
    const rows = await ctx.tx
      .select({
        id: approvalRequest.id,
        action: approvalRequest.action,
        status: shownStatus,
        createdAt: approvalRequest.createdAt,
        expiresAt: approvalRequest.expiresAt,
        decidedAt: approvalRequest.decidedAt,
        resultId: approvalRequest.resultId,
        error: approvalRequest.error,
      })
      .from(approvalRequest)
      .where(and(eq(approvalRequest.tokenId, actor.tokenId), input.id ? eq(approvalRequest.id, input.id) : undefined))
      .orderBy(desc(approvalRequest.createdAt), desc(approvalRequest.id))
      .limit(input.id ? 1 : 20);
    if (input.id && rows.length === 0) throw new ActionError("not_found", "Solicitação não encontrada");
    return {
      requests: rows.map((r) => ({
        id: r.id,
        tool: toolName(r.action),
        status: r.status,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        decidedAt: r.decidedAt,
        resultId: r.resultId,
        error: r.error,
      })),
    };
  },
});

function panelRole(actor: { kind: string; role?: Role }): Role {
  if (actor.kind !== "user" || !actor.role) throw new ActionError("forbidden", "Só um membro da loja decide pedidos de aprovação");
  return actor.role;
}

function panelRows(tx: Tx) {
  return tx
    .select({
      id: approvalRequest.id,
      action: approvalRequest.action,
      summary: approvalRequest.summary,
      status: shownStatus,
      createdAt: approvalRequest.createdAt,
      expiresAt: approvalRequest.expiresAt,
      decidedAt: approvalRequest.decidedAt,
      decidedBy: users.name,
      error: approvalRequest.error,
      tokenName: mcpToken.name,
      tokenRole: mcpToken.role,
    })
    .from(approvalRequest)
    .innerJoin(mcpToken, eq(mcpToken.id, approvalRequest.tokenId))
    .leftJoin(users, eq(users.id, approvalRequest.decidedBy));
}

export const listApprovals = defineAction({
  name: "approvals.list",
  description: "Pedidos de aprovação da loja: os pendentes e os 50 últimos decididos, com o resumo mascarado.",
  input: z.object({}),
  permission: "approvals.decide",
  audit: false,
  async run(ctx) {
    const role = panelRole(ctx.actor);
    const pending = await panelRows(ctx.tx).where(livePending).orderBy(desc(approvalRequest.createdAt), desc(approvalRequest.id));
    const history = await panelRows(ctx.tx)
      .where(or(sql`${approvalRequest.status} <> 'pending'`, lte(approvalRequest.expiresAt, sql`now()`)))
      .orderBy(desc(sql`coalesce(${approvalRequest.decidedAt}, ${approvalRequest.expiresAt})`), desc(approvalRequest.id))
      .limit(50);
    const view = (r: (typeof pending)[number]) => {
      const target = registry.get(r.action) as Action<unknown, unknown> | undefined;
      return {
        ...r,
        summary: r.summary as ApprovalSummary,
        tokenRole: r.tokenRole as Role,
        tool: toolName(r.action),
        description: target?.description ?? r.action,
        canDecide: r.status === "pending" && canDecide(target, role),
      };
    };
    return { pending: pending.map(view), history: history.map(view) };
  },
});

export const pendingApprovalsCount = defineAction({
  name: "approvals.pendingCount",
  description: "Número de pedidos de aprovação pendentes (não vencidos) da loja.",
  input: z.object({}),
  permission: "approvals.decide",
  audit: false,
  async run(ctx) {
    const [{ n } = { n: 0 }] = await ctx.tx.select({ n: count() }).from(approvalRequest).where(livePending);
    return { count: n };
  },
});

/** Execução aprovada que falhou (D11): vira `failed` com o erro e sem a entrada; não é re-tentada. Melhor esforço. */
async function markFailed(storeId: string, id: string, userId: string, e: unknown): Promise<void> {
  const text = e instanceof ActionError ? `${e.code}: ${e.message}` : "error: falha interna";
  try {
    await withStore(storeId, (tx) =>
      tx
        .update(approvalRequest)
        .set({ status: "failed", error: (redact(text) as string).slice(0, MAX_ERROR), inputSealed: null, decidedAt: sql`now()`, decidedBy: userId })
        .where(and(eq(approvalRequest.id, id), eq(approvalRequest.status, "pending"))),
    );
  } catch (markErr) {
    log.error("falha ao marcar pedido de aprovação como falho", { id, error: markErr });
  }
}

export const approveRequest = defineAction({
  name: "approvals.approve",
  description: "Aprova um pedido da fila e executa agora a ação pedida, em nome de quem aprova.",
  input: z.object({ id: z.uuid() }),
  permission: "approvals.decide",
  // Fora de transação: o `prepare` da ação-alvo pode chamar um provedor externo. A reivindicação atômica do pedido
  // fica no runAction da ação-alvo (concessão `approval`); esta leitura prévia só dá a mensagem certa e evita abrir a
  // entrada de pedido que não pode mais ser aprovado.
  async prepare(call, { id }) {
    const { actor } = call;
    if (actor.kind !== "user") throw new ActionError("forbidden", "Só um membro da loja decide pedidos de aprovação");
    const [row] = await withStore(call.storeId, (tx) =>
      tx
        .select({ action: approvalRequest.action, inputSealed: approvalRequest.inputSealed, status: shownStatus, revokedAt: mcpToken.revokedAt })
        .from(approvalRequest)
        .innerJoin(mcpToken, eq(mcpToken.id, approvalRequest.tokenId))
        .where(eq(approvalRequest.id, id)),
    );
    if (!row) throw new ActionError("not_found", "Solicitação não encontrada");
    if (row.status === "expired") throw new ActionError("conflict", "Solicitação expirada: peça ao agente para pedir de novo");
    if (row.status !== "pending" || row.inputSealed === null) throw new ActionError("conflict", "Solicitação já decidida ou cancelada");
    if (row.revokedAt !== null) throw new ActionError("conflict", "O token que fez o pedido foi revogado");
    const target = registry.get(row.action) as Action<unknown, unknown> | undefined;
    if (target && !canDecide(target, actor.role)) throw new ActionError("forbidden", `Só quem pode ${target.name} decide este pedido`);

    let args: unknown;
    try {
      if (!target) throw new ActionError("conflict", `A ação pedida não existe mais: ${row.action}`);
      args = JSON.parse(open(row.inputSealed));
    } catch (e) {
      const err = e instanceof ActionError ? e : new ActionError("conflict", "A entrada do pedido não pode ser lida: peça ao agente para pedir de novo");
      await markFailed(call.storeId, id, actor.userId, err);
      throw err;
    }
    try {
      await runAction(target, { storeId: call.storeId, actor, origin: "mcp", approval: { requestId: id } }, args);
    } catch (e) {
      // O conflict da reivindicação (outro aprovou antes, venceu, token revogado) não é falha deste pedido.
      if (!isUnclaimed(e)) await markFailed(call.storeId, id, actor.userId, e);
      throw e;
    }
  },
  async run(ctx, { id }) {
    const [row] = await ctx.tx.select({ resultId: approvalRequest.resultId }).from(approvalRequest).where(eq(approvalRequest.id, id));
    return { status: "approved" as const, resultId: row?.resultId ?? null };
  },
});

export const rejectRequest = defineAction({
  name: "approvals.reject",
  description: "Recusa um pedido da fila (a ação não é executada).",
  input: z.object({ id: z.uuid() }),
  permission: "approvals.decide",
  async run(ctx, { id }) {
    const role = panelRole(ctx.actor);
    const [row] = await ctx.tx.select({ action: approvalRequest.action, status: shownStatus }).from(approvalRequest).where(eq(approvalRequest.id, id)).for("update");
    if (!row) throw new ActionError("not_found", "Solicitação não encontrada");
    if (row.status !== "pending") throw new ActionError("conflict", "Solicitação já decidida, expirada ou cancelada");
    const target = registry.get(row.action) as Action<unknown, unknown> | undefined;
    // Ação que não existe mais: qualquer um com approvals.decide limpa o pedido.
    if (target && !canDecide(target, role)) throw new ActionError("forbidden", `Só quem pode ${target.name} decide este pedido`);
    await ctx.tx
      .update(approvalRequest)
      .set({ status: "rejected", decidedBy: ctx.actor.kind === "user" ? ctx.actor.userId : null, decidedAt: sql`now()`, inputSealed: null })
      .where(and(eq(approvalRequest.id, id), eq(approvalRequest.status, "pending")));
    return { status: "rejected" as const };
  },
});

/**
 * Varredura de hora em hora, loja a loja (a tabela `store` não tem RLS): pendente vencido vira `expired` sem a entrada
 * selada; link de upload não usado e vencido há mais de 24 h é apagado. Falha numa loja não impede as demais; ao
 * final, se alguma falhou, o job falha para tentar de novo.
 */
export const sweepMcpJob: JobHandler = async (_job, signal) => {
  const stores = await db.select({ id: store.id }).from(store);
  let failed = 0;
  for (const { id: storeId } of stores) {
    if (signal.aborted) break;
    try {
      await withStore(storeId, async (tx) => {
        const expired = await tx
          .update(approvalRequest)
          .set({ status: "expired", inputSealed: null })
          .where(and(eq(approvalRequest.status, "pending"), lte(approvalRequest.expiresAt, sql`now()`)))
          .returning({ id: approvalRequest.id });
        const removed = await tx
          .delete(uploadLink)
          .where(and(isNull(uploadLink.usedAt), lt(uploadLink.expiresAt, sql`now() - interval '24 hours'`)))
          .returning({ id: uploadLink.id });
        if (expired.length > 0 || removed.length > 0) log.info("varredura do MCP", { storeId, expired: expired.length, uploadLinks: removed.length });
      });
    } catch (e) {
      failed++;
      log.error("falha na varredura do MCP da loja", { storeId, error: e });
    }
  }
  if (failed > 0) throw new Error(`sweep_mcp falhou em ${failed} loja(s)`);
};
