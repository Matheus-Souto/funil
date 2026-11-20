import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { register } from "@/instrumentation";
import { withStore } from "@/lib/db/client";
import { integration } from "@/lib/db/schema";
import { requireSecret } from "@/lib/env";
import { checkAsaasSealKey, createIntegrationSecrets, prepareAsaasSealOnBoot, saveIntegration } from "@/lib/integrations";
import { createTestDb, seedStore, type TestDb } from "./db";

// Banco próprio: as contagens de checkAsaasSealKey são sobre todas as lojas.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const KEY = "k".repeat(40);
const withKey = () => createIntegrationSecrets({ secret: requireSecret(), asaasKey: KEY });

const rawAsaas = (storeId: string) =>
  withStore(storeId, async (tx) => {
    const [row] = await tx
      .select({ secret: integration.secret })
      .from(integration)
      .where(and(eq(integration.storeId, storeId), eq(integration.kind, "asaas")));
    return row?.secret ?? null;
  });

/** Grava a conexão asaas já em a1 (como o app com a ASAAS_SEAL_KEY gravaria). */
async function seedA1(plain: string): Promise<string> {
  const { storeId } = await seedStore();
  await t.ownerDb.insert(integration).values({ storeId, kind: "asaas", config: { env: "sandbox" }, secret: withKey().seal("asaas", plain) });
  return storeId;
}

test("checkAsaasSealKey conta as conexões asaas em a1, quantas a chave não abre e quantas seguem em v1 (outros tipos não contam)", async () => {
  await seedA1("chave-1");
  await seedA1("chave-2");
  const v1 = await seedStore();
  await withStore(v1.storeId, (tx) => saveIntegration(tx, v1.storeId, "asaas", {}, "chave-v1"));
  await withStore(v1.storeId, (tx) => saveIntegration(tx, v1.storeId, "smtp", { host: "h" }, "senha"));

  expect(await checkAsaasSealKey(withKey())).toEqual({ sealed: 2, unreadable: 0, legacy: 1 });
  expect(await checkAsaasSealKey(createIntegrationSecrets({ secret: requireSecret(), asaasKey: "o".repeat(40) }))).toEqual({ sealed: 2, unreadable: 2, legacy: 1 });
  expect(await checkAsaasSealKey(createIntegrationSecrets({ secret: requireSecret() }))).toEqual({ sealed: 2, unreadable: 2, legacy: 1 });
  // Env dos testes: sem ASAAS_SEAL_KEY.
  expect(await checkAsaasSealKey()).toEqual({ sealed: 2, unreadable: 2, legacy: 1 });
});

test("boot: a re-selagem roda sempre que há ASAAS_SEAL_KEY (sem flag); sem a chave, nada muda; a checagem roda sempre", async () => {
  const { storeId } = await seedStore();
  await withStore(storeId, (tx) => saveIntegration(tx, storeId, "asaas", {}, "chave-antiga"));
  const antes = (await rawAsaas(storeId))!;
  expect(antes.startsWith("v1.")).toBe(true);

  // Sem a chave (instalação ainda sem o serviço de cartão): não re-sela.
  expect(await prepareAsaasSealOnBoot(createIntegrationSecrets({ secret: requireSecret() }))).toEqual({ resealed: 0, sealed: 2, unreadable: 2, legacy: 2 });
  expect(await rawAsaas(storeId)).toBe(antes);

  // Com a chave: re-sela esta e a v1 do teste anterior.
  expect(await prepareAsaasSealOnBoot(withKey())).toEqual({ resealed: 2, sealed: 4, unreadable: 0, legacy: 0 });
  expect((await rawAsaas(storeId))!.startsWith("a1.")).toBe(true);
  expect(await prepareAsaasSealOnBoot(withKey())).toEqual({ resealed: 0, sealed: 4, unreadable: 0, legacy: 0 });
});

test("register(): conexão asaas em a1 que a chave do processo não abre derruba a subida, sem valores na mensagem", async () => {
  const saved = { ...process.env };
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
  let exitCode = null as number | null;
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
  expect(exitCode).toBe(1);
  const stderr = lines.join("\n");
  expect(stderr).toContain("ASAAS_SEAL_KEY ausente ou diferente da que selou a conexão Asaas de 4 loja(s); restaure a chave correta");
  expect(stderr).not.toContain(KEY);
  expect(stderr).not.toMatch(/a1\.[A-Za-z0-9_-]{8,}/);
});
