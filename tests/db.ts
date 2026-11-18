import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { db, ownerDb, setDbForTests, type Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { store } from "@/lib/db/schema";
import { env } from "@/lib/env";

const LOCK_KEY = 7_303_001;

function withDatabase(url: string, user: string | undefined, password: string | undefined, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

export interface TestDb {
  db: Db;
  ownerDb: Db;
  url: string;
  drop(): Promise<void>;
}

/**
 * Cria `test_<random>` no Postgres do compose, migra e aponta `db`/`ownerDb` para ele.
 * Cada arquivo de teste chama no beforeAll e `drop()` no afterAll.
 */
export async function createTestDb(): Promise<TestDb> {
  const name = `test_${randomBytes(6).toString("hex")}`;
  const appPassword = env.APP_DB_PASSWORD ?? "app";
  const adminUrl = withDatabase(env.OWNER_DATABASE_URL, undefined, undefined, "postgres");
  const ownerUrl = withDatabase(env.OWNER_DATABASE_URL, undefined, undefined, name);
  const appUrl = withDatabase(env.OWNER_DATABASE_URL, "app", appPassword, name);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
    // O papel `app` é global ao servidor: serializa a migração entre arquivos/processos.
    await admin`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      await migrate(ownerUrl, appPassword);
    } finally {
      await admin`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  } catch (e) {
    await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => undefined);
    await admin.end();
    throw e;
  }
  await setDbForTests({ appUrl, ownerUrl });
  let dropped = false;
  return {
    db,
    ownerDb,
    url: ownerUrl,
    async drop() {
      if (dropped) return;
      dropped = true;
      await setDbForTests();
      try {
        await admin.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.end();
      }
    },
  };
}

/** Cria uma loja (papel dono, a tabela store não tem RLS). */
export async function seedStore(name = "Loja"): Promise<{ storeId: string }> {
  const [row] = await ownerDb
    .insert(store)
    .values({ name, slug: `loja-${randomUUID()}` })
    .returning({ id: store.id });
  return { storeId: row!.id };
}
