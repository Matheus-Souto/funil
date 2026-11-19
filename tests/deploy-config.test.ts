// Empacotamento (Task 15): .env.example, compose.yaml e a CLI de migração empacotada para Node não podem divergir do
// que o app lê (src/lib/env.ts). Variável nova no env.ts sem documentação ou sem decisão de deploy reprova aqui.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { ENV_KEYS } from "@/lib/env";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Chaves documentadas no .env.example, ativas (`X=`) ou comentadas (`# X=`). */
const documented = new Set([...read(".env.example").matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));

// Variáveis que a instalação passa ao app (compose.yaml) e as que só existem para o smoke E2E local (loopback).
const PRODUCTION = [
  "MODE",
  "BASE_URL",
  "PLATFORM_DOMAIN",
  "DATABASE_URL",
  "OWNER_DATABASE_URL",
  "SECRET",
  "DATA_DIR",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET",
  "APP_DB_PASSWORD",
  "TRUST_PROXY",
  "SETUP_TOKEN",
];
// Cartão isolado (SERVICE=card / CARD_ISOLATED=1): o compose passa a levá-las na Task 9 do plano de isolamento.
const CARD_ISOLATION = ["SERVICE", "CARD_ISOLATED", "CARD_ORIGIN", "CARD_TICKET_KEY", "ASAAS_SEAL_KEY", "CARD_DB_PASSWORD"];
const TEST_ONLY = ["ASAAS_BASE_URL", "E2E_SEED_ROUTES", "META_GRAPH_BASE_URL"];

type Compose = {
  services: Record<
    string,
    {
      image?: string;
      environment?: Record<string, string>;
      ports?: unknown[];
      mem_limit?: string;
      stop_grace_period?: string;
      ulimits?: Record<string, unknown>;
      memswap_limit?: string;
    }
  >;
};
const compose = YAML.parse(read("compose.yaml")) as Compose;

test("toda variável do env.ts está classificada (produção ou só smoke)", () => {
  expect([...PRODUCTION, ...CARD_ISOLATION, ...TEST_ONLY].sort()).toEqual([...ENV_KEYS].sort());
});

test("toda variável do env.ts aparece no .env.example", () => {
  expect(ENV_KEYS.filter((k) => !documented.has(k))).toEqual([]);
});

test("toda variável usada pelo compose.yaml aparece no .env.example", () => {
  const used = [...read("compose.yaml").matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
  expect(used.length).toBeGreaterThan(0);
  expect([...new Set(used)].filter((k) => !documented.has(k))).toEqual([]);
});

test("compose.yaml: o app recebe as variáveis de produção e nunca as do smoke", () => {
  const appEnv = compose.services.app!.environment!;
  expect(PRODUCTION.filter((k) => !(k in appEnv))).toEqual([]);
  expect(TEST_ONLY.filter((k) => k in appEnv)).toEqual([]);
  expect(appEnv.NODE_ENV).toBe("production");
  expect(appEnv.TRUST_PROXY).toBe("${TRUST_PROXY:-1}"); // atrás do Caddy
  // Papéis distintos: o app com `app` (sujeito a RLS), migrações com o dono.
  expect(appEnv.DATABASE_URL).toMatch(/^postgres:\/\/app:/);
  expect(appEnv.OWNER_DATABASE_URL).toMatch(/^postgres:\/\/owner:/);
});

test("compose.yaml: só o Caddy publica portas; app com teto de 768 MB e parada graciosa", () => {
  const published = Object.entries(compose.services)
    .filter(([, s]) => (s.ports ?? []).length > 0)
    .map(([name]) => name);
  expect(published).toEqual(["caddy"]);
  // Orçamento (docs/instalacao.md): Next + 1 Worker de PDF (heap 192 MB) + buffers de um PDF de 50 MB.
  expect(compose.services.app!.mem_limit).toBe("768m");
  expect(compose.services.app!.stop_grace_period).toBe("30s");
});

test("compose.yaml: app sem core dump (o processo que recebe o cartão nunca grava memória em disco) e sem swap extra", () => {
  const app = compose.services.app!;
  expect(app.ulimits?.core).toEqual({ soft: 0, hard: 0 });
  // memswap_limit = mem_limit: o container não usa swap além da RAM (PAN/CVV em memória não vão para o disco).
  expect(app.memswap_limit).toBe(app.mem_limit);
  expect(compose.services.app!.environment!.SETUP_TOKEN).toBe("${SETUP_TOKEN:-}");
});

describe("Caddyfiles: HSTS em todo site servido", () => {
  for (const file of ["deploy/Caddyfile", "deploy/Caddyfile.multi"]) {
    test(file, () => {
      const text = read(file);
      // Blocos de site: linha na coluna 0 terminando em "{" (ex.: "{$DOMAIN} {", "*.{$PLATFORM_DOMAIN} {") até o "}" na coluna 0.
      const sites = [...text.matchAll(/^(\S.*)\{\n([\s\S]*?)^\}/gm)].filter(([, head]) => head!.trim() !== "");
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.length).toBe((text.match(/^\S.*\{$/gm) ?? []).length); // nenhum site ficou de fora
      for (const [, head, body] of sites) {
        expect(body, head).toMatch(/header\s+(\{[^}]*)?Strict-Transport-Security\s+"max-age=31536000"/);
        expect(body, head).not.toContain("preload");
      }
    });
  }
});

test("imagens base fixadas por versão menor (atualização: docker compose pull && docker compose build --pull)", () => {
  expect(compose.services.postgres!.image).toMatch(/^postgres:17\.\d+$/);
  expect(compose.services.caddy!.image).toMatch(/^caddy:2\.\d+$/);
  const dockerfile = read("deploy/Dockerfile");
  expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:22\.\d+-slim$/m);
  expect(dockerfile).toMatch(/^ARG BUN_IMAGE=oven\/bun:\d+\.\d+\.\d+$/m);
  expect(read("deploy/caddy-dns.Dockerfile")).toMatch(/^FROM caddy:2\.\d+-builder AS builder$/m);
});

test("CLI de migração empacotada para Node: importar não executa a migração; rodar direto sim", () => {
  const out = mkdtempSync(join(tmpdir(), "funil-cli-"));
  const build = spawnSync(
    "bun",
    ["build", "src/lib/db/migrate.ts", "--target=node", "--format=esm", "--outdir", out, "--entry-naming=[dir]/[name].mjs"],
    { cwd: root, encoding: "utf8" },
  );
  expect(build.status, build.stderr).toBe(0);
  const bundle = join(out, "migrate.mjs");
  // Sem OWNER_DATABASE_URL/APP_DB_PASSWORD: rodar direto falha com a mensagem de uso (nunca toca o banco).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "OWNER_DATABASE_URL" && k !== "APP_DB_PASSWORD"),
  ) as NodeJS.ProcessEnv;

  const direct = spawnSync("node", [bundle], { encoding: "utf8", env });
  expect(direct.status).toBe(1);
  expect(direct.stderr).toContain("migrate: defina OWNER_DATABASE_URL e APP_DB_PASSWORD");

  const importer = join(out, "importer.mjs");
  writeFileSync(importer, `const m = await import(${JSON.stringify(bundle)});\nconsole.log(typeof m.migrate);\n`);
  const imported = spawnSync("node", [importer], { encoding: "utf8", env });
  expect(imported.stderr).toBe("");
  expect(imported.status).toBe(0);
  expect(imported.stdout.trim()).toBe("function");
});

describe("deploy/entrypoint.sh: senhas fracas do Postgres recusadas antes de migrar", () => {
  const strong = "0123456789abcdef0123456789abcdef";
  const run = (over: Record<string, string>) =>
    spawnSync("sh", [join(root, "deploy/entrypoint.sh"), "start"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OWNER_DATABASE_URL: `postgres://owner:${strong}@postgres:5432/funil`,
        DATABASE_URL: `postgres://app:${strong}x@postgres:5432/funil`,
        APP_DB_PASSWORD: `${strong}x`,
        ...over,
      } as NodeJS.ProcessEnv,
    });

  test.each([
    ["APP_DB_PASSWORD", { APP_DB_PASSWORD: "app" }],
    ["APP_DB_PASSWORD", { APP_DB_PASSWORD: "curta123" }],
    ["POSTGRES_PASSWORD", { OWNER_DATABASE_URL: "postgres://owner:owner@postgres:5432/funil" }],
    ["POSTGRES_PASSWORD", { OWNER_DATABASE_URL: "postgres://owner:curta123@postgres:5432/funil" }],
  ])("%s fraca: sai com erro antes de migrar", (name, over) => {
    const r = run(over);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`entrypoint: ${name}`);
  });

  test("senhas fortes passam das conferências (fora da imagem, para no diretório /app)", () => {
    const r = run({ DATA_DIR: mkdtempSync(join(tmpdir(), "funil-data-")) });
    expect(r.stderr).not.toContain("entrypoint:");
    expect(r.stderr).toMatch(/\/app/);
  });

  test("SETUP_TOKEN: gerado (48 hex) e guardado no volume se faltar, impresso no log; o mesmo nas próximas subidas", () => {
    const data = mkdtempSync(join(tmpdir(), "funil-data-"));
    const first = run({ DATA_DIR: data, SETUP_TOKEN: "" });
    const token = /código de configuração inicial \(\/admin\/setup\): ([0-9a-f]{48})$/m.exec(first.stdout)?.[1];
    expect(token, first.stdout + first.stderr).toBeDefined();
    expect(readFileSync(join(data, ".setup-token"), "utf8").trim()).toBe(token!);
    expect((statSync(join(data, ".setup-token")).mode & 0o077) === 0).toBe(true);
    const again = run({ DATA_DIR: data, SETUP_TOKEN: "" });
    expect(again.stdout).toContain(token!);
  });

  test("SETUP_TOKEN do .env: usado como veio e nunca impresso", () => {
    const data = mkdtempSync(join(tmpdir(), "funil-data-"));
    const mine = "meu-codigo-de-setup-0123456789";
    const r = run({ DATA_DIR: data, SETUP_TOKEN: mine });
    expect(r.stdout + r.stderr).not.toContain(mine);
    expect(r.stdout).toContain("código de configuração inicial: definido no .env (SETUP_TOKEN)");
    expect(() => statSync(join(data, ".setup-token"))).toThrow();
  });
});
