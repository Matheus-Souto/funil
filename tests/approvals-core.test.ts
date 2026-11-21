// Concessão de aprovação no runAction (fila do MCP, PR 6): uma ação sensível só roda pelo MCP com `call.approval`, que
// reivindica a linha de `approval_request` (pendente, no prazo, da mesma loja, ação e hash, de token não revogado) na
// mesma transação de `run`. Sem concessão, ou com concessão inválida, nada roda e o banco não muda. Também o gancho
// `auditResult`. Os pedidos são semeados direto na tabela (o módulo da fila é a Task 2).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError, defineAction, runAction, TOKEN_DENIED, type Actor, type Origin } from "@/lib/actions/core";
import { hasPermission, type Role } from "@/lib/actions/permissions";
import { seal, sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { approvalRequest, auditLog, mcpToken, users } from "@/lib/db/schema";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const def = { register: false } as const;
const DAY_MS = 86_400_000;

/** Ação sensível de teste (permissão `orders.refund`, que o suporte não tem) que conta as execuções. */
function refundLike(name: string, opts: { fail?: boolean; out?: unknown } = {}) {
  const calls: unknown[] = [];
  const action = defineAction(
    {
      name,
      description: "x",
      input: z.object({ orderId: z.string() }),
      permission: "orders.refund",
      sensitive: true,
      run: async (_ctx, input) => {
        calls.push(input);
        if (opts.fail) throw new ActionError("provider_error", "provedor fora do ar");
        return opts.out ?? { ok: true };
      },
    },
    def,
  );
  return { action, calls };
}

async function seedUser(): Promise<string> {
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email: `aprovador-${randomUUID()}@example.com`, name: "Aprovadora", passwordHash: "x" })
    .returning({ id: users.id });
  return u!.id;
}

async function seedToken(storeId: string, role: Role = "owner"): Promise<string> {
  const [tok] = await t.ownerDb
    .insert(mcpToken)
    .values({ storeId, name: "agente", role, tokenHash: randomBytes(32).toString("hex"), last4: "abcd" })
    .returning({ id: mcpToken.id });
  return tok!.id;
}

/** Loja com um token MCP e um aprovador (usuário de verdade: `decided_by` → users). */
async function setup(role: Role = "owner") {
  const { storeId } = await seedStore("Aprovações");
  const approver: Actor = { kind: "user", userId: await seedUser(), role };
  const tokenId = await seedToken(storeId);
  return { storeId, approver, tokenId };
}

/** Pedido pendente semeado direto na tabela (papel dono), com a entrada selada e o hash dela. */
async function seedRequest(
  storeId: string,
  tokenId: string,
  action: string,
  input: unknown,
  extra: Partial<typeof approvalRequest.$inferInsert> = {},
) {
  const [row] = await t.ownerDb
    .insert(approvalRequest)
    .values({
      storeId,
      tokenId,
      action,
      inputSealed: seal(JSON.stringify(input)),
      inputSha256: sha256(JSON.stringify(input)),
      summary: { title: "Reembolsar pedido" },
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      ...extra,
    })
    .returning({ id: approvalRequest.id });
  return { requestId: row!.id };
}

const requestRow = async (id: string) => (await t.ownerDb.select().from(approvalRequest).where(eq(approvalRequest.id, id)))[0]!;
const auditRows = (storeId: string, action: string) => withStore(storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)));
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ActionError ? e.code : String(e)));
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ActionError);

describe("permissões da fila", () => {
  test("approvals.request em todos os papéis; approvals.decide em owner, admin, support e traffic, e nunca para token", async () => {
    for (const role of ["owner", "admin", "support", "traffic", "reader"] as const) expect(hasPermission(role, "approvals.request"), role).toBe(true);
    for (const role of ["owner", "admin", "support", "traffic"] as const) expect(hasPermission(role, "approvals.decide"), role).toBe(true);
    expect(hasPermission("reader", "approvals.decide")).toBe(false);
    expect(TOKEN_DENIED).toEqual(["team.manage", "account.self", "approvals.decide", "leads.read", "leads.write"]);

    const { storeId, approver, tokenId } = await setup();
    let calls = 0;
    const decide = defineAction({ name: "t.appr.decide", description: "x", input: z.object({}), permission: "approvals.decide", run: async () => ++calls }, def);
    expect(await code(runAction(decide, { storeId, actor: { kind: "token", tokenId, role: "owner" }, origin: "mcp" }, {}))).toBe("forbidden");
    expect(await runAction(decide, { storeId, actor: approver, origin: "panel" }, {})).toBe(1);
  });
});

describe("portão de ação sensível", () => {
  test("ação sensível com ator token, ou origem mcp sem approval → approval_required, sem efeito", async () => {
    const { storeId, approver, tokenId } = await setup();
    const { action, calls } = refundLike("t.appr.gate");
    const { requestId } = await seedRequest(storeId, tokenId, action.name, { orderId: "o1" });
    const token: Actor = { kind: "token", tokenId, role: "owner" };
    const cases: { actor: Actor; origin: Origin }[] = [
      { actor: token, origin: "mcp" },
      { actor: token, origin: "panel" },
      { actor: approver, origin: "mcp" },
      { actor: approver, origin: "ai" },
    ];
    for (const c of cases) expect(await code(runAction(action, { storeId, ...c }, { orderId: "o1" }))).toBe("approval_required");
    expect(calls).toEqual([]);
    expect(await requestRow(requestId)).toMatchObject({ status: "pending", decidedBy: null, decidedAt: null });
  });

  test("approval com ator token ou origem panel → forbidden", async () => {
    const { storeId, approver, tokenId } = await setup();
    const { action, calls } = refundLike("t.appr.wrongcaller");
    const input = { orderId: "o1" };
    const { requestId } = await seedRequest(storeId, tokenId, action.name, input);
    const approval = { requestId };
    const token: Actor = { kind: "token", tokenId, role: "owner" };
    expect(await code(runAction(action, { storeId, actor: token, origin: "mcp", approval }, input))).toBe("forbidden");
    expect(await code(runAction(action, { storeId, actor: approver, origin: "panel", approval }, input))).toBe("forbidden");
    expect(await code(runAction(action, { storeId, actor: { kind: "system" }, origin: "mcp", approval }, input))).toBe("forbidden");
    expect(calls).toEqual([]);
    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: "pending", decidedBy: null });
    expect(row.inputSealed).not.toBeNull();
  });
});

describe("concessão de aprovação", () => {
  test("approval válido: roda uma vez, linha vira approved com decided_by e input_sealed nulo, auditoria com origin mcp e actor.approval { requestId, tokenId }", async () => {
    const { storeId, approver, tokenId } = await setup();
    const resultId = randomUUID();
    const { action, calls } = refundLike("t.appr.ok", { out: { id: resultId, ok: true } });
    const input = { orderId: "o1" };
    const { requestId } = await seedRequest(storeId, tokenId, action.name, input);

    const out = await runAction(action, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, input);
    expect(out).toEqual({ id: resultId, ok: true });
    expect(calls).toEqual([input]);

    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: "approved", decidedBy: (approver as { userId: string }).userId, inputSealed: null, resultId, error: null });
    expect(row.decidedAt).toBeInstanceOf(Date);

    const [audit] = await auditRows(storeId, action.name);
    expect(audit).toMatchObject({ origin: "mcp", ok: true, input });
    expect(audit!.actor).toEqual({ ...approver, approval: { requestId, tokenId } });

    // A mesma concessão de novo: a linha já foi decidida, a ação não roda outra vez.
    const again = await failure(runAction(action, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, input));
    expect(again).toMatchObject({ code: "conflict", details: { approval: "unclaimed" } });
    expect(calls).toHaveLength(1);
  });

  test("saída sem id (ou com id que não é UUID) não grava result_id", async () => {
    const { storeId, approver, tokenId } = await setup();
    for (const [name, out] of [
      ["t.appr.noid", { ok: true }],
      ["t.appr.textid", { id: "pedido-123" }],
    ] as const) {
      const { action } = refundLike(name, { out });
      const { requestId } = await seedRequest(storeId, tokenId, name, { orderId: "o1" });
      await runAction(action, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, { orderId: "o1" });
      expect(await requestRow(requestId)).toMatchObject({ status: "approved", resultId: null });
    }
  });

  test("approval de pedido já decidido, vencido, de outra loja, de outra ação, com outro hash, de token revogado ou com requestId inválido → conflict e nada muda", async () => {
    const { storeId, approver, tokenId } = await setup();
    const { action, calls } = refundLike("t.appr.conflict");
    const input = { orderId: "o1" };
    const other = await seedStore("Outra loja");
    const otherToken = await seedToken(other.storeId);
    const revokedToken = await seedToken(storeId);
    await t.ownerDb.update(mcpToken).set({ revokedAt: new Date() }).where(eq(mcpToken.id, revokedToken));

    const cases: { label: string; requestId: string }[] = [
      { label: "já aprovado", ...(await seedRequest(storeId, tokenId, action.name, input, { status: "approved", inputSealed: null })) },
      { label: "recusado", ...(await seedRequest(storeId, tokenId, action.name, input, { status: "rejected", inputSealed: null })) },
      { label: "vencido", ...(await seedRequest(storeId, tokenId, action.name, input, { expiresAt: new Date(Date.now() - 1000) })) },
      { label: "outra loja", ...(await seedRequest(other.storeId, otherToken, action.name, input)) },
      { label: "outra ação", ...(await seedRequest(storeId, tokenId, "t.appr.outra", input)) },
      // Pedido de outra entrada (o2) executado com a entrada o1: o hash calculado pelo runAction não bate.
      { label: "outro hash", ...(await seedRequest(storeId, tokenId, action.name, { orderId: "o2" })) },
      { label: "token revogado", ...(await seedRequest(storeId, revokedToken, action.name, input)) },
      { label: "pedido inexistente", requestId: randomUUID() },
      { label: "requestId que não é UUID", requestId: "nao-e-uuid" },
    ];
    for (const c of cases) {
      const known = c.label !== "pedido inexistente" && c.label !== "requestId que não é UUID";
      const before = known ? await requestRow(c.requestId) : undefined;
      const approval = { requestId: c.requestId };
      const err = await failure(runAction(action, { storeId, actor: approver, origin: "mcp", approval }, input));
      expect(err, c.label).toBeInstanceOf(ActionError);
      expect(err!.code, c.label).toBe("conflict");
      expect(err!.message, c.label).toBe("Solicitação já decidida, expirada ou cancelada");
      expect(err!.details, c.label).toEqual({ approval: "unclaimed" });
      if (before) expect(await requestRow(c.requestId), c.label).toEqual(before);
    }
    expect(calls).toEqual([]);
    // Cada tentativa fica na auditoria como falha (só a entrada validada, sem efeito).
    const audits = await auditRows(storeId, action.name);
    expect(audits).toHaveLength(cases.length);
    expect(audits.every((a) => !a.ok && a.error === "conflict: Solicitação já decidida, expirada ou cancelada")).toBe(true);
  });

  test("falha em run desfaz a reivindicação (linha volta a pending)", async () => {
    const { storeId, approver, tokenId } = await setup();
    const { action, calls } = refundLike("t.appr.fail", { fail: true });
    const input = { orderId: "o1" };
    const { requestId } = await seedRequest(storeId, tokenId, action.name, input);
    const before = await requestRow(requestId);
    const err = await failure(runAction(action, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, input));
    expect(err).toMatchObject({ code: "provider_error" });
    expect(calls).toHaveLength(1);
    expect(await requestRow(requestId)).toEqual(before);
    const [audit] = await auditRows(storeId, action.name);
    expect(audit).toMatchObject({ ok: false, origin: "mcp", error: "provider_error: provedor fora do ar" });
    expect(audit!.actor).toEqual({ ...approver, approval: { requestId, tokenId } });
  });

  test("aprovador sem a permissão da ação → forbidden (support aprovando orders.refund)", async () => {
    const { storeId, approver, tokenId } = await setup("support");
    const { action, calls } = refundLike("t.appr.support");
    const input = { orderId: "o1" };
    const { requestId } = await seedRequest(storeId, tokenId, action.name, input);
    expect(await code(runAction(action, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, input))).toBe("forbidden");
    expect(calls).toEqual([]);
    expect(await requestRow(requestId)).toMatchObject({ status: "pending", decidedBy: null });
  });
});

describe("concessão: papel do token e trava", () => {
  test("ação de TOKEN_DENIED não passa pela fila: approval → forbidden, sem efeito", async () => {
    const { storeId, approver, tokenId } = await setup();
    let calls = 0;
    const denied = defineAction(
      { name: "t.appr.denied", description: "x", input: z.object({}), permission: "team.manage", sensitive: true, run: async () => ++calls },
      def,
    );
    const { requestId } = await seedRequest(storeId, tokenId, denied.name, {});
    expect(await code(runAction(denied, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, {}))).toBe("forbidden");
    expect(calls).toBe(0);
    expect(await requestRow(requestId)).toMatchObject({ status: "pending", decidedBy: null });
  });

  test("papel do token sem a permissão da ação (leitor pedindo reembolso) → forbidden, linha segue pendente", async () => {
    const { storeId, approver } = await setup();
    const readerToken = await seedToken(storeId, "reader");
    const { action, calls } = refundLike("t.appr.readerrole");
    const input = { orderId: "o1" };
    const { requestId } = await seedRequest(storeId, readerToken, action.name, input);
    const err = await failure(runAction(action, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, input));
    expect(err).toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: "pending", decidedBy: null });
    expect(row.inputSealed).not.toBeNull();
  });

  test("a reivindicação trava a linha do token: revogar no meio da execução aprovada espera o commit", async () => {
    const { storeId, approver, tokenId } = await setup();
    let lockError: unknown = null;
    const action = defineAction(
      {
        name: "t.appr.lock",
        description: "x",
        input: z.object({ orderId: z.string() }),
        permission: "orders.refund",
        sensitive: true,
        run: async () => {
          // Outra conexão tenta revogar o token enquanto a transação aprovada está aberta: com a trava, não consegue.
          lockError = await t.ownerDb
            .transaction(async (tx) => {
              await tx.execute(sql`set local lock_timeout = '200ms'`);
              await tx.update(mcpToken).set({ revokedAt: new Date() }).where(eq(mcpToken.id, tokenId));
            })
            .then(
              () => null,
              (e: unknown) => e,
            );
          return { ok: true };
        },
      },
      def,
    );
    const input = { orderId: "o1" };
    const { requestId } = await seedRequest(storeId, tokenId, action.name, input);
    await runAction(action, { storeId, actor: approver, origin: "mcp", approval: { requestId } }, input);
    const cause = (lockError as { cause?: { code?: string } } | null)?.cause ?? lockError;
    expect((cause as { code?: string } | null)?.code).toBe("55P03");
    const [tok] = await t.ownerDb.select().from(mcpToken).where(eq(mcpToken.id, tokenId));
    expect(tok!.revokedAt).toBeNull();
    expect(await requestRow(requestId)).toMatchObject({ status: "approved" });
  });
});

describe("auditResult", () => {
  test("auditResult grava result junto da entrada (e junto de auditInput, quando existe)", async () => {
    const { storeId } = await seedStore("Auditoria do resultado");
    const owner: Actor = { kind: "user", userId: randomUUID(), role: "owner" };
    const plain = defineAction(
      {
        name: "t.appr.result",
        description: "x",
        input: z.object({ fromEmail: z.string() }),
        permission: "connections.write",
        run: async () => ({ id: randomUUID(), activated: true }),
        auditResult: (out) => ({ activated: out.activated }),
      },
      def,
    );
    await runAction(plain, { storeId, actor: owner, origin: "panel" }, { fromEmail: "vendas@loja.com" });
    const [a] = await auditRows(storeId, plain.name);
    expect(a).toMatchObject({ ok: true, input: { fromEmail: "vendas@loja.com", result: { activated: true } } });

    const projected = defineAction(
      {
        name: "t.appr.result2",
        description: "x",
        input: z.object({ fromEmail: z.string(), apiKey: z.string() }),
        permission: "connections.write",
        auditInput: (i) => ({ fromEmail: i.fromEmail }),
        run: async () => ({ activated: false }),
        auditResult: (out) => ({ activated: out.activated }),
      },
      def,
    );
    const apiKey = randomBytes(12).toString("hex");
    await runAction(projected, { storeId, actor: owner, origin: "panel" }, { fromEmail: "vendas@loja.com", apiKey });
    const [b] = await auditRows(storeId, projected.name);
    expect(b!.input).toEqual({ fromEmail: "vendas@loja.com", result: { activated: false } });
    expect(JSON.stringify(b)).not.toContain(apiKey);
  });
  test("auditResult que lança vira o marcador de erro de auditoria e a ação segue", async () => {
    const { storeId } = await seedStore("Auditoria do resultado que lança");
    const owner: Actor = { kind: "user", userId: randomUUID(), role: "owner" };
    const action = defineAction(
      {
        name: "t.appr.resultthrows",
        description: "x",
        input: z.object({ fromEmail: z.string() }),
        permission: "connections.write",
        run: async () => ({ activated: true }),
        auditResult: () => {
          throw new Error("quebrou");
        },
      },
      def,
    );
    expect(await runAction(action, { storeId, actor: owner, origin: "panel" }, { fromEmail: "vendas@loja.com" })).toEqual({ activated: true });
    const [a] = await auditRows(storeId, action.name);
    expect(a).toMatchObject({ ok: true, input: { fromEmail: "vendas@loja.com", result: { omitted: "audit_result_error" } } });
  });

  test("auditResult acima de 8 KB: a auditoria guarda só os nomes das chaves (entrada e result)", async () => {
    const { storeId } = await seedStore("Auditoria do resultado grande");
    const owner: Actor = { kind: "user", userId: randomUUID(), role: "owner" };
    const big = "x".repeat(9 * 1024);
    const action = defineAction(
      {
        name: "t.appr.resultbig",
        description: "x",
        input: z.object({ fromEmail: z.string() }),
        permission: "connections.write",
        run: async () => ({ big }),
        auditResult: (out) => ({ big: out.big }),
      },
      def,
    );
    await runAction(action, { storeId, actor: owner, origin: "panel" }, { fromEmail: "vendas@loja.com" });
    const [a] = await auditRows(storeId, action.name);
    expect(a!.input).toEqual({ truncated: true, keys: ["fromEmail", "result"] });
    expect(JSON.stringify(a)).not.toContain(big);
  });
});
