import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { GET } from "@/app/api/health/route";
import { setDbForTests } from "@/lib/db/client";
import { register } from "@/instrumentation";
import { createTestDb, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

test("health responde ok com o banco acessível pelo papel app", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("health responde 503 quando o papel app não consegue falar com o banco", async () => {
  const bad = new URL(t.url);
  bad.username = "app";
  bad.password = "senha-errada";
  await setDbForTests({ appUrl: bad.toString(), ownerUrl: t.url });
  try {
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  } finally {
    // Volta ao banco do arquivo (createTestDb apontou db/ownerDb para ele).
    const app = new URL(t.url);
    app.username = "app";
    app.password = process.env.APP_DB_PASSWORD ?? "app";
    await setDbForTests({ appUrl: app.toString(), ownerUrl: t.url });
  }
});

/** Roda `register()` com o ambiente trocado; process.exit vira exceção (o processo de teste segue vivo). */
async function registerWith(env: Record<string, string | undefined>): Promise<{ exitCode: number | null; stderr: string }> {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let exitCode: number | null = null;
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("process.exit");
  }) as never);
  const lines: string[] = [];
  const err = spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  try {
    await register().catch((e: unknown) => {
      if (!(e instanceof Error && e.message === "process.exit")) throw e;
    });
  } finally {
    exit.mockRestore();
    err.mockRestore();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  return { exitCode, stderr: lines.join("\n") };
}

test("subida do servidor com env inválido: sai com código 1 e mensagem clara", async () => {
  const r = await registerWith({ NEXT_RUNTIME: "nodejs", NEXT_PHASE: undefined, SECRET: "curto" });
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("SECRET");
  expect(r.stderr).toMatch(/Variáveis de ambiente inválidas/);
});

test("durante o build (ou fora do Node) o env não é conferido", async () => {
  expect((await registerWith({ NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build", SECRET: "curto" })).exitCode).toBeNull();
  expect((await registerWith({ NEXT_RUNTIME: "edge", SECRET: "curto" })).exitCode).toBeNull();
});
