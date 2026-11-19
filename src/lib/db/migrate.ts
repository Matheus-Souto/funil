// Migração (rodar com Bun): papel `app`, rls.sql e migrations do drizzle, com o papel dono.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

/** Trava (advisory, por banco) que serializa migrações simultâneas: dois containers subindo juntos. */
export const MIGRATE_LOCK = 7_303_010;

/**
 * Cria/atualiza o papel `app` (login, sem BYPASSRLS, não dono), aplica rls.sql e as migrations. Segura
 * `MIGRATE_LOCK` na conexão única durante tudo: uma segunda execução espera a primeira e encontra tudo aplicado.
 */
export async function migrate(ownerUrl: string, appPassword: string): Promise<void> {
  const pg = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await pg`select pg_advisory_lock(${MIGRATE_LOCK})`;
    const verb = (await pg`select 1 from pg_roles where rolname = 'app'`).length > 0 ? "alter" : "create";
    const [{ stmt }] = await pg<{ stmt: string }[]>`
      select format(${`${verb} role app with login nosuperuser nocreatedb nocreaterole nobypassrls password %L`}, ${appPassword}::text) as stmt`;
    await pg.unsafe(stmt);
    await pg.unsafe(readFileSync(join(here, "rls.sql"), "utf8"));
    await drizzleMigrate(drizzle(pg), { migrationsFolder: join(here, "../../../drizzle") });
  } finally {
    await pg.end({ timeout: 5 });
  }
}

// Executado direto (`bun src/lib/db/migrate.ts` ou `node cli/src/lib/db/migrate.mjs` na imagem Docker), nunca ao ser
// importado. Não usa `import.meta.main`: no pacote para Node ele vira uma checagem que é sempre verdadeira.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.OWNER_DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!url || !password) {
    console.error("migrate: defina OWNER_DATABASE_URL e APP_DB_PASSWORD");
    process.exit(1);
  }
  await migrate(url, password);
  console.log("migrate: ok");
}
