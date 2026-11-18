import type { z } from "zod";
import { withStore, type Tx } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { log, redact } from "@/lib/log";
import { hasPermission, type Permission, type Role } from "./permissions";
import { registry } from "./registry";

export type Actor = { kind: "user"; userId: string; role: Role } | { kind: "public" } | { kind: "system" };
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

export interface ActionDef<I, O, P = undefined> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  permission: Permission | "public" | "system";
  sensitive?: boolean;
  audit?: boolean;
  /** Projeção da entrada gravada na auditoria (em vez da entrada validada); ainda passa por redact e pelo limite de 8 KB. */
  auditInput?: (input: I) => unknown;
  /**
   * Trabalho externo (ex.: testar uma chave num provedor) que NÃO deve segurar transação. Roda depois de permissão,
   * validação e portão de ação sensível, e antes de `withStore`; o resultado vai como 3º argumento de `run`.
   * Falhas são auditadas como as demais rejeições (só chaves da entrada).
   */
  prepare?: (call: { storeId: string; actor: Actor; origin: Origin }, input: I) => Promise<P>;
  run(ctx: Ctx, input: I, prepared: P): Promise<O>;
  /** Desfaz efeitos fora do banco (ex.: arquivos) se a transação falhar depois de `run` ter sucesso. Melhor esforço: erros são ignorados. */
  compensate?: (call: { storeId: string }, input: I, output: O) => Promise<void>;
}
export type Action<I, O, P = any> = ActionDef<I, O, P>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Define uma ação e a registra (nome único; duplicado lança).
 * `register: false` é para testes: devolve a ação sem tocar no registro global.
 */
export function defineAction<I, O, P = undefined>(def: ActionDef<I, O, P>, opts: { register?: boolean } = {}): Action<I, O, P> {
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
  // runAction NÃO reconsulta `membership`; quem monta o ator (getPanelActor, Task 5)
  // garante que o papel é o atual da loja.
  if (actor.kind !== "user" || !hasPermission(actor.role, action.permission)) {
    throw new ActionError("forbidden", `Sem permissão: ${action.permission}`);
  }
}

/** Única porta de entrada da lógica de negócio (painel, rotas públicas, webhooks, MCP, IA). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runAction<I, O, P = any>(
  action: Action<I, O, P>,
  call: { storeId: string; actor: Actor; origin: Origin },
  raw: unknown,
): Promise<O> {
  const { storeId, actor, origin } = call;
  const audited = action.audit !== false;
  const entry = (input: unknown, ok: boolean, error?: string) => ({
    storeId,
    actor: redact(actor) as object,
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
    authorize(action as Action<unknown, unknown>, actor);
    const parsed = action.input.safeParse(raw);
    if (!parsed.success) {
      // Nunca copia valores crus: só caminho, mensagem e código.
      const issues = parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code }));
      throw new ActionError("invalid_input", "Entrada inválida", issues);
    }
    input = parsed.data;
    if (action.sensitive && (origin === "mcp" || origin === "ai")) {
      throw new ActionError("approval_required", `Ação sensível exige aprovação: ${action.name}`);
    }
    if (action.prepare) prepared = await action.prepare({ storeId, actor, origin }, input);
  } catch (e) {
    if (actor.kind === "public" && e instanceof ActionError && PUBLIC_UNAUDITED.has(e.code)) {
      // Rejeição de requisição anônima: sem linha em audit_log (sem limite nem retenção = disco e pool). Só contador em log.
      log.info("ação pública rejeitada", { action: action.name, code: e.code });
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

  let ran: { out: O } | undefined;
  try {
    return await withStore(storeId, async (tx) => {
      const out = await action.run({ storeId, actor, origin, tx }, input, prepared as P);
      ran = { out };
      if (audited) await tx.insert(auditLog).values(entry(capped(auditView()), true));
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
    await auditFailure(storeId, audited, entry(capped(auditView()), false, describe(e)), e);
    throw e;
  }
}

/** Rejeições pré-execução de ator público que NÃO vão para audit_log. */
const PUBLIC_UNAUDITED: ReadonlySet<ActionErrorCode> = new Set(["forbidden", "invalid_input", "approval_required"]);

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
  return e instanceof Error ? e.message : "erro desconhecido";
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
