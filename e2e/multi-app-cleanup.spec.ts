// Limpeza da instância multi própria dos E2E (e2e/support/multi-app.ts): uma subida que falha no meio e uma parada normal
// não deixam banco descartável, processo nem porta para trás.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { RUN_DIR, databaseExists, portClosed, startMultiApp } from "./support/multi-app";

test.describe.configure({ timeout: 180_000 });

/** Bancos que sobraram de uma instância com este nome (o sufixo é aleatório). */
async function leftovers(name: string): Promise<string[]> {
  const u = new URL(process.env.E2E_OWNER_DATABASE_URL ?? "");
  const prefix = `${u.pathname.slice(1)}_${name}_`;
  const a = postgres(`${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`, { max: 1, onnotice: () => {} });
  try {
    const rows = await a<{ datname: string }[]>`select datname from pg_database where starts_with(datname, ${prefix})`;
    return rows.map((r) => r.datname);
  } finally {
    await a.end();
  }
}

test("subida que falha depois do banco, da migração e do Asaas falso: tudo é desfeito antes do erro chegar ao teste", async () => {
  // SECRET curto: o Next chega a escutar e o app cai na inicialização (ambiente inválido), com o banco já criado e
  // migrado e o Asaas falso no ar. A subida falha (na espera do "Ready" ou no /api/health, conforme a corrida).
  await expect(startMultiApp("falha", { extraEnv: { SECRET: "curto" } })).rejects.toThrow();
  const appLog = readFileSync(join(RUN_DIR, "multi-falha-app.log"), "utf8");
  expect(appLog).toContain("SECRET: deve ter no mínimo 32 caracteres");
  const appPort = Number(/Local:\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(appLog)?.[1]);
  expect(appPort).toBeGreaterThan(0);
  expect(await portClosed(appPort)).toBe(true);
  expect(await leftovers("falha")).toEqual([]);
  const fakeLog = readFileSync(join(RUN_DIR, "multi-falha-asaas-fake.log"), "utf8");
  const fakePort = Number(/asaas-fake ready on (\d+)/.exec(fakeLog)?.[1]);
  expect(fakePort).toBeGreaterThan(0);
  expect(await portClosed(fakePort)).toBe(true);
});

test("app vivo que nunca sinaliza prontidão: a subida falha no prazo próprio e o processo, a porta e o banco somem", async () => {
  // O padrão de prontidão nunca aparece: o Next sobe e fica vivo, escutando, sem o sinal que a subida espera.
  await expect(startMultiApp("trava", { appReadyPattern: /linha-que-nunca-aparece/, startTimeoutMs: 30_000 })).rejects.toThrow(
    /app multi não sinalizou prontidão em \d+ s/,
  );
  const appLog = readFileSync(join(RUN_DIR, "multi-trava-app.log"), "utf8");
  expect(appLog).toContain("Ready in"); // estava vivo e pronto de fato
  const appPort = Number(/Local:\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(appLog)?.[1]);
  expect(appPort).toBeGreaterThan(0);
  expect(await portClosed(appPort)).toBe(true);
  const fakePort = Number(/asaas-fake ready on (\d+)/.exec(readFileSync(join(RUN_DIR, "multi-trava-asaas-fake.log"), "utf8"))?.[1]);
  expect(await portClosed(fakePort)).toBe(true);
  expect(await leftovers("trava")).toEqual([]);
});

test("parada normal: a porta do app fecha, o banco some e parar de novo não faz nada", async () => {
  const multi = await startMultiApp("limpeza");
  let stopped = false;
  try {
    expect(await databaseExists(multi.dbName)).toBe(true);
    expect(await portClosed(multi.port)).toBe(false);
    expect((await fetch(`${multi.baseUrl}/api/health`)).status).toBe(200);
    await multi.stop();
    stopped = true;
    expect(await portClosed(multi.port)).toBe(true);
    expect(await portClosed(Number(new URL(multi.asaasBase).port))).toBe(true);
    expect(await databaseExists(multi.dbName)).toBe(false);
    await multi.stop();
  } finally {
    if (!stopped) await multi.stop();
  }
});
