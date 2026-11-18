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

export interface ActionDef<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  permission: Permission | "public" | "system";
  sensitive?: boolean;
  audit?: boolean;
  run(ctx: Ctx, input: I): Promise<O>;
}
export type Action<I, O> = ActionDef<I, O>;

/**
 * Define uma ação e a registra (nome único; duplicado lança).
 * `register: false` é para testes: devolve a ação sem tocar no registro global.
 */
export function defineAction<I, O>(def: ActionDef<I, O>, opts: { register?: boolean } = {}): Action<I, O> {
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
export async function runAction<I, O>(
  action: Action<I, O>,
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

  let input: I;
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
  } catch (e) {
    await auditFailure(storeId, audited, entry(raw, false, describe(e)), e);
    throw e;
  }

  try {
    return await withStore(storeId, async (tx) => {
      const out = await action.run({ storeId, actor, origin, tx }, input);
      if (audited) await tx.insert(auditLog).values(entry(input, true));
      return out;
    });
  } catch (e) {
    // A transação principal já foi desfeita; a auditoria de falha vai em outra.
    await auditFailure(storeId, audited, entry(input, false, describe(e)), e);
    throw e;
  }
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
