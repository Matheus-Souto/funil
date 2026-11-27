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

test("registros de cobrança de app só aparecem para a loja que os criou", async () => {
  const a = await seedStore("A");
  const b = await seedStore("B");
  await withStore(b.storeId, async (tx) => {
    const [offer] = await tx.execute<{ id: string }>(sql`
      insert into offer (store_id, slug, name, price_cents, methods, pix_mode, delivery, app_code)
      values (${b.storeId}, 'plano', 'Plano', 990, array['pix'], 'asaas', 'app', 'plano')
      returning id
    `);
    await tx.execute(sql`
      insert into app_trial (store_id, account, email_hash, mailbox_hash, event_id, started_at)
      values (${b.storeId}, 'conta-teste', repeat('a', 64), repeat('b', 64), 'trial-rls', now())
    `);
    await tx.execute(sql`
      insert into app_checkout_session
        (store_id, offer_id, account, buyer_name, buyer_email, return_url, expires_at)
      values
        (${b.storeId}, ${offer!.id}, 'conta-teste', 'Pessoa Teste', 'teste@example.com', 'https://example.com', now() + interval '1 hour')
    `);
    await tx.execute(sql`
      insert into app_webhook_delivery (store_id, event_id, event_type, status)
      values (${b.storeId}, 'ping-rls', 'ping', 'pending')
    `);
  });

  for (const table of ["app_trial", "app_checkout_session", "app_webhook_delivery"]) {
    const query = sql`select store_id from ${sql.identifier(table)}`;
    const own = await withStore(b.storeId, (tx) => tx.execute(query));
    expect([...own]).toEqual([{ store_id: b.storeId }]);
    expect(await withStore(a.storeId, (tx) => tx.execute(query))).toHaveLength(0);
  }
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

// Exceções justificadas: tabelas com coluna store_id que NÃO têm RLS por store_isolation.
const RLS_EXCEPTIONS: Record<string, string> = {
  membership: "consultada ANTES de haver loja no contexto (login: usuário+loja; sessão: join com session); sem segredos, só papel",
  session: "resolvida pelo hash do token ANTES de haver loja no contexto: é ela que diz qual é a loja; id_hash é segredo de 256 bits",
  job: "store_id anulável: jobs de sistema sem loja; a fila é lida pelo worker (papel app) sem app.store_id e re-escopa com withStore(job.storeId)",
};

async function storeTables() {
  const tables = await t.ownerDb.execute<{ table_name: string; rls: boolean; forced: boolean; policy: string | null }>(sql`
    select c.relname as table_name,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as forced,
           (select p.polname from pg_policy p where p.polrelid = c.oid and p.polname = 'store_isolation') as policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'store_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname`);
  return [...tables].map((r) => ({ name: r.table_name, complete: r.rls && r.forced && r.policy === "store_isolation" }));
}

test("toda tabela pública com store_id tem RLS habilitado + FORCE + política store_isolation (ou exceção justificada)", async () => {
  const rows = await storeTables();
  expect(rows.length).toBeGreaterThan(5);
  const broken = rows
    .filter((r) => !r.complete && !(r.name in RLS_EXCEPTIONS))
    .map((r) => r.name)
    .sort();
  expect(broken).toEqual([]);
  // A lista de exceções não pode ficar velha: cada exceção precisa existir e realmente não ter RLS completo.
  for (const name of Object.keys(RLS_EXCEPTIONS)) {
    const r = rows.find((x) => x.name === name);
    expect(r, `exceção ${name} não existe mais`).toBeDefined();
    expect(r!.complete, `exceção ${name} já tem RLS; remova da lista`).toBe(false);
  }
});

test("a verificação de RLS pega uma tabela com store_id sem enable_store_rls (e aceita a que chamou)", async () => {
  await t.ownerDb.execute(sql`create table rls_probe_missing (id int, store_id uuid not null)`);
  await t.ownerDb.execute(sql`create table rls_probe_ok (id int, store_id uuid not null)`);
  await t.ownerDb.execute(sql`select enable_store_rls('rls_probe_ok')`);
  try {
    const rows = await storeTables();
    expect(rows.find((r) => r.name === "rls_probe_missing")?.complete).toBe(false);
    expect(rows.find((r) => r.name === "rls_probe_ok")?.complete).toBe(true);
  } finally {
    await t.ownerDb.execute(sql`drop table rls_probe_missing`);
    await t.ownerDb.execute(sql`drop table rls_probe_ok`);
  }
});
