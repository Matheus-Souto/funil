import fc from "fast-check";
import { sql } from "drizzle-orm";
import { createDb, db, withStore } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const row = (storeId: string, action = "x") => ({
  storeId,
  actor: { kind: "system" },
  origin: "system",
  action,
  input: {},
  ok: true,
});

test("loja A não lê auditoria da loja B", async () => {
  const a = await seedStore("A");
  const b = await seedStore("B");
  await withStore(b.storeId, (tx) => tx.insert(auditLog).values(row(b.storeId)));
  const rows = await withStore(a.storeId, (tx) => tx.select().from(auditLog));
  expect(rows).toHaveLength(0);
});

test("insert com store_id de outra loja é recusado", async () => {
  const a = await seedStore("A");
  const b = await seedStore("B");
  await expect(withStore(a.storeId, (tx) => tx.insert(auditLog).values(row(b.storeId)))).rejects.toThrow();
});

test("sem app.store_id nada é visível", async () => {
  const a = await seedStore("A");
  await withStore(a.storeId, (tx) => tx.insert(auditLog).values(row(a.storeId)));
  expect(await db.select().from(auditLog)).toHaveLength(0);
});

test("o GUC não vaza entre transações na mesma conexão (volta a vazio, não quebra)", async () => {
  const a = await seedStore("A");
  await withStore(a.storeId, (tx) => tx.insert(auditLog).values(row(a.storeId)));
  const single = createDb(`postgres://app:${env.APP_DB_PASSWORD ?? "app"}@${new URL(t.url).host}${new URL(t.url).pathname}`, 1);
  try {
    await single.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.store_id', ${a.storeId}, true)`);
    });
    expect(await single.db.select().from(auditLog)).toHaveLength(0);
  } finally {
    await single.close();
  }
});

test("withStore recusa storeId que não é UUID", async () => {
  await expect(withStore("x'; drop table audit_log; --", async () => 1)).rejects.toThrow("storeId inválido");
});

test("papel app não é dono, não ignora RLS e a tabela tem FORCE", async () => {
  const [role] = await t.ownerDb.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
    sql`select rolbypassrls, rolsuper from pg_roles where rolname = 'app'`,
  );
  expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
  const [tbl] = await t.ownerDb.execute<{ owner: string; force: boolean; rls: boolean }>(
    sql`select pg_get_userbyid(relowner) as owner, relforcerowsecurity as force, relrowsecurity as rls from pg_class where relname = 'audit_log'`,
  );
  expect(tbl!.owner).not.toBe("app");
  expect(tbl!.force).toBe(true);
  expect(tbl!.rls).toBe(true);
});

test("propriedade: o que se lê em withStore(s) é exatamente o que foi inserido para s", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }), { minLength: 1, maxLength: 4 }),
      async (actionsPerStore) => {
        const stores = await Promise.all(actionsPerStore.map(() => seedStore()));
        const inserted = new Map<string, string[]>();
        for (const [i, s] of stores.entries()) {
          const ids = await withStore(s.storeId, async (tx) => {
            const out = [];
            for (const action of actionsPerStore[i]!) {
              const [r] = await tx.insert(auditLog).values(row(s.storeId, action)).returning({ id: auditLog.id });
              out.push(r!.id);
            }
            return out;
          });
          inserted.set(s.storeId, ids);
        }
        for (const s of stores) {
          const read = await withStore(s.storeId, (tx) => tx.select({ id: auditLog.id }).from(auditLog));
          expect(read.map((r) => r.id).sort()).toEqual([...inserted.get(s.storeId)!].sort());
        }
      },
    ),
    { numRuns: 20 },
  );
});
