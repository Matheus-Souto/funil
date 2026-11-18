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
  expect(() => parseEnv({})).toThrow(/BASE_URL.*DATABASE_URL.*OWNER_DATABASE_URL.*SECRET/s);
});

test("SECRET precisa de 32 caracteres", () => {
  expect(() => parseEnv({ ...base, SECRET: "curta" })).toThrow(/SECRET/);
});

test("ASAAS_BASE_URL é recusada em produção", () => {
  expect(() => parseEnv({ ...base, NODE_ENV: "production", ASAAS_BASE_URL: "http://x" })).toThrow(
    /ASAAS_BASE_URL.*produção/,
  );
  expect(parseEnv({ ...base, NODE_ENV: "production" }).ASAAS_BASE_URL).toBeUndefined();
});

test("MODE inválido falha", () => {
  expect(() => parseEnv({ ...base, MODE: "x" })).toThrow(/MODE/);
});
