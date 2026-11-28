// Instância própria do app em MODE=multi para os E2E de várias lojas e do app integrado.
//
// O scripts/verify.sh sobe o app do smoke com MODE=single e sem APP_WEBHOOK_ALLOW_LOOPBACK (e o CI roda o verify.sh do
// main contra o e2e/ do branch). Em vez de mudar o verify, estes E2E sobem, a partir do mesmo build (.next) e do mesmo
// Postgres da rodada, a sua própria instalação:
//   - banco descartável `<banco da rodada>_<nome>_<aleatório>` (criado e migrado aqui, apagado no fim);
//   - Asaas falso próprio (e2e/fakes/asaas-server.ts, também Meta/Resend/Telegram falsos), na porta que ele escolher;
//   - o Next direto com `node` (um PID nosso, sem o `bun run` no meio) em 127.0.0.1, com MODE=multi e
//     PLATFORM_DOMAIN=localhost.
// As lojas ficam em http://<slug>.localhost:<porta>: o Chromium resolve *.localhost para o loopback e trata como origem
// segura (o cookie de sessão do painel é `Secure`). Domínio próprio (store:domain) precisa do mapeamento no navegador
// (`--host-resolver-rules`, ver `hostResolverArgs`) e não é origem segura: serve ao checkout, não ao painel.
// Do lado do Node (Playwright), `*.localhost` não resolve em toda máquina: `hostRequest` fala com 127.0.0.1 e manda o
// cabeçalho Host da loja.
//
// Limpeza: cada recurso registra a sua desfeita ANTES de existir (o banco é apagado com `if exists`), e `stop()` roda
// todas, cada uma isolada (uma falha não pula as outras), em ordem inversa. Processos: só os PIDs que esta instância
// criou, TERM e, passado o prazo, KILL; a porta do app é conferida fechada no fim. Falha no meio da subida chama a
// mesma limpeza antes de repassar o erro.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, type WriteStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";

export const PLATFORM_DOMAIN = "localhost";

/** Pasta dos logs desta rodada (a mesma das capturas do smoke). */
export const RUN_DIR = process.env.PW_OUTPUT_DIR ? dirname(process.env.PW_OUTPUT_DIR) : ".verify/local";

/** Prazo para um processo nosso sair depois do TERM (e depois do KILL). */
const STOP_GRACE_MS = 5_000;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HostResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface StartOptions {
  /** Variáveis a mais (ou trocadas) para o app; também usadas para induzir falha de subida ao testar a limpeza. */
  extraEnv?: Record<string, string>;
}

export interface MultiApp {
  port: number;
  /** BASE_URL da instalação (loopback). */
  baseUrl: string;
  /** Asaas falso desta instância (com /__control, /meta etc.). */
  asaasBase: string;
  /** Banco desta instância com o papel dono (loopback): só para conferir o que o app gravou. */
  ownerDbUrl: string;
  /** Nome do banco descartável (para conferir que a limpeza o apagou). */
  dbName: string;
  /** http://<slug>.localhost:<porta> */
  storeOrigin(slug: string): string;
  /** http://<host>:<porta> (domínio próprio) */
  hostOrigin(host: string): string;
  /** Roda um script do package.json (ex.: store:create) com o mesmo ambiente do app. */
  cli(script: string, args: string[]): Promise<CliResult>;
  /** `store:create`: devolve a senha temporária do dono (impressa uma vez pelo CLI). */
  createStore(o: { name: string; slug: string; ownerEmail: string; domain?: string }): Promise<{ storeId: string; temporaryPassword: string }>;
  /** Requisição HTTP a 127.0.0.1 com o cabeçalho Host dado (a loja é escolhida pelo Host, como atrás do Caddy). */
  hostRequest(host: string, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<HostResponse>;
  /** Desfaz tudo (idempotente). Junta os erros das etapas e os lança no fim, depois de tentar todas. */
  stop(): Promise<void>;
}

/** Argumentos do Chromium que levam os hosts das lojas ao loopback. */
export function hostResolverArgs(extraHosts: string[] = []): string[] {
  const rules = ["MAP *.localhost 127.0.0.1", ...extraHosts.map((h) => `MAP ${h} 127.0.0.1`)];
  return [`--host-resolver-rules=${rules.join(", ")}`];
}

/**
 * Porta livre agora. Só para o app: o BASE_URL (com a porta) entra no ambiente dele antes de ele subir (URL do webhook do
 * Asaas, origens do checkout), então não dá para deixar o Next escolher. Se outra coisa pegar a porta no intervalo, o
 * Next sai com EADDRINUSE e a subida falha com o log (o mesmo método do `free_port` do verify.sh).
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("sem porta"))));
    });
  });
}

/** Espera uma linha que case com `re` na saída do processo e devolve o 1º grupo; falha se ele sair antes. */
function waitForOutput(child: ChildProcess, re: RegExp, what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer) => {
      seen = (seen + chunk.toString()).slice(-8000);
      const m = re.exec(seen);
      if (m) {
        cleanup();
        resolve(m[1] ?? m[0]);
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      reject(new Error(`${what} saiu (código ${code}, sinal ${signal}) antes de ficar pronto: ${seen.slice(-1500)}`));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: env as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.once("error", reject);
    child.once("exit", (code: number | null) => resolve({ code, stdout, stderr }));
  });
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Promessa do `exit` com prazo: `true` se saiu dentro dele. */
function exitWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(exited(child));
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/** Encerra um processo que esta instância criou: TERM, prazo, KILL, prazo. Falha se nem o KILL o derrubar. */
async function stopProcess(child: ChildProcess, what: string): Promise<void> {
  if (exited(child)) return;
  child.kill("SIGTERM");
  if (await exitWithin(child, STOP_GRACE_MS)) return;
  child.kill("SIGKILL");
  if (!(await exitWithin(child, STOP_GRACE_MS))) throw new Error(`${what} (PID ${child.pid}) não saiu nem com SIGKILL`);
}

/** `true` se ninguém aceita conexão em 127.0.0.1:<porta>. */
function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

function logTo(child: ChildProcess, file: string): WriteStream {
  const out = createWriteStream(file);
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  return out;
}

/** Fecha o arquivo de log e espera ele ir para o disco (quem lê o log depois do `stop()` vê tudo). */
const closeLog = (out: WriteStream) => new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));

/**
 * Sobe a instância multi. `name` identifica a instância no banco e nos logs (um por arquivo de teste). Chame `stop()` no
 * afterAll (num `finally`).
 */
export async function startMultiApp(name: string, opts: StartOptions = {}): Promise<MultiApp> {
  const ownerUrl = process.env.E2E_OWNER_DATABASE_URL ?? "";
  if (!/^postgres:\/\/owner:[^@]+@(localhost|127\.0\.0\.1):\d+\/[\w-]+$/.test(ownerUrl)) {
    throw new Error("o verify passa E2E_OWNER_DATABASE_URL (banco descartável da rodada, papel dono, loopback)");
  }
  if (!/^[a-z0-9]+$/.test(name)) throw new Error("nome da instância: só [a-z0-9]");
  const u = new URL(ownerUrl);
  // Sufixo aleatório: duas instâncias com o mesmo nome (ou uma sobra de rodada interrompida) nunca dividem banco.
  const dbName = `${u.pathname.slice(1)}_${name}_${randomBytes(4).toString("hex")}`;
  const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`;
  const ownerDbUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/${dbName}`;
  const appDbUrl = `${u.protocol}//app:app@${u.host}/${dbName}`;

  const undo: { what: string; run: () => Promise<void> }[] = [];
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      const errors: unknown[] = [];
      for (const step of undo.reverse()) {
        try {
          await step.run();
        } catch (e) {
          errors.push(new Error(`limpeza "${step.what}": ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `instância multi ${name}: ${errors.length} etapa(s) de limpeza falharam`);
    })();
    return stopped;
  };

  try {
    // Banco: a desfeita vem antes da criação (drop if exists), então qualquer falha daqui em diante o apaga.
    undo.push({
      what: "apagar o banco",
      run: async () => {
        const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
        try {
          await a.unsafe(`drop database if exists "${dbName}" with (force)`);
        } finally {
          await a.end();
        }
      },
    });
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`create database "${dbName}"`);
    } finally {
      await admin.end();
    }

    mkdirSync(RUN_DIR, { recursive: true });
    const dataDir = mkdtempSync(join(tmpdir(), `funil-e2e-${name}-`));
    undo.push({ what: "apagar a pasta de dados", run: async () => rmSync(dataDir, { recursive: true, force: true }) });
    const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

    // Sem CARD_DB_PASSWORD: o papel `card` (do cluster inteiro, usado pelo serviço de cartão da rodada) fica como está.
    const mig = await run("bun", ["run", "migrate"], { ...base, OWNER_DATABASE_URL: ownerDbUrl, DATABASE_URL: appDbUrl, APP_DB_PASSWORD: "app" });
    if (mig.code !== 0) throw new Error(`migração falhou: ${mig.stderr.slice(-1500)}`);

    // Asaas falso na porta 0: ele mesmo escolhe e imprime a porta efetiva.
    const fake = spawn("bun", ["e2e/fakes/asaas-server.ts"], { env: { ...base, PORT: "0" } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    const fakeLog = logTo(fake, join(RUN_DIR, `multi-${name}-asaas-fake.log`));
    undo.push({ what: "fechar o log do Asaas falso", run: () => closeLog(fakeLog) });
    undo.push({ what: "encerrar o Asaas falso", run: () => stopProcess(fake, "Asaas falso") });
    const fakePort = await waitForOutput(fake, /asaas-fake ready on (\d+)/, "Asaas falso");
    const asaasBase = `http://127.0.0.1:${fakePort}`;

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    // Sem CARD_ORIGIN: esta instância vende só Pix (o cartão isolado é coberto pelo smoke).
    const env: Record<string, string> = {
      ...base,
      NODE_ENV: "production",
      MODE: "multi",
      PLATFORM_DOMAIN,
      BASE_URL: baseUrl,
      SECRET: randomBytes(32).toString("hex"),
      DATABASE_URL: appDbUrl,
      OWNER_DATABASE_URL: ownerDbUrl,
      APP_DB_PASSWORD: "app",
      DATA_DIR: dataDir,
      ASAAS_BASE_URL: asaasBase,
      META_GRAPH_BASE_URL: `${asaasBase}/meta`,
      RESEND_BASE_URL: `${asaasBase}/resend`,
      TELEGRAM_BASE_URL: `${asaasBase}/telegram`,
      E2E_SEED_ROUTES: "1",
      APP_WEBHOOK_ALLOW_LOOPBACK: "1",
      ...opts.extraEnv,
    };
    // O Next direto com node: o PID que encerramos é o do servidor que segura a porta.
    const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      env: env as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const appLog = logTo(app, join(RUN_DIR, `multi-${name}-app.log`));
    undo.push({ what: "fechar o log do app", run: () => closeLog(appLog) });
    undo.push({
      what: "encerrar o app",
      run: async () => {
        await stopProcess(app, "app multi");
        if (!(await portClosed(port))) throw new Error(`a porta ${port} do app continua aberta`);
      },
    });
    await waitForOutput(app, /(Ready in)/, "app multi");
    const health = await fetch(`${baseUrl}/api/health`);
    if (health.status !== 200) throw new Error(`app multi: /api/health respondeu ${health.status}`);

    const cli = (script: string, args: string[]) => run("bun", ["run", script, ...args], env);

    const hostRequest: MultiApp["hostRequest"] = (host, path, init = {}) =>
      new Promise((resolve, reject) => {
        const body = init.body;
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: init.method ?? "GET",
            headers: { host: `${host}:${port}`, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...init.headers },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
          },
        );
        req.once("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
      });

    return {
      port,
      baseUrl,
      asaasBase,
      ownerDbUrl,
      dbName,
      storeOrigin: (slug) => `http://${slug}.${PLATFORM_DOMAIN}:${port}`,
      hostOrigin: (host) => `http://${host}:${port}`,
      cli,
      async createStore(o) {
        const args = ["--name", o.name, "--slug", o.slug, "--owner-email", o.ownerEmail, ...(o.domain ? ["--domain", o.domain] : [])];
        const r = await cli("store:create", args);
        if (r.code !== 0) throw new Error(`store:create ${o.slug} falhou: ${r.stderr || r.stdout}`);
        const storeId = /Loja criada: \S+ \(([0-9a-f-]{36})\)/.exec(r.stdout)?.[1];
        const temporaryPassword = /\(aparece só agora\): (\S+)/.exec(r.stdout)?.[1];
        if (!storeId || !temporaryPassword) throw new Error(`store:create ${o.slug}: saída inesperada`);
        return { storeId, temporaryPassword };
      },
      hostRequest,
      stop,
    };
  } catch (e) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([e, cleanupError], `subida da instância multi ${name} falhou e a limpeza também`);
    }
    throw e;
  }
}

/** Conferência usada pelo teste de limpeza: o banco existe? */
export async function databaseExists(dbName: string): Promise<boolean> {
  const u = new URL(process.env.E2E_OWNER_DATABASE_URL ?? "");
  const a = postgres(`${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`, { max: 1, onnotice: () => {} });
  try {
    return (await a`select 1 from pg_database where datname = ${dbName}`).length > 0;
  } finally {
    await a.end();
  }
}

export { portClosed };
