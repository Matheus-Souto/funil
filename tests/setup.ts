import { mock } from "bun:test";

// `server-only` lança erro fora do bundler do Next; nos testes vira um módulo vazio.
mock.module("server-only", () => ({}));

// Valores mínimos para `env` nos testes; variáveis já definidas no ambiente prevalecem.
const testEnv: Record<string, string> = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://app:app@localhost:5433/funil",
  OWNER_DATABASE_URL: "postgres://owner:owner@localhost:5433/funil",
  SECRET: "test-secret-test-secret-test-secret-0123",
};
for (const [k, v] of Object.entries(testEnv)) process.env[k] ??= v;
