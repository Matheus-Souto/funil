import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface Handle {
  db: Db;
  close(): Promise<void>;
}

/** Abre um cliente Drizzle com pool pequeno. */
export function createDb(url: string, max = 5): Handle {
  const pg = postgres(url, { max, onnotice: () => {} });
  return { db: drizzle(pg, { schema }), close: () => pg.end({ timeout: 5 }) };
}

let appHandle: Handle | undefined;
let ownerHandle: Handle | undefined;

function lazy(get: () => Db): Db {
  return new Proxy({} as Db, {
    get(_t, prop) {
      const target = get();
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Conexão do papel `app` (sujeita a RLS). Abre sob demanda. */
export const db: Db = lazy(() => (appHandle ??= createDb(env.DATABASE_URL)).db);
/**
 * URL do papel dono. Só CLIs (migrate, store-create) e testes a usam: o servidor em produção roda SEM ela (o
 * entrypoint da imagem a remove do ambiente antes de iniciar o app).
 */
export function requireOwnerUrl(e: { OWNER_DATABASE_URL?: string } = env): string {
  if (!e.OWNER_DATABASE_URL) {
    throw new Error("OWNER_DATABASE_URL não definida: o papel dono só é usado por migrações e pela CLI store-create");
  }
  return e.OWNER_DATABASE_URL;
}

/** Conexão do papel dono (migrations, criação de loja). Nunca usar em ações de loja. */
export const ownerDb: Db = lazy(() => (ownerHandle ??= createDb(requireOwnerUrl())).db);

/** Só para testes: aponta `db`/`ownerDb` para outro banco. Sem argumentos, volta ao padrão. */
export async function setDbForTests(urls?: { appUrl: string; ownerUrl: string }): Promise<void> {
  const old = [appHandle, ownerHandle];
  appHandle = urls ? createDb(urls.appUrl) : undefined;
  ownerHandle = urls ? createDb(urls.ownerUrl) : undefined;
  await Promise.all(old.map((h) => h?.close()));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa `fn` numa transação com `app.store_id` fixado (local à transação).
 * O RLS só deixa passar linhas dessa loja.
 */
export async function withStore<T>(storeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(storeId)) throw new Error("storeId inválido: esperado UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.store_id', ${storeId}, true)`);
    return fn(tx);
  });
}
