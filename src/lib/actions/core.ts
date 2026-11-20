import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { sha256 } from "@/lib/crypto";
import { withStore, type Tx } from "@/lib/db/client";
import { approvalRequest, auditLog, mcpToken } from "@/lib/db/schema";
import { log, redact, safeErrorMessage } from "@/lib/log";
import { hasPermission, type Permission, type Role } from "./permissions";
import { registry } from "./registry";

/**
 * `token`: agente com token MCP da loja (src/lib/mcp/tokens.ts). Autorizado pelo papel do token como um usuário, menos
 * `TOKEN_DENIED` (sempre forbidden); ação sensível exige aprovação qualquer que seja a origem.
 */
export type Actor =
  | { kind: "user"; userId: string; role: Role }
  | { kind: "token"; tokenId: string; role: Role }
  | { kind: "public" }
  | { kind: "system" };
export type Origin = "panel" | "api" | "mcp" | "ai" | "public" | "system" | "webhook";
export type Ctx = { storeId: string; actor: Actor; origin: Origin; tx: Tx };

export type ActionErrorCode =
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "approval_required"
  | "provider_error"
  | "rate_limited";

export class ActionError extends Error {
  constructor(
    public readonly code: ActionErrorCode,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "ActionError";
  }
}

export interface ActionDef<I, O, P = undefined, S = undefined> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  permission: Permission | "public" | "system";
  sensitive?: boolean;
  audit?: boolean;
  /** Projeção da entrada gravada na auditoria (em vez da entrada validada); ainda passa por redact e pelo limite de 8 KB. */
  auditInput?: (input: I) => unknown;
  /**
   * Parte da saída gravada na auditoria de sucesso, como `result` ao lado da entrada (ou de `auditInput`): ex. um efeito
   * que a ação decidiu sozinha. Também passa por redact e pelo limite de 8 KB; nunca devolva segredo nem dado do comprador.
   */
  auditResult?: (output: O) => unknown;
  /**
   * Trabalho externo (ex.: testar uma chave num provedor) que NÃO deve segurar transação. Roda depois de permissão,
   * validação e portão de ação sensível, e antes de `withStore`; o resultado vai como 3º argumento de `run`.
   * Falhas são auditadas como as demais rejeições (só chaves da entrada).
   */
  prepare?: (call: { storeId: string; actor: Actor; origin: Origin }, input: I) => Promise<P>;
  /**
   * `server`: dados do servidor que NÃO são entrada (ex.: uma chave do ambiente). Vem de `call.server` em `runAction`,
   * fora do schema, do catálogo de ações e da auditoria; quem chama a ação de fora (MCP, IA) não consegue escolhê-los.
   */
  run(ctx: Ctx, input: I, prepared: P, server?: S): Promise<O>;
  /** Desfaz efeitos fora do banco (ex.: arquivos) se a transação falhar depois de `run` ter sucesso. Melhor esforço: erros são ignorados. */
  compensate?: (call: { storeId: string }, input: I, output: O) => Promise<void>;
  /**
   * Efeito externo que só pode acontecer DEPOIS do commit (ex.: cancelar no provedor algo que a transação descartou).
   * Fora de transação; melhor esforço: erros são registrados em log e não mudam o resultado da ação.
   */
  afterCommit?: (call: { storeId: string }, input: I, output: O, prepared: P) => Promise<void>;
}
export type Action<I, O, P = any, S = any> = ActionDef<I, O, P, S>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Define uma ação e a registra (nome único; duplicado lança).
 * `register: false` é para testes: devolve a ação sem tocar no registro global.
 */
export function defineAction<I, O, P = undefined, S = undefined>(def: ActionDef<I, O, P, S>, opts: { register?: boolean } = {}): Action<I, O, P, S> {
  if (opts.register !== false) {
    if (registry.has(def.name)) throw new Error(`Ação já registrada: ${def.name}`);
    registry.set(def.name, def);
  }
  return def;
}

function authorize(action: Action<unknown, unknown>, actor: Actor): void {
  if (action.permission === "public") return;
  if (action.permission === "system") {
    if (actor.kind !== "system") throw new ActionError("forbidden", "Ação restrita ao sistema");
    return;
  }
  // Fronteira de confiança: o papel vem de `actor.role`, informado pelo chamador.
  // runAction NÃO reconsulta `membership` nem `mcp_token`; quem monta o ator (getPanelActor, authenticateMcpToken)
  // garante que o papel é o atual da loja.
  if ((actor.kind !== "user" && actor.kind !== "token") || !hasPermission(actor.role, action.permission)) {
    throw new ActionError("forbidden", `Sem permissão: ${action.permission}`);
  }
  // Token MCP nunca administra a equipe (nem os próprios tokens) nem uma conta, qualquer que seja o papel.
  if (actor.kind === "token" && TOKEN_DENIED.includes(action.permission)) {
    throw new ActionError("forbidden", `Sem permissão: ${action.permission}`);
  }
}

/** Teto de cada consulta numa transação de origem `mcp` (`set local`: vale só para a transação). */
const MCP_STATEMENT_TIMEOUT = "5s";

/**
 * Permissões que um token MCP nunca tem, qualquer que seja o papel (o catálogo do MCP também as deixa de fora): a equipe
 * (e os próprios tokens), uma conta e a decisão da fila de aprovação.
 */
export const TOKEN_DENIED: readonly Permission[] = ["team.manage", "account.self", "approvals.decide"];

/**
 * Concessão de aprovação: executa uma ação pedida pela fila do MCP (`approval_request`) em nome do aprovador. Só vale
 * para um membro (`actor.kind === "user"`, autorizado com o próprio papel) com origem `mcp`, e nunca para ação de
 * `TOKEN_DENIED`; pula o portão de ação sensível porque a linha da fila é reivindicada (pendente -> aprovada) na MESMA
 * transação de `run`, antes dele: sem linha reivindicada nada roda, e uma falha em `run` devolve a linha a pendente.
 * O hash da entrada é calculado aqui (`sha256(JSON.stringify(raw))`), nunca informado por quem chama.
 */
export type ApprovalGrant = { requestId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `details.approval === "unclaimed"` distingue este `conflict` do `conflict` da própria ação (ex.: slug duplicado). */
const unclaimed = () => new ActionError("conflict", "Solicitação já decidida, expirada ou cancelada", { approval: "unclaimed" });

/** Hash da entrada como a fila grava (`approvals.request`): sha256 do JSON. */
export const approvalInputSha256 = (raw: unknown): string => sha256(JSON.stringify(raw ?? null));

/**
 * Reivindica o pedido: pendente, no prazo, desta loja (RLS e filtro), desta ação, com o mesmo hash de entrada e de token
 * não revogado, cujo papel ainda tem a permissão da ação. Trava a linha do token (`for share`) antes: uma revogação
 * concorrente espera o commit desta transação (e então não acha mais o pedido pendente para cancelar), ou, se veio
 * antes, faz esta leitura não achar o token. Apaga a entrada selada na mesma escrita. Devolve o token que pediu; sem
 * linha, lança `unclaimed`.
 */
async function claimApproval(tx: Tx, storeId: string, action: Action<unknown, unknown>, requestId: string, inputSha256: string, userId: string): Promise<string> {
  if (!UUID_RE.test(requestId)) throw unclaimed();
  const [token] = await tx
    .select({ id: mcpToken.id, role: mcpToken.role })
    .from(mcpToken)
    .innerJoin(approvalRequest, eq(approvalRequest.tokenId, mcpToken.id))
    .where(and(eq(approvalRequest.id, requestId), isNull(mcpToken.revokedAt)))
    .for("share", { of: mcpToken });
  if (!token) throw unclaimed();
  const p = action.permission;
  if (p === "public" || p === "system" || !hasPermission(token.role as Role, p)) {
    throw new ActionError("forbidden", `O papel do token que pediu não inclui esta ação: ${action.name}`);
  }
  const [row] = await tx
    .update(approvalRequest)
    .set({ status: "approved", decidedBy: userId, decidedAt: sql`now()`, inputSealed: null })
    .where(
      and(
        eq(approvalRequest.id, requestId),
        eq(approvalRequest.storeId, storeId),
        eq(approvalRequest.tokenId, token.id),
        eq(approvalRequest.action, action.name),
        eq(approvalRequest.status, "pending"),
        gt(approvalRequest.expiresAt, sql`now()`),
        eq(approvalRequest.inputSha256, inputSha256),
      ),
    )
    .returning({ tokenId: approvalRequest.tokenId });
  if (!row) throw unclaimed();
  return row.tokenId;
}

/** `out.id` quando é um UUID (o que `approvals_status` devolve ao agente); qualquer outra coisa vira null. */
function resultIdOf(out: unknown): string | null {
  const id = typeof out === "object" && out !== null ? (out as { id?: unknown }).id : undefined;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
}

/** Única porta de entrada da lógica de negócio (painel, rotas públicas, webhooks, MCP, IA). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runAction<I, O, P = any, S = any>(
  action: Action<I, O, P, S>,
  call: { storeId: string; actor: Actor; origin: Origin; server?: S; approval?: ApprovalGrant },
  raw: unknown,
): Promise<O> {
  const { storeId, actor, origin, approval } = call;
  const audited = action.audit !== false;
  // Execução aprovada: a auditoria diz qual pedido (e, depois de reivindicá-lo, qual token pediu).
  let auditActor: object = approval ? { ...actor, approval: { requestId: approval.requestId } } : actor;
  const approverId = actor.kind === "user" ? actor.userId : undefined;
  const entry = (input: unknown, ok: boolean, error?: string) => ({
    storeId,
    actor: redact(auditActor) as object,
    origin,
    action: action.name,
    input: redact(input) as object,
    ok,
    error: error === undefined ? null : (redact(error) as string),
  });

  const omitted = (code: string) => ({ omitted: code, keys: topKeys(raw) });
  const rejection = (e: unknown) => omitted(e instanceof ActionError ? e.code : "error");

  let input: I;
  let prepared: P | undefined;
  try {
    if (approval && (approverId === undefined || origin !== "mcp")) {
      throw new ActionError("forbidden", "Aprovação só vale para um membro da loja, pela fila do MCP");
    }
    // O que um token nunca pode fazer também não passa pela fila (nem com aprovação de quem pode).
    if (approval && TOKEN_DENIED.includes(action.permission as Permission)) {
      throw new ActionError("forbidden", `Sem permissão pela fila: ${action.permission}`);
    }
    authorize(action as Action<unknown, unknown>, actor);
    const parsed = action.input.safeParse(raw);
    if (!parsed.success) {
      // Nunca copia valores crus: só caminho, mensagem e código.
      const issues = parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code }));
      throw new ActionError("invalid_input", "Entrada inválida", issues);
    }
    input = parsed.data;
    // Pelo ator também: um token MCP chamando por outra origem não escapa da aprovação. Com concessão, quem garante a
    // aprovação é a reivindicação do pedido dentro da transação (claimApproval).
    if (action.sensitive && !approval && (origin === "mcp" || origin === "ai" || actor.kind === "token")) {
      throw new ActionError("approval_required", `Ação sensível exige aprovação: ${action.name}`);
    }
    if (action.prepare) prepared = await action.prepare({ storeId, actor, origin }, input);
  } catch (e) {
    if (actor.kind === "public") {
      // Falha de requisição anônima: sem linha em audit_log (sem limite nem retenção = disco e pool). Só o código em log.
      publicFailure(action.name, e);
    } else {
      await auditFailure(storeId, audited, entry(rejection(e), false, describe(e)), e);
    }
    throw e;
  }

  const auditView = (): unknown => {
    if (!action.auditInput) return input;
    try {
      return action.auditInput(input);
    } catch {
      return { omitted: "audit_input_error", keys: topKeys(raw) };
    }
  };
  const successView = (out: O): unknown => {
    if (!action.auditResult) return auditView();
    let result: unknown;
    try {
      result = action.auditResult(out);
    } catch {
      result = { omitted: "audit_result_error" };
    }
    const view = auditView();
    const base = typeof view === "object" && view !== null && !Array.isArray(view) ? view : { input: view };
    return { ...base, result };
  };

  let ran: { out: O } | undefined;
  let committed: O;
  try {
    committed = await withStore(storeId, async (tx) => {
      // Agente pelo MCP não segura conexão do pool (5) com consulta longa: o banco corta e vira "falha interna".
      if (origin === "mcp") await tx.execute(sql.raw(`set local statement_timeout = '${MCP_STATEMENT_TIMEOUT}'`));
      if (approval) {
        const tokenId = await claimApproval(tx, storeId, action as Action<unknown, unknown>, approval.requestId, approvalInputSha256(raw), approverId!);
        auditActor = { ...actor, approval: { requestId: approval.requestId, tokenId } };
      }
      const out = await action.run({ storeId, actor, origin, tx }, input, prepared as P, call.server);
      ran = { out };
      if (approval) {
        const resultId = resultIdOf(out);
        if (resultId) await tx.update(approvalRequest).set({ resultId }).where(eq(approvalRequest.id, approval.requestId));
      }
      if (audited) await tx.insert(auditLog).values(entry(capped(successView(out)), true));
      return out;
    });
  } catch (e) {
    // A transação principal já foi desfeita; a auditoria de falha vai em outra.
    if (ran && action.compensate) {
      try {
        await action.compensate({ storeId }, input, ran.out);
      } catch (cleanupErr) {
        log.error("falha ao compensar ação", { action: action.name, error: cleanupErr });
      }
    }
    if (actor.kind === "public") publicFailure(action.name, e);
    else await auditFailure(storeId, audited, entry(capped(auditView()), false, describe(e)), e);
    throw e;
  }
  if (action.afterCommit) {
    try {
      await action.afterCommit({ storeId }, input, committed, prepared as P);
    } catch (afterErr) {
      log.error("falha no efeito pós-commit da ação", { action: action.name, error: afterErr });
    }
  }
  return committed;
}

/**
 * Falhas de ator público (antes ou durante a execução) NÃO vão para audit_log: só o código em log.
 * Erro inesperado (não ActionError) continua em log.error para investigação.
 */
function publicFailure(action: string, e: unknown): void {
  if (e instanceof ActionError) log.info("ação pública falhou", { action, code: e.code });
  else log.error("ação pública falhou com erro inesperado", { action, error: e });
}

const MAX_AUDIT_BYTES = 8 * 1024;

/** Só nomes das chaves de primeiro nível (máx. 20, 64 chars); nunca valores. */
function topKeys(v: unknown): string[] {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.keys(v).slice(0, 20).map((k) => k.slice(0, 64));
}

/** Entrada validada para auditoria: se passar de 8 KB serializada, guarda só as chaves. */
function capped(input: unknown): unknown {
  const r = redact(input);
  const size = JSON.stringify(r ?? null).length;
  return size > MAX_AUDIT_BYTES ? { truncated: true, keys: topKeys(input) } : (r ?? {});
}

function describe(e: unknown): string {
  if (e instanceof ActionError) return `${e.code}: ${e.message}`;
  // Erro de consulta ao banco: só o código do Postgres (a mensagem do Drizzle traz os params: CPF, e-mail, nome...).
  return e instanceof Error ? safeErrorMessage(e) : "erro desconhecido";
}

async function auditFailure(storeId: string, audited: boolean, row: typeof auditLog.$inferInsert, e: unknown): Promise<void> {
  if (!(e instanceof ActionError)) log.error("ação falhou com erro inesperado", { action: row.action, error: e });
  if (!audited) return;
  try {
    await withStore(storeId, (tx) => tx.insert(auditLog).values(row));
  } catch (auditErr) {
    log.error("falha ao gravar auditoria de falha", { action: row.action, error: auditErr });
  }
}
