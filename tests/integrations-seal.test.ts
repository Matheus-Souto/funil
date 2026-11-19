import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { integration } from "@/lib/db/schema";
import { env, parseEnv, requireSecret } from "@/lib/env";
import { createIntegrationSecrets, getIntegration, openIntegrationSecret, resealAsaasSecrets, saveIntegration } from "@/lib/integrations";
import { createTestDb, seedStore, type TestDb } from "./db";

const ASAAS_KEY = "k".repeat(40);
const SECRET = "s".repeat(40);

describe("createIntegrationSecrets: regra de selagem por tipo", () => {
  test("com ASAAS_SEAL_KEY, asaas vai em a1 e as demais em v1; cada uma abre de volta", () => {
    const s = createIntegrationSecrets({ secret: SECRET, asaasKey: ASAAS_KEY });
    const asaas = s.seal("asaas", "chave-asaas");
    expect(asaas.startsWith("a1.")).toBe(true);
    expect(s.open("asaas", asaas)).toBe("chave-asaas");
    for (const kind of ["smtp", "meta", "pix_manual"] as const) {
      const sealed = s.seal(kind, "senha");
      expect(sealed.startsWith("v1.")).toBe(true);
      expect(s.open(kind, sealed)).toBe("senha");
    }
  });

  test("sem ASAAS_SEAL_KEY, asaas segue em v1 (SECRET)", () => {
    const s = createIntegrationSecrets({ secret: SECRET });
    const sealed = s.seal("asaas", "chave-asaas");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(s.open("asaas", sealed)).toBe("chave-asaas");
  });

  test("a1 só abre para o tipo asaas (SMTP e Meta nunca com a chave do Asaas)", () => {
    const s = createIntegrationSecrets({ secret: SECRET, asaasKey: ASAAS_KEY });
    const sealed = s.seal("asaas", "x");
    for (const kind of ["smtp", "meta", "pix_manual"]) expect(() => s.open(kind, sealed)).toThrow();
  });

  test("openIntegrationSecret (env do processo) recusa a1 fora do asaas e prefixo desconhecido", () => {
    const sealed = createIntegrationSecrets({ asaasKey: ASAAS_KEY }).seal("asaas", "x");
    expect(() => openIntegrationSecret("smtp", sealed)).toThrow();
    expect(() => openIntegrationSecret("asaas", "z9.a.b.c")).toThrow("Valor selado inválido");
    expect(() => openIntegrationSecret("asaas", "lixo")).toThrow("Valor selado inválido");
  });

  test("com o env do serviço de cartão (SERVICE=card, sem SECRET): abre a1 e não abre v1", () => {
    const card = parseEnv({
      SERVICE: "card",
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://card:card@localhost:5433/funil",
      CARD_ORIGIN: "http://127.0.0.1:3100",
      CARD_TICKET_KEY: "t".repeat(40),
      ASAAS_SEAL_KEY: ASAAS_KEY,
    });
    expect(card.SECRET).toBeUndefined();
    const app = createIntegrationSecrets({ secret: SECRET, asaasKey: ASAAS_KEY });
    const inCard = createIntegrationSecrets({ secret: card.SECRET, asaasKey: card.ASAAS_SEAL_KEY });
    expect(inCard.open("asaas", app.seal("asaas", "chave-asaas"))).toBe("chave-asaas");
    expect(() => inCard.open("smtp", app.seal("smtp", "senha"))).toThrow("SECRET não definido");
    expect(() => inCard.open("asaas", createIntegrationSecrets({ secret: SECRET }).seal("asaas", "x"))).toThrow("SECRET não definido");
    // Gravar algo que não seja asaas também exige o SECRET.
    expect(() => inCard.seal("smtp", "x")).toThrow("SECRET não definido");
  });
});

describe("resealAsaasSecrets", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.drop();
  });

  const rawSecret = (storeId: string, kind: "asaas" | "smtp") =>
    withStore(storeId, async (tx) => {
      const [row] = await tx
        .select({ secret: integration.secret })
        .from(integration)
        .where(and(eq(integration.storeId, storeId), eq(integration.kind, kind)));
      return row?.secret ?? null;
    });

  test("converte asaas v1 em a1, não toca em smtp e é idempotente", async () => {
    // O env dos testes não tem ASAAS_SEAL_KEY: saveIntegration grava tudo em v1 (como as conexões antigas).
    expect(env.ASAAS_SEAL_KEY).toBeUndefined();
    const a = await seedStore();
    const b = await seedStore();
    const vazia = await seedStore();
    for (const s of [a, b]) {
      await withStore(s.storeId, (tx) => saveIntegration(tx, s.storeId, "asaas", { env: "sandbox" }, `chave-${s.storeId}`));
      await withStore(s.storeId, (tx) => saveIntegration(tx, s.storeId, "smtp", { host: "h" }, "senha-smtp"));
    }
    await withStore(vazia.storeId, (tx) => saveIntegration(tx, vazia.storeId, "asaas", { env: "sandbox" }, null));
    const smtpAntes = await rawSecret(a.storeId, "smtp");
    expect((await rawSecret(a.storeId, "asaas"))!.startsWith("v1.")).toBe(true);

    const secrets = createIntegrationSecrets({ secret: requireSecret(), asaasKey: ASAAS_KEY });
    expect(await resealAsaasSecrets(secrets)).toBe(2);

    for (const s of [a, b]) {
      const sealed = (await rawSecret(s.storeId, "asaas"))!;
      expect(sealed.startsWith("a1.")).toBe(true);
      expect(secrets.open("asaas", sealed)).toBe(`chave-${s.storeId}`);
      // O serviço de cartão (sem SECRET) abre o resultado.
      expect(createIntegrationSecrets({ asaasKey: ASAAS_KEY }).open("asaas", sealed)).toBe(`chave-${s.storeId}`);
    }
    expect(await rawSecret(a.storeId, "smtp")).toBe(smtpAntes);
    expect(await rawSecret(vazia.storeId, "asaas")).toBeNull();
    expect(await resealAsaasSecrets(secrets)).toBe(0);
  });

  test("erro numa loja não impede as demais; o log não leva o segredo", async () => {
    const ok = await seedStore();
    const ruim = await seedStore();
    await withStore(ok.storeId, (tx) => saveIntegration(tx, ok.storeId, "asaas", {}, "chave-boa-123"));
    // Selado com outro SECRET: o app não consegue abrir (auth tag não confere).
    const alheio = createIntegrationSecrets({ secret: "o".repeat(40) }).seal("asaas", "chave-alheia-456");
    await t.ownerDb.insert(integration).values({ storeId: ruim.storeId, kind: "asaas", config: {}, secret: alheio });

    const lines: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    let error: unknown;
    try {
      await resealAsaasSecrets(createIntegrationSecrets({ secret: requireSecret(), asaasKey: ASAAS_KEY })).catch((e: unknown) => {
        error = e;
      });
    } finally {
      out.mockRestore();
    }
    expect(String(error)).toMatch(/falhou em 1 loja\(s\); 1 re-selada/);
    expect((await rawSecret(ok.storeId, "asaas"))!.startsWith("a1.")).toBe(true);
    expect(await rawSecret(ruim.storeId, "asaas")).toBe(alheio);
    const logged = lines.join("");
    expect(logged).toContain(ruim.storeId);
    for (const v of [alheio, "chave-alheia-456", "chave-boa-123"]) expect(logged).not.toContain(v);
  });

  test("sem ASAAS_SEAL_KEY não muda nada", async () => {
    const s = await seedStore();
    await withStore(s.storeId, (tx) => saveIntegration(tx, s.storeId, "asaas", {}, "chave"));
    const antes = await rawSecret(s.storeId, "asaas");
    expect(await resealAsaasSecrets(createIntegrationSecrets({ secret: requireSecret() }))).toBe(0);
    expect(await resealAsaasSecrets()).toBe(0);
    expect(await rawSecret(s.storeId, "asaas")).toBe(antes);
    expect(await withStore(s.storeId, (tx) => getIntegration(tx, s.storeId, "asaas"))).toEqual({ config: {}, secret: "chave" });
  });
});
