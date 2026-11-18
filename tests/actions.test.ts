import { z } from "zod";
import { auditLog } from "@/lib/db/schema";
import { withStore } from "@/lib/db/client";
import { ActionError, defineAction, runAction, type Actor } from "@/lib/actions/core";
import { hasPermission } from "@/lib/actions/permissions";
import { listActions } from "@/lib/actions/registry";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const support: Actor = { kind: "user", userId: "u2", role: "support" };
const def = { register: false } as const;

const echo = defineAction(
  {
    name: "test.echo",
    description: "eco",
    input: z.object({ n: z.number(), creditCard: z.object({ number: z.string() }).optional() }),
    permission: "products.read",
    run: async (_ctx, i) => i.n,
  },
  def,
);

const auditRows = (storeId: string) => withStore(storeId, (tx) => tx.select().from(auditLog));

test("entrada inválida vira invalid_input sem valores crus nos detalhes", async () => {
  const { storeId } = await seedStore();
  const err = await runAction(echo, { storeId, actor: owner, origin: "panel" }, { n: "segredo-4111" }).catch((e) => e);
  expect(err).toBeInstanceOf(ActionError);
  expect(err.code).toBe("invalid_input");
  expect(JSON.stringify(err.details)).not.toContain("segredo");
  expect(err.details[0]).toHaveProperty("path");
  expect(err.details[0]).toHaveProperty("message");
});

test("support chamando orders.refund é forbidden e run não roda", async () => {
  const { storeId } = await seedStore();
  let called = false;
  const refund = defineAction(
    { name: "test.refund", description: "x", input: z.object({}), permission: "orders.refund", run: async () => void (called = true) },
    def,
  );
  const err = await runAction(refund, { storeId, actor: support, origin: "panel" }, {}).catch((e) => e);
  expect(err.code).toBe("forbidden");
  expect(called).toBe(false);
  expect(await runAction(refund, { storeId, actor: owner, origin: "panel" }, {})).toBeUndefined();
});

test("public aceita qualquer ator; system só system", async () => {
  const { storeId } = await seedStore();
  const pub = defineAction({ name: "t.pub", description: "x", input: z.object({}), permission: "public", run: async () => 1 }, def);
  const sys = defineAction({ name: "t.sys", description: "x", input: z.object({}), permission: "system", run: async () => 2 }, def);
  expect(await runAction(pub, { storeId, actor: { kind: "public" }, origin: "public" }, {})).toBe(1);
  expect((await runAction(sys, { storeId, actor: owner, origin: "panel" }, {}).catch((e) => e)).code).toBe("forbidden");
  expect((await runAction(sys, { storeId, actor: { kind: "public" }, origin: "public" }, {}).catch((e) => e)).code).toBe("forbidden");
  expect(await runAction(sys, { storeId, actor: { kind: "system" }, origin: "system" }, {})).toBe(2);
});

test("ação sensitive: mcp/ai exigem aprovação; panel com owner executa", async () => {
  const { storeId } = await seedStore();
  let calls = 0;
  const sens = defineAction(
    { name: "t.sens", description: "x", input: z.object({}), permission: "orders.refund", sensitive: true, run: async () => ++calls },
    def,
  );
  for (const origin of ["mcp", "ai"] as const) {
    const err = await runAction(sens, { storeId, actor: owner, origin }, {}).catch((e) => e);
    expect(err.code).toBe("approval_required");
  }
  expect(calls).toBe(0);
  expect(await runAction(sens, { storeId, actor: owner, origin: "panel" }, {})).toBe(1);
});

test("sucesso grava 1 linha de auditoria ok=true com cartão redigido", async () => {
  const { storeId } = await seedStore();
  await runAction(echo, { storeId, actor: owner, origin: "panel" }, { n: 1, creditCard: { number: "4111111111111111" } });
  const rows = await auditRows(storeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.ok).toBe(true);
  expect(rows[0]!.action).toBe("test.echo");
  expect(JSON.stringify(rows[0]!.input)).not.toContain("4111");
  expect((rows[0]!.input as { creditCard: unknown }).creditCard).toBe("[redacted]");
});

test("falha grava ok=false e desfaz as escritas da ação", async () => {
  const { storeId } = await seedStore();
  const boom = defineAction(
    {
      name: "t.boom",
      description: "x",
      input: z.object({}),
      permission: "products.read",
      run: async (ctx) => {
        await ctx.tx.insert(auditLog).values({ storeId: ctx.storeId, actor: {}, origin: "x", action: "efeito", input: {}, ok: true });
        throw new ActionError("conflict", "já existe");
      },
    },
    def,
  );
  const err = await runAction(boom, { storeId, actor: owner, origin: "panel" }, {}).catch((e) => e);
  expect(err.code).toBe("conflict");
  const rows = await auditRows(storeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.ok).toBe(false);
  expect(rows[0]!.action).toBe("t.boom");
  expect(rows[0]!.error).toContain("conflict");
});

test("erro desconhecido é relançado e auditado", async () => {
  const { storeId } = await seedStore();
  const bad = defineAction(
    { name: "t.bad", description: "x", input: z.object({}), permission: "products.read", run: async () => { throw new TypeError("kaboom"); } },
    def,
  );
  const err = await runAction(bad, { storeId, actor: owner, origin: "panel" }, {}).catch((e) => e);
  expect(err).toBeInstanceOf(TypeError);
  expect((await auditRows(storeId))[0]!.ok).toBe(false);
});

test("audit:false não grava", async () => {
  const { storeId } = await seedStore();
  const quiet = defineAction({ name: "t.quiet", description: "x", input: z.object({}), permission: "public", audit: false, run: async () => 1 }, def);
  await runAction(quiet, { storeId, actor: { kind: "public" }, origin: "public" }, {});
  expect(await auditRows(storeId)).toHaveLength(0);
});

test("ctx.tx só enxerga a loja do call.storeId", async () => {
  const a = await seedStore("A");
  const b = await seedStore("B");
  await withStore(b.storeId, (tx) => tx.insert(auditLog).values({ storeId: b.storeId, actor: {}, origin: "x", action: "da-b", input: {}, ok: true }));
  const seen = defineAction(
    { name: "t.seen", description: "x", input: z.object({}), permission: "products.read", run: async (ctx) => (await ctx.tx.select().from(auditLog)).map((r) => r.action) },
    def,
  );
  expect(await runAction(seen, { storeId: a.storeId, actor: owner, origin: "panel" }, {})).toEqual([]);
  expect(await runAction(seen, { storeId: b.storeId, actor: owner, origin: "panel" }, {})).toEqual(["da-b"]);
});

test("registro rejeita nome duplicado; register:false não vaza", () => {
  const mk = () =>
    defineAction({ name: "reg.dup", description: "d", input: z.object({ a: z.string() }), permission: "offers.read", run: async () => 1 });
  mk();
  expect(mk).toThrow(/reg\.dup/);
  expect(listActions().filter((a) => a.name === "test.echo")).toHaveLength(0);
  const item = listActions().find((a) => a.name === "reg.dup")!;
  expect(item).toMatchObject({ permission: "offers.read", sensitive: false });
  expect(item.inputSchema).toHaveProperty("properties.a");
});

test("matriz de papéis", () => {
  expect(hasPermission("owner", "team.manage")).toBe(true);
  expect(hasPermission("admin", "team.manage")).toBe(false);
  expect(hasPermission("admin", "connections.write")).toBe(false);
  expect(hasPermission("admin", "orders.refund")).toBe(true);
  expect(hasPermission("support", "orders.resend")).toBe(true);
  expect(hasPermission("support", "orders.refund")).toBe(false);
  expect(hasPermission("traffic", "metrics.read")).toBe(true);
  expect(hasPermission("traffic", "orders.read")).toBe(false);
});

test("rejeição pré-run de ator público audita só as chaves, nunca valores", async () => {
  const { storeId } = await seedStore();
  const gated = defineAction({ name: "t.gated", description: "x", input: z.object({}), permission: "orders.refund", run: async () => 1 }, def);
  const body = { cpf: "123.456.789-00", blob: "x".repeat(50_000), ["k".repeat(100)]: 1 };
  const err = await runAction(gated, { storeId, actor: { kind: "public" }, origin: "public" }, body).catch((e) => e);
  expect(err.code).toBe("forbidden");
  const [row] = await auditRows(storeId);
  expect(row!.ok).toBe(false);
  expect(row!.error).toContain("forbidden");
  const input = row!.input as { omitted: string; keys: string[] };
  expect(input.omitted).toBe("forbidden");
  expect(input.keys).toEqual(["cpf", "blob", "k".repeat(64)]);
  expect(JSON.stringify(row!.input)).not.toContain("123.456");
});

test("corpo vazio ou não-objeto ainda grava linha ok=false", async () => {
  const { storeId } = await seedStore();
  for (const raw of [undefined, null, "texto", [1, 2]]) {
    const err = await runAction(echo, { storeId, actor: owner, origin: "panel" }, raw).catch((e) => e);
    expect(err.code).toBe("invalid_input");
  }
  const rows = await auditRows(storeId);
  expect(rows).toHaveLength(4);
  for (const r of rows) {
    expect(r.ok).toBe(false);
    expect(r.input).toEqual({ omitted: "invalid_input", keys: [] });
  }
});

test("approval_required audita só chaves", async () => {
  const { storeId } = await seedStore();
  const sens = defineAction({ name: "t.sens2", description: "x", input: z.object({ a: z.string() }), permission: "orders.refund", sensitive: true, run: async () => 1 }, def);
  await runAction(sens, { storeId, actor: owner, origin: "ai" }, { a: "segredo" }).catch(() => undefined);
  const [row] = await auditRows(storeId);
  expect(row!.input).toEqual({ omitted: "approval_required", keys: ["a"] });
});

test("entrada válida acima de 8 KB é gravada truncada", async () => {
  const { storeId } = await seedStore();
  const big = defineAction({ name: "t.big", description: "x", input: z.object({ blob: z.string() }), permission: "products.read", run: async () => 1 }, def);
  await runAction(big, { storeId, actor: owner, origin: "panel" }, { blob: "x".repeat(20_000) });
  const [row] = await auditRows(storeId);
  expect(row!.ok).toBe(true);
  expect(row!.input).toEqual({ truncated: true, keys: ["blob"] });
});

test("auditInput substitui a entrada na auditoria (sucesso e falha) e ainda passa por redact", async () => {
  const { storeId } = await seedStore();
  const withView = (fail: boolean) =>
    defineAction(
      {
        name: `t.auditInput.${fail}`,
        description: "x",
        input: z.object({ big: z.string(), label: z.string() }),
        permission: "products.read",
        auditInput: (i) => ({ label: i.label, size: i.big.length, card: "4111111111111111" }),
        run: async () => {
          if (fail) throw new ActionError("conflict", "falhou");
          return 1;
        },
      },
      def,
    );
  const input = { big: "SEGREDO-GRANDE", label: "ok" };
  await runAction(withView(false), { storeId, actor: owner, origin: "panel" }, input);
  await runAction(withView(true), { storeId, actor: owner, origin: "panel" }, input).catch(() => undefined);
  const rows = (await auditRows(storeId)).filter((r) => r.action.startsWith("t.auditInput"));
  expect(rows.length).toBe(2);
  for (const r of rows) {
    expect(JSON.stringify(r.input)).not.toContain("SEGREDO");
    expect(r.input).toEqual({ label: "ok", size: 14, card: expect.not.stringContaining("4111") });
  }
});

test("compensate roda só se a transação falha depois de run ter sucesso", async () => {
  const { storeId } = await seedStore();
  const calls: unknown[] = [];
  const make = (name: string) =>
    defineAction(
      { name, description: "x", input: z.object({}), permission: "products.read", run: async () => "saida", compensate: async (_c, _i, out) => void calls.push(out) },
      def,
    );
  const broken: Actor = { kind: "user", userId: "a\u0000b", role: "owner" };
  await runAction(make("t.comp.a"), { storeId, actor: broken, origin: "panel" }, {}).catch(() => undefined);
  expect(calls).toEqual(["saida"]);
  await runAction(make("t.comp.b"), { storeId, actor: owner, origin: "panel" }, {});
  expect(calls).toEqual(["saida"]);
});
