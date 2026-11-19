// Entrada do serviço de cartão isolado (SERVICE=card): confere o ambiente e a ASAAS_SEAL_KEY, escuta em
// 0.0.0.0:3100 e, no SIGTERM/SIGINT, fecha o servidor e o pool do banco. Empacotado com `bun build --target=node`;
// roda em Node (sem API do Bun). Os arquivos do formulário (`form.js`, `form.css`) ficam ao lado do bundle.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "@/lib/db/client";
import { parseEnv, type Env } from "@/lib/env";
import { checkAsaasSealKey } from "@/lib/integrations";
import { log } from "@/lib/log";
import { createCardServer } from "./server";

const PORT = 3100;
const HOST = "0.0.0.0";

function fail(message: string): never {
  console.error(`funil-card: não foi possível iniciar. ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let parsed: Env;
  try {
    parsed = parseEnv(process.env);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (parsed.SERVICE !== "card") fail("SERVICE=card é obrigatória no serviço de cartão");
  // parseEnv já exige as duas com SERVICE=card; a checagem aqui só estreita o tipo.
  if (!parsed.CARD_ORIGIN || !parsed.CARD_TICKET_KEY) fail("CARD_ORIGIN e CARD_TICKET_KEY são obrigatórias com SERVICE=card");
  // Com origem https, o servidor só aceita o POST com X-Forwarded-Proto de um proxy confiável: sem proxy, nenhum.
  if (parsed.CARD_ORIGIN.startsWith("https:") && parsed.TRUST_PROXY === 0) {
    fail("TRUST_PROXY=0 com CARD_ORIGIN https: todo pagamento seria recusado; defina TRUST_PROXY (atrás do Caddy: 1)");
  }

  // Chave trocada, removida ou rollback trancaria o Asaas de todas as lojas sem aviso (mesma regra do app).
  let unreadable = 0;
  try {
    unreadable = (await checkAsaasSealKey()).unreadable;
  } catch (e) {
    // Banco fora no boot: o healthcheck acusa; a conferência fica para a próxima subida.
    log.error("não foi possível conferir a ASAAS_SEAL_KEY no boot", { error: e });
  }
  if (unreadable > 0) {
    fail(`ASAAS_SEAL_KEY ausente ou diferente da que selou a conexão Asaas de ${unreadable} loja(s); restaure a chave correta`);
  }

  const server = createCardServer({
    cardOrigin: parsed.CARD_ORIGIN,
    ticketKey: parsed.CARD_TICKET_KEY,
    trustProxy: parsed.TRUST_PROXY,
    turnstileSiteKey: parsed.TURNSTILE_SITE_KEY,
    assetsDir: dirname(fileURLToPath(import.meta.url)),
  });
  server.listen(PORT, HOST, () => log.info("serviço de cartão no ar", { port: PORT }));

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("serviço de cartão: encerrando", { signal });
    server.close(() => {
      closeDb().then(
        () => process.exit(0),
        (e: unknown) => {
          log.error("serviço de cartão: falha ao fechar o banco", { error: e });
          process.exit(1);
        },
      );
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

void main();
