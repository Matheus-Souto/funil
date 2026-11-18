// Migração: cria o papel `app` (idempotente) com a senha de APP_DB_PASSWORD.
// As tabelas e as migrações do drizzle entram na Task 3.
import postgres from "postgres";

const url = process.env.OWNER_DATABASE_URL;
const password = process.env.APP_DB_PASSWORD;
if (!url || !password) {
  console.error("migrate: defina OWNER_DATABASE_URL e APP_DB_PASSWORD");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [row] = await sql`select 1 as ok from pg_roles where rolname = 'app'`;
  const lit = sql.unsafe(`'${password.replaceAll("'", "''")}'`);
  if (row) await sql`alter role app with login password ${lit}`;
  else await sql`create role app with login password ${lit}`;
  console.log("migrate: ok");
} finally {
  await sql.end();
}
