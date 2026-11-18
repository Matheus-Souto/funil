// Migração (rodar com Bun): papel `app`, rls.sql e migrations do drizzle, com o papel dono.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

/** Cria/atualiza o papel `app` (login, sem BYPASSRLS, não dono), aplica rls.sql e as migrations. */
export async function migrate(ownerUrl: string, appPassword: string): Promise<void> {
  const pg = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
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

if (import.meta.main) {
  const url = process.env.OWNER_DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!url || !password) {
    console.error("migrate: defina OWNER_DATABASE_URL e APP_DB_PASSWORD");
    process.exit(1);
  }
  await migrate(url, password);
  console.log("migrate: ok");
}
