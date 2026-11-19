// `bun run card:dev`: sobe o serviço de cartão empacotado (dist/card/server.js) em Node, na porta 3100 (CARD_PORT),
// com o .env de desenvolvimento (o Bun o carrega). O serviço recusa SECRET, OWNER_DATABASE_URL e APP_DB_PASSWORD, que
// o .env do app traz: ficam de fora do processo filho. O banco é o do app, com o papel `card` (CARD_DB_PASSWORD; a
// migração só dá login ao papel com ela definida). CARD_ORIGIN, CARD_TICKET_KEY e ASAAS_SEAL_KEY vêm do .env.
import { spawn } from "node:child_process";
import { join } from "node:path";

const DROP = ["SECRET", "OWNER_DATABASE_URL", "APP_DB_PASSWORD"];

function fail(message: string): never {
  console.error(`card:dev: ${message}`);
  process.exit(1);
}

const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROP.includes(k)) childEnv[k] = v;
childEnv.SERVICE = "card";

const password = process.env.CARD_DB_PASSWORD;
if (!password) fail("defina CARD_DB_PASSWORD no .env e rode `bun run migrate` (dá login ao papel `card`)");
if (!process.env.DATABASE_URL) fail("DATABASE_URL faltando no .env");
const db = new URL(process.env.DATABASE_URL);
db.username = "card";
db.password = password;
childEnv.DATABASE_URL = db.toString();

const child = spawn("node", [join(import.meta.dir, "..", "dist", "card", "server.js")], { env: childEnv as NodeJS.ProcessEnv, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
