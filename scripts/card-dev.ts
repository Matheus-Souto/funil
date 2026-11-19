// `bun run card:dev`: sobe o serviço de cartão empacotado (dist/card/server.js) em Node, na porta 3100 (CARD_PORT),
// com o .env de desenvolvimento (o Bun o carrega). Lista de permissão: o filho recebe só as variáveis que o serviço
// lê com SERVICE=card (mais PATH); SECRET, OWNER_DATABASE_URL, APP_DB_PASSWORD, SMTP, Meta etc. nunca passam.
// O banco é o do app, com o papel `card` (CARD_DB_PASSWORD; a migração só dá login ao papel com ela definida).
import { spawn } from "node:child_process";
import { join } from "node:path";

export const CARD_DEV_PASS = [
  "PATH",
  "NODE_ENV",
  "BASE_URL",
  "MODE",
  "PLATFORM_DOMAIN",
  "CARD_ORIGIN",
  "CARD_TICKET_KEY",
  "ASAAS_SEAL_KEY",
  "CARD_PORT",
  "TRUST_PROXY",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET",
  "ASAAS_BASE_URL",
] as const;

/** Ambiente do processo do serviço a partir do .env do app. Lança com a orientação quando falta algo. */
export function cardDevEnv(source: Record<string, string | undefined>): Record<string, string> {
  const password = source.CARD_DB_PASSWORD;
  if (!password) throw new Error("defina CARD_DB_PASSWORD no .env e rode `bun run migrate` (dá login ao papel `card`)");
  if (!source.DATABASE_URL) throw new Error("DATABASE_URL faltando no .env");
  const db = new URL(source.DATABASE_URL);
  db.username = "card";
  db.password = password;
  const out: Record<string, string> = { SERVICE: "card", DATABASE_URL: db.toString() };
  for (const k of CARD_DEV_PASS) {
    const v = source[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

if (import.meta.main) {
  let childEnv: Record<string, string>;
  try {
    childEnv = cardDevEnv(process.env);
  } catch (e) {
    console.error(`card:dev: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const child = spawn("node", [join(import.meta.dir, "..", "dist", "card", "server.js")], { env: childEnv as NodeJS.ProcessEnv, stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 1));
}
