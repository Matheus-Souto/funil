import { mock } from "bun:test";

// `server-only` lança erro fora do bundler do Next; nos testes vira um módulo vazio.
mock.module("server-only", () => ({}));
