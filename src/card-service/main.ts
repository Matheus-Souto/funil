// Entrada do serviço de cartão isolado (SERVICE=card): confere o ambiente e a ASAAS_SEAL_KEY, escuta na 3100 (CARD_PORT;
// 0 = porta livre, só testes) em 0.0.0.0, ou em 127.0.0.1 com CARD_ORIGIN http em loopback (`cardBindHost`), e, no
// SIGTERM/SIGINT, fecha o servidor e o pool do banco. Sem CARD_ORIGIN (instalação sem o cartão: o container sobe
// sempre), fica desligado: só o /healthz, sem banco.
// Empacotado com `bun build --target=node`; roda em Node (sem API do Bun). Os arquivos do formulário (`form.js`,
// `form.css`) ficam ao lado do bundle (`bun run card:build` gera os três em dist/card).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "@/lib/db/client";
import { parseEnv, type Env } from "@/lib/env";
import { checkAsaasSealKey } from "@/lib/integrations";
import { log } from "@/lib/log";
import { cardBindHost, createCardServer, createIdleCardServer } from "./server";

function fail(message: string): never {
  console.error(`funil-card: não foi possível iniciar. ${message}`);
  process.exit(1);
}

/** SIGTERM/SIGINT: fecha o servidor e depois `close` (o pool do banco, se houver); sai com 0, ou 1 se `close` falhar. */
function stopOnSignal(server: Server, close: () => Promise<void>): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("serviço de cartão: encerrando", { signal });
    server.close(() => {
      close().then(
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

/** Porta de CARD_PORT (padrão 3100) sem passar pelo `parseEnv`, que exige o banco e as chaves. */
function idlePort(raw: string | undefined): number {
  const n = raw === undefined || raw === "" ? 3100 : /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 0 && n <= 65535)) fail("CARD_PORT: deve ser um número de porta (0 a 65535)");
  return n;
}

async function main(): Promise<void> {
  if (process.env.SERVICE === "card" && !process.env.CARD_ORIGIN) {
    const server = createIdleCardServer();
    const host = cardBindHost(undefined);
    server.listen(idlePort(process.env.CARD_PORT), host, () =>
      log.info("serviço de cartão desligado: CARD_ORIGIN não definida (docs/instalacao.md, seção 12)", { host, port: (server.address() as AddressInfo).port }),
    );
    stopOnSignal(server, async () => {});
    return;
  }
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
    const seal = await checkAsaasSealKey();
    unreadable = seal.unreadable;
    // Conexões ainda em v1 (o app re-sela no boot dele, com a ASAAS_SEAL_KEY): até lá, a loja recebe "indisponível".
    if (seal.legacy > 0) {
      log.warn("conexões Asaas ainda em v1: o serviço de cartão não as abre (o app as re-sela no próximo boot, com a ASAAS_SEAL_KEY)", { count: seal.legacy });
    }
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
    assetsDir: dirname(fileURLToPath(import.meta.url)),
  });
  const host = cardBindHost(parsed.CARD_ORIGIN);
  server.listen(parsed.CARD_PORT, host, () => log.info("serviço de cartão no ar", { host, port: (server.address() as AddressInfo).port }));
  stopOnSignal(server, closeDb);
}

void main();
