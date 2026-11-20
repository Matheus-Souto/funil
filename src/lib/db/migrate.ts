// Migração (rodar com Bun): papéis `app` e `card`, rls.sql, migrations do drizzle e permissões do `card`, com o papel dono.
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
 * Cria/atualiza o papel `app` (login, sem BYPASSRLS, não dono), aplica rls.sql e as migrations e, por último, as
 * permissões do papel `card` (`select card_role_grants()`, definida no rls.sql: precisa das tabelas já criadas).
 * Segura `MIGRATE_LOCK` na conexão única durante tudo: uma segunda execução espera a primeira e encontra tudo aplicado.
 *
 * Papel `card` (serviço de cartão isolado): sempre existe, para as permissões e políticas `to card` serem um caminho só.
 * Com `cardPassword`, entra (login) com essa senha; sem ela, é criado SEM login (instalação que ainda não usa o
 * isolamento) e, se já existir, o login e a senha ficam como estão (rodar a migração sem a variável não derruba o
 * serviço de cartão). Nos dois casos: sem superusuário, sem BYPASSRLS, sem criar papel nem banco, no máximo
 * `CARD_CONNECTION_LIMIT` conexões e consultas de até `CARD_STATEMENT_TIMEOUT` (um `card` comprometido não esgota o
 * Postgres do app).
 *
 * O rls.sql e as permissões do `card` recriam políticas a cada subida (`drop policy`/`create policy`: trava exclusiva
 * na tabela). Com o app atendendo, uma consulta longa seguraria a migração e, atrás dela na fila de travas, todas as
 * outras consultas da tabela: com `lockTimeoutMs` (padrão 5 s) a migração desiste rápido (o container reinicia e tenta
 * de novo). As migrations do drizzle seguem sem esse teto.
 */
export async function migrate(ownerUrl: string, appPassword: string, cardPassword?: string, opts: { lockTimeoutMs?: number } = {}): Promise<void> {
  const pg = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const lockTimeout = `${Math.max(1, Math.trunc(opts.lockTimeoutMs ?? 5_000))}ms`;
  try {
    await pg`select pg_advisory_lock(${MIGRATE_LOCK})`;
    await upsertRole(pg, "app", appPassword);
    await upsertRole(pg, "card", cardPassword);
    await pg`select set_config('lock_timeout', ${lockTimeout}, false)`;
    await pg.unsafe(readFileSync(join(here, "rls.sql"), "utf8"));
    await pg`reset lock_timeout`;
    await drizzleMigrate(drizzle(pg), { migrationsFolder: join(here, "../../../drizzle") });
    await pg`select set_config('lock_timeout', ${lockTimeout}, false)`;
    await pg`select card_role_grants()`;
    await pg`reset lock_timeout`;
  } finally {
    await pg.end({ timeout: 5 });
  }
}

const LIMITS = "nosuperuser nocreatedb nocreaterole nobypassrls";
/** Teto de conexões do papel `card` (o serviço usa um pool de 5) e duração máxima de cada consulta dele. */
export const CARD_CONNECTION_LIMIT = 10;
export const CARD_STATEMENT_TIMEOUT = "10s";

/** Cria ou altera o papel. Com senha: login com ela. Sem senha: novo papel sem login; o existente mantém login/senha. */
async function upsertRole(pg: postgres.Sql, role: "app" | "card", password: string | undefined): Promise<void> {
  const exists = (await pg`select 1 from pg_roles where rolname = ${role}`).length > 0;
  const limits = role === "card" ? `${LIMITS} connection limit ${CARD_CONNECTION_LIMIT}` : LIMITS;
  if (password === undefined) {
    await pg.unsafe(`${exists ? "alter" : "create"} role ${role} with ${exists ? "" : "nologin "}${limits}`);
  } else {
    const [{ stmt }] = await pg<{ stmt: string }[]>`
      select format(${`${exists ? "alter" : "create"} role ${role} with login ${limits} password %L`}, ${password}::text) as stmt`;
    await pg.unsafe(stmt);
  }
  if (role === "card") await pg.unsafe(`alter role card set statement_timeout = '${CARD_STATEMENT_TIMEOUT}'`);
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
  // CARD_DB_PASSWORD (opcional): o papel `card` passa a entrar com ela. Vazia conta como ausente.
  await migrate(url, password, process.env.CARD_DB_PASSWORD || undefined);
  console.log("migrate: ok");
}
