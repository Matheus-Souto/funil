import { requireOwnerUrl } from "@/lib/db/client";
import { parseEnv } from "@/lib/env";

const base = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://app:app@localhost:5433/funil",
  OWNER_DATABASE_URL: "postgres://owner:owner@localhost:5433/funil",
  SECRET: "s".repeat(32),
};

test("parseEnv aplica padrões e aceita opcionais", () => {
  const e = parseEnv({ ...base, ASAAS_BASE_URL: "http://localhost:4010", APP_DB_PASSWORD: "app" });
  expect(e.MODE).toBe("single");
  expect(e.DATA_DIR).toBe("./data");
  expect(e.ASAAS_BASE_URL).toBe("http://localhost:4010");
  expect(e.APP_DB_PASSWORD).toBe("app");
  expect(e.TURNSTILE_SECRET).toBeUndefined();
});

test("parseEnv lista as variáveis faltando", () => {
  expect(() => parseEnv({})).toThrow(/BASE_URL.*DATABASE_URL.*SECRET/s);
});

test("OWNER_DATABASE_URL é opcional para o app (o servidor de produção roda sem o papel dono)", () => {
  expect(parseEnv({ ...base, OWNER_DATABASE_URL: undefined, NODE_ENV: "production", TRUST_PROXY: "1" }).OWNER_DATABASE_URL).toBeUndefined();
  expect(() => requireOwnerUrl({})).toThrow("OWNER_DATABASE_URL não definida");
  expect(requireOwnerUrl({ OWNER_DATABASE_URL: base.OWNER_DATABASE_URL })).toBe(base.OWNER_DATABASE_URL);
});

test("um só comando para gerar o SECRET em todas as mensagens: openssl rand -hex 32", () => {
  expect(() => parseEnv({ ...base, SECRET: "troque-por-um-segredo-aleatorio-de-32-ou-mais-caracteres" })).toThrow("openssl rand -hex 32");
});

test("SECRET precisa de 32 caracteres", () => {
  expect(() => parseEnv({ ...base, SECRET: "curta" })).toThrow(/SECRET/);
});

test("ASAAS_BASE_URL em produção só aceita loopback", () => {
  for (const url of ["http://127.0.0.1:4010", "http://localhost:4010/x", "http://[::1]:4010"]) {
    expect(parseEnv({ ...base, NODE_ENV: "production", ASAAS_BASE_URL: url }).ASAAS_BASE_URL).toBe(url);
  }
  for (const url of ["http://x", "https://api.asaas.com", "http://127.0.0.1.evil.com", "lixo"]) {
    expect(() => parseEnv({ ...base, NODE_ENV: "production", ASAAS_BASE_URL: url })).toThrow(/ASAAS_BASE_URL.*loopback/);
  }
  expect(parseEnv({ ...base, NODE_ENV: "production" }).ASAAS_BASE_URL).toBeUndefined();
});

test("TRUST_PROXY: obrigatório em produção fora de loopback; padrão 0 em loopback e fora de produção", () => {
  const remote = { ...base, NODE_ENV: "production", BASE_URL: "https://loja.example.com" };
  expect(() => parseEnv(remote)).toThrow(/TRUST_PROXY.*obrigatória em produção/);
  expect(parseEnv({ ...remote, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
  expect(parseEnv({ ...remote, TRUST_PROXY: "0" }).TRUST_PROXY).toBe(0);
  expect(parseEnv({ ...base, NODE_ENV: "production", BASE_URL: "http://127.0.0.1:3000" }).TRUST_PROXY).toBe(0);
  expect(parseEnv({ ...base, BASE_URL: "https://loja.example.com" }).TRUST_PROXY).toBe(0);
  expect(() => parseEnv({ ...remote, TRUST_PROXY: "sim" })).toThrow(/TRUST_PROXY/);
});

test("MODE inválido falha", () => {
  expect(() => parseEnv({ ...base, MODE: "x" })).toThrow(/MODE/);
});

test("SECRET de exemplo é recusado com mensagem clara", () => {
  for (const secret of [
    "troque-por-um-segredo-aleatorio-de-32-ou-mais-caracteres",
    "TROQUE-ESTE-SEGREDO-por-um-valor-aleatorio-longo",
  ]) {
    expect(() => parseEnv({ ...base, SECRET: secret })).toThrow(/SECRET.*exemplo/);
  }
});

test(".env.example não traz um SECRET que passe na validação", async () => {
  const text = await Bun.file(new URL("../.env.example", import.meta.url)).text();
  const line = text.split("\n").find((l) => l.startsWith("SECRET="));
  const value = line?.slice("SECRET=".length).trim() ?? "";
  expect(() => parseEnv({ ...base, SECRET: value })).toThrow(/SECRET/);
});

test("MODE=multi exige PLATFORM_DOMAIN", () => {
  expect(() => parseEnv({ ...base, MODE: "multi" })).toThrow(/PLATFORM_DOMAIN/);
  expect(parseEnv({ ...base, MODE: "multi", PLATFORM_DOMAIN: "lojas.example.com" }).PLATFORM_DOMAIN).toBe("lojas.example.com");
  expect(parseEnv({ ...base, MODE: "single" }).MODE).toBe("single");
});

test("BASE_URL precisa ser URL http(s) sem barra final", () => {
  for (const url of ["localhost:3000", "ftp://x.com", "loja.example.com", "http://x.com/", "https://x.com/loja/", "lixo"]) {
    expect(() => parseEnv({ ...base, BASE_URL: url })).toThrow(/BASE_URL/);
  }
  for (const url of ["http://localhost:3000", "https://loja.example.com", "https://x.com/base"]) {
    expect(parseEnv({ ...base, BASE_URL: url }).BASE_URL).toBe(url);
  }
});

test("TURNSTILE_SITE_KEY e TURNSTILE_SECRET juntos ou nenhum", () => {
  expect(() => parseEnv({ ...base, TURNSTILE_SITE_KEY: "k" })).toThrow(/TURNSTILE/);
  expect(() => parseEnv({ ...base, TURNSTILE_SECRET: "s" })).toThrow(/TURNSTILE/);
  expect(parseEnv({ ...base, TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" }).TURNSTILE_SECRET).toBe("s");
  expect(parseEnv(base).TURNSTILE_SITE_KEY).toBeUndefined();
});

test("E2E_SEED_ROUTES=1 só com BASE_URL em loopback (rota só do smoke)", () => {
  for (const url of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"]) {
    expect(parseEnv({ ...base, NODE_ENV: "production", BASE_URL: url, E2E_SEED_ROUTES: "1" }).E2E_SEED_ROUTES).toBe("1");
  }
  for (const url of ["https://loja.example.com", "http://127.0.0.1.evil.com"]) {
    expect(() => parseEnv({ ...base, BASE_URL: url, TRUST_PROXY: "1", E2E_SEED_ROUTES: "1" })).toThrow(/E2E_SEED_ROUTES.*loopback/);
  }
  expect(parseEnv(base).E2E_SEED_ROUTES).toBeUndefined();
  expect(() => parseEnv({ ...base, E2E_SEED_ROUTES: "sim" })).toThrow(/E2E_SEED_ROUTES/);
});

test("isLoopbackUrl: 127.0.0.1, localhost e ::1 (com ou sem colchetes)", async () => {
  const { isLoopbackUrl } = await import("@/lib/env");
  for (const u of ["http://127.0.0.1:1", "http://localhost", "http://[::1]:3000", "::1", "127.0.0.1", "localhost:4010"]) expect(isLoopbackUrl(u)).toBe(true);
  for (const u of ["http://x", "https://api.asaas.com", "http://127.0.0.1.evil.com", "lixo", ""]) expect(isLoopbackUrl(u)).toBe(false);
});

test("SETUP_TOKEN: opcional para o app; se definido, 16+ caracteres", () => {
  expect(parseEnv(base).SETUP_TOKEN).toBeUndefined();
  expect(parseEnv({ ...base, SETUP_TOKEN: "a".repeat(16) }).SETUP_TOKEN).toBe("a".repeat(16));
  expect(() => parseEnv({ ...base, SETUP_TOKEN: "curto" })).toThrow(/SETUP_TOKEN/);
});
