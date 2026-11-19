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
  // Cartão isolado: o app emite o bilhete (CARD_TICKET_KEY), re-sela a conexão Asaas (ASAAS_SEAL_KEY) e a migração cria
  // o papel `card` com login (CARD_DB_PASSWORD).
  "CARD_ISOLATED",
  "CARD_ORIGIN",
  "CARD_TICKET_KEY",
  "ASAAS_SEAL_KEY",
  "CARD_DB_PASSWORD",
];
// O serviço de cartão (compose: `card`, profile `card`) recebe exatamente estas, e nada do dono, do SMTP ou do SECRET.
const CARD_SERVICE = [
  "SERVICE",
  "MODE",
  "BASE_URL",
  "PLATFORM_DOMAIN",
  "DATABASE_URL",
  "CARD_ORIGIN",
  "CARD_TICKET_KEY",
  "ASAAS_SEAL_KEY",
  "TRUST_PROXY",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET",
];
// CARD_PORT: o serviço escuta sempre na 3100 em produção; outra porta só no teste do bundle em Node (CARD_PORT=0).
const TEST_ONLY = ["ASAAS_BASE_URL", "E2E_SEED_ROUTES", "META_GRAPH_BASE_URL", "CARD_PORT"];

type Compose = {
  services: Record<
    string,
    {
      image?: string;
      build?: { context?: string; dockerfile?: string; target?: string };
      profiles?: string[];
      environment?: Record<string, string>;
      volumes?: unknown[];
      networks?: string[] | Record<string, unknown>;
      depends_on?: Record<string, { condition?: string }>;
      read_only?: boolean;
      tmpfs?: string[];
      cap_drop?: string[];
      security_opt?: string[];
      pids_limit?: number;
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
  expect([...new Set([...PRODUCTION, ...CARD_SERVICE, ...TEST_ONLY])].sort()).toEqual([...ENV_KEYS].sort());
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

describe("compose.yaml: serviço de cartão isolado (profile card)", () => {
  const card = compose.services.card!;
  const networksOf = (name: string) => {
    const n = compose.services[name]!.networks;
    return n === undefined ? ["default"] : Array.isArray(n) ? n : Object.keys(n);
  };

  test("só sobe com COMPOSE_PROFILES=card; imagem do estágio card do mesmo Dockerfile", () => {
    expect(card.profiles).toEqual(["card"]);
    expect(card.build).toMatchObject({ context: ".", dockerfile: "deploy/Dockerfile", target: "card" });
  });

  test("ambiente mínimo: nada do dono, do SECRET, do SMTP nem da senha do papel app; banco com o papel card", () => {
    const envKeys = Object.keys(card.environment!);
    expect([...envKeys].sort()).toEqual([...CARD_SERVICE].sort());
    for (const k of envKeys) expect(k).not.toMatch(/^(SECRET|OWNER_DATABASE_URL|APP_DB_PASSWORD|CARD_DB_PASSWORD|SMTP|META)/);
    expect(card.environment!.SERVICE).toBe("card");
    expect(card.environment!.TRUST_PROXY).toBe("${TRUST_PROXY:-1}");
    expect(card.environment!.DATABASE_URL).toContain("postgres://card:${CARD_DB_PASSWORD}@postgres:5432/funil");
    expect(card.environment!.DATABASE_URL).not.toMatch(/owner|app:/);
  });

  test("sem volume nem porta publicada; raiz só leitura com /tmp em memória", () => {
    expect(card.volumes).toBeUndefined();
    expect(card.ports).toBeUndefined();
    expect(card.read_only).toBe(true);
    expect(card.tmpfs).toEqual(["/tmp"]);
  });

  test("sem capabilities, sem ganhar privilégio (setuid da imagem base) e com teto de processos", () => {
    expect(card.cap_drop).toEqual(["ALL"]);
    expect(card.security_opt).toEqual(["no-new-privileges:true"]);
    expect(card.pids_limit).toBe(64);
  });

  test("teto de 192 MB sem swap extra, sem core dump e parada que espera a cobrança em curso (até 75 s)", () => {
    expect(card.mem_limit).toBe("192m");
    expect(card.memswap_limit).toBe(card.mem_limit);
    expect(card.ulimits?.core).toEqual({ soft: 0, hard: 0 });
    expect(card.stop_grace_period).toBe("90s");
    expect(card.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
  });

  test("rede própria: o card só alcança Postgres e Caddy (nunca o app)", () => {
    expect(networksOf("card")).toEqual(["card"]);
    const onCard = Object.keys(compose.services).filter((n) => networksOf(n).includes("card"));
    expect(onCard.sort()).toEqual(["caddy", "card", "postgres"]);
    expect(networksOf("app")).not.toContain("card");
  });

  test("o app recebe as variáveis do cartão isolado (desligado por padrão)", () => {
    const appEnv = compose.services.app!.environment!;
    expect(appEnv.CARD_ISOLATED).toBe("${CARD_ISOLATED:-0}");
    for (const k of ["CARD_ORIGIN", "CARD_TICKET_KEY", "ASAAS_SEAL_KEY", "CARD_DB_PASSWORD"]) expect(appEnv[k]).toBe(`\${${k}:-}`);
  });
});

/** Blocos de site do Caddyfile: linha na coluna 0 terminando em "{" até o "}" na coluna 0 (cabeça, corpo). */
const caddySites = (text: string) =>
  [...text.matchAll(/^(\S.*)\{\n([\s\S]*?)^\}/gm)].filter(([, head]) => head!.trim() !== "").map(([, head, body]) => ({ head: head!.trim(), body: body! }));

describe("Caddy: domínio do cartão só para o card, e nada do card fora dele", () => {
  test("Caddyfile.card: um site, o CARD_ORIGIN, só para card:3100 (keepalive abaixo dos 5 s do serviço), sem app", () => {
    const sites = caddySites(read("deploy/Caddyfile.card"));
    expect(sites.map((s) => s.head)).toEqual(["{$CARD_ORIGIN}"]);
    const body = sites[0]!.body;
    expect(body).toMatch(/reverse_proxy card:3100\b/);
    expect(body).toMatch(/keepalive 4s/);
    expect(body).toMatch(/-Server\b/);
    expect(body).not.toContain("app:3000");
    // Só as rotas do serviço; o resto (inclusive /healthz) não sai do Caddy.
    expect(body).toMatch(/@card path \/form\/\* \/form\.js \/form\.css \/api\/card\n/);
  });

  for (const file of ["deploy/Caddyfile", "deploy/Caddyfile.multi"]) {
    test(`${file}: importa o site do cartão por glob (nunca por variável); nenhum site seu manda para o card`, () => {
      const text = read(file);
      expect(text).toMatch(/^import card\/\*\.caddy$/m);
      // `{$X:padrão}` do Caddy NÃO usa o padrão quando X existe vazia (o compose passa vazia): `import` sem argumento
      // derruba o Caddy de toda instalação sem o cartão. Nenhum import pode depender de variável.
      for (const line of text.split("\n").filter((l) => /^\s*import\b/.test(l))) expect(line).not.toContain("{$");
      for (const s of caddySites(text)) expect(s.body, s.head).not.toContain("card:3100");
    });
  }

  /** Interpolação do compose para as formas usadas aqui: `${X:+valor}` (só se X não vazia) e `${X:-padrão}`. */
  const interpolate = (text: string, vars: Record<string, string>) =>
    text.replace(/\$\{(\w+):([+-])([^}]*)\}/g, (_m, name: string, op: string, word: string) => {
      const v = vars[name] ?? "";
      return op === "+" ? (v ? word : "") : v || word;
    });

  test.each([
    ["sem CARD_ORIGIN (instalação sem o cartão)", "", false],
    ["com CARD_ORIGIN", "https://pagar.loja.example.com", true],
  ])("compose + Caddyfile, %s: o glob do import pega o Caddyfile.card só quando deve", (_name, origin, served) => {
    const caddy = compose.services.caddy!;
    const mounts = (caddy.volumes as string[]).map((v) => interpolate(v, { CARD_ORIGIN: origin }).split(":"));
    const card = mounts.find(([src]) => src === "./deploy/Caddyfile.card");
    expect(card).toBeDefined();
    const target = card![1]!;
    expect(target.startsWith("/etc/caddy/")).toBe(true);
    // O import é relativo ao /etc/caddy/Caddyfile.
    expect(new Bun.Glob("card/*.caddy").match(target.slice("/etc/caddy/".length))).toBe(served);
    expect(caddy.environment!.CARD_ORIGIN).toBe("${CARD_ORIGIN:-}");
  });
});

test("Dockerfile: estágio card só com dist/card (sem node_modules nem .next), tini, não-root e healthcheck com GET", () => {
  const dockerfile = read("deploy/Dockerfile");
  const stages = dockerfile.split(/^(?=FROM )/m);
  // O app (compose sem `target`) continua sendo o último estágio.
  expect(stages.at(-1)).toMatch(/^FROM \S+ AS runtime$/m);
  const card = stages.find((s) => /^FROM \S+ AS card$/m.test(s))?.replace(/^#.*\n/gm, "");
  expect(card).toBeDefined();
  const copies = [...card!.matchAll(/^COPY (.*)$/gm)].map((m) => m[1]);
  expect(copies).toEqual(["--from=card-build /src/dist/card ./"]);
  expect(card).not.toMatch(/node_modules|\.next/);
  expect(card).toMatch(/^USER node$/m);
  expect(card).toMatch(/tini/);
  expect(card).toMatch(/HEALTHCHECK[\s\S]*fetch\('http:\/\/127\.0\.0\.1:3100\/healthz'\)/);
  // O build usa o script do projeto (iife do formulário, CSS ao lado do server.js).
  expect(dockerfile).toMatch(/^RUN bun run card:build$/m);
});

describe("Caddyfiles: HSTS em todo site servido", () => {
  for (const file of ["deploy/Caddyfile", "deploy/Caddyfile.multi", "deploy/Caddyfile.card"]) {
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
    ["CARD_DB_PASSWORD", { CARD_DB_PASSWORD: "card" }],
    ["CARD_DB_PASSWORD", { CARD_DB_PASSWORD: "curta123" }],
    // Igual à do papel app ou à do dono: quem comprometer o card (que tem a senha no ambiente) entraria como eles.
    ["CARD_DB_PASSWORD", { CARD_DB_PASSWORD: `${strong}x` }],
    ["CARD_DB_PASSWORD", { CARD_DB_PASSWORD: strong }],
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
