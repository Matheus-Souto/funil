// Instância própria do app em MODE=multi para os E2E de várias lojas e do app integrado.
//
// O scripts/verify.sh sobe o app do smoke com MODE=single e sem APP_WEBHOOK_ALLOW_LOOPBACK (e o CI roda o verify.sh do
// main contra o e2e/ do branch). Em vez de mudar o verify, estes E2E sobem, a partir do mesmo build (.next) e do mesmo
// Postgres da rodada, a sua própria instalação:
//   - banco descartável `<banco da rodada>_<sufixo>` (criado e migrado aqui, apagado no fim);
//   - Asaas falso próprio (e2e/fakes/asaas-server.ts, também Meta/Resend/Telegram falsos);
//   - `next start` em 127.0.0.1 numa porta livre com MODE=multi e PLATFORM_DOMAIN=localhost.
// As lojas ficam em http://<slug>.localhost:<porta>: o Chromium resolve *.localhost para o loopback e trata como origem
// segura (o cookie de sessão do painel é `Secure`). Domínio próprio (store:domain) precisa do mapeamento no navegador
// (`--host-resolver-rules`, ver `hostResolverArgs`) e não é origem segura: serve ao checkout, não ao painel.
// Do lado do Node (Playwright), `*.localhost` não resolve em toda máquina: `hostRequest` fala com 127.0.0.1 e manda o
// cabeçalho Host da loja.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";

export const PLATFORM_DOMAIN = "localhost";

/** Pasta dos logs desta rodada (a mesma das capturas do smoke). */
export const RUN_DIR = process.env.PW_OUTPUT_DIR ? dirname(process.env.PW_OUTPUT_DIR) : ".verify/local";

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

export interface MultiApp {
  port: number;
  /** BASE_URL da instalação (loopback). */
  baseUrl: string;
  /** Asaas falso desta instância (com /__control, /meta etc.). */
  asaasBase: string;
  /** Banco desta instância com o papel dono (loopback): só para conferir o que o app gravou. */
  ownerDbUrl: string;
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
  stop(): Promise<void>;
}

/** Argumentos do Chromium que levam os hosts das lojas ao loopback. */
export function hostResolverArgs(extraHosts: string[] = []): string[] {
  const rules = ["MAP *.localhost 127.0.0.1", ...extraHosts.map((h) => `MAP ${h} 127.0.0.1`)];
  return [`--host-resolver-rules=${rules.join(", ")}`];
}

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

/** Espera uma linha que case com `re` na saída do processo; falha se ele sair antes. */
function waitForOutput(child: ChildProcess, re: RegExp, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer) => {
      seen = (seen + chunk.toString()).slice(-4000);
      if (re.test(seen)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`${what} saiu (código ${code}) antes de ficar pronto: ${seen.slice(-1500)}`));
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

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

/**
 * Sobe a instância multi. `name` vira sufixo do banco e dos logs (um por arquivo de teste). Chame `stop()` no afterAll.
 */
export async function startMultiApp(name: string): Promise<MultiApp> {
  const ownerUrl = process.env.E2E_OWNER_DATABASE_URL ?? "";
  if (!/^postgres:\/\/owner:[^@]+@(localhost|127\.0\.0\.1):\d+\/[\w-]+$/.test(ownerUrl)) {
    throw new Error("o verify passa E2E_OWNER_DATABASE_URL (banco descartável da rodada, papel dono, loopback)");
  }
  if (!/^[a-z0-9]+$/.test(name)) throw new Error("nome da instância: só [a-z0-9]");
  const u = new URL(ownerUrl);
  const dbName = `${u.pathname.slice(1)}_${name}`;
  const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`;
  const ownerDbUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/${dbName}`;
  const appDbUrl = `${u.protocol}//app:app@${u.host}/${dbName}`;

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
    await admin.unsafe(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  mkdirSync(RUN_DIR, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), `funil-e2e-${name}-`));
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  let fake: ChildProcess | null = null;
  let app: ChildProcess | null = null;
  const stop = async () => {
    await stopChild(app);
    await stopChild(fake);
    rmSync(dataDir, { recursive: true, force: true });
    const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
    try {
      await a.unsafe(`drop database if exists "${dbName}" with (force)`);
    } finally {
      await a.end();
    }
  };

  try {
    // Sem CARD_DB_PASSWORD: o papel `card` (do cluster inteiro, usado pelo serviço de cartão da rodada) fica como está.
    const mig = await run("bun", ["run", "migrate"], { ...base, OWNER_DATABASE_URL: ownerDbUrl, DATABASE_URL: appDbUrl, APP_DB_PASSWORD: "app" });
    if (mig.code !== 0) throw new Error(`migração falhou: ${mig.stderr.slice(-1500)}`);

    const fakePort = await freePort();
    const fakeChild = spawn("bun", ["e2e/fakes/asaas-server.ts"], { env: { ...base, PORT: String(fakePort) } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    fake = fakeChild;
    const fakeLog = createWriteStream(join(RUN_DIR, `multi-${name}-asaas-fake.log`));
    fakeChild.stdout.pipe(fakeLog);
    fakeChild.stderr.pipe(fakeLog);
    await waitForOutput(fakeChild, /asaas-fake ready on/, "Asaas falso");
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
      PORT: String(port),
    };
    const appChild = spawn("bun", ["run", "start", "-H", "127.0.0.1", "-p", String(port)], { env: env as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    app = appChild;
    const appLog = createWriteStream(join(RUN_DIR, `multi-${name}-app.log`));
    appChild.stdout.pipe(appLog);
    appChild.stderr.pipe(appLog);
    await waitForOutput(appChild, /Ready in/, "app multi");
    const health = await fetch(`${baseUrl}/api/health`);
    if (health.status !== 200) throw new Error(`app multi: /api/health respondeu ${health.status}`);

    const cliEnv = { ...env };
    delete cliEnv.PORT;
    const cli = (script: string, args: string[]) => run("bun", ["run", script, ...args], cliEnv);

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
    await stop();
    throw e;
  }
}
