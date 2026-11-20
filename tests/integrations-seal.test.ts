import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { integration } from "@/lib/db/schema";
import { env, parseEnv, requireSecret } from "@/lib/env";
import {
  createIntegrationSecrets,
  getIntegration,
  integrationSecretsFor,
  type IntegrationSecrets,
  openIntegrationSecret,
  resealAsaasSecrets,
  unsealAsaasSecrets,
  saveIntegration,
} from "@/lib/integrations";
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
    for (const kind of ["smtp", "meta", "pix_manual"]) expect(() => s.open(kind, sealed)).toThrow(`não abre a conexão ${kind}`);
  });

  test("openIntegrationSecret (env do processo) recusa a1 fora do asaas e prefixo desconhecido", () => {
    const sealed = createIntegrationSecrets({ asaasKey: ASAAS_KEY }).seal("asaas", "x");
    expect(() => openIntegrationSecret("smtp", sealed)).toThrow("não abre a conexão smtp");
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

describe("integrationSecretsFor: a1 só com CARD_ISOLATED=1 (rollback para a imagem anterior continua abrindo a conexão)", () => {
  const base = { BASE_URL: "https://loja.example.com", DATABASE_URL: "postgres://app:x@localhost/funil", SECRET, ASAAS_SEAL_KEY: ASAAS_KEY };

  test("com a ASAAS_SEAL_KEY definida e CARD_ISOLATED=0: asaas grava em v1, mas um a1 já gravado continua abrindo", () => {
    const off = integrationSecretsFor(parseEnv(base));
    const sealed = off.seal("asaas", "chave-asaas");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(off.open("asaas", sealed)).toBe("chave-asaas");
    expect(off.asaasOwnKey).toBe(false);
    const a1 = createIntegrationSecrets({ secret: SECRET, asaasKey: ASAAS_KEY }).seal("asaas", "da-epoca-isolada");
    expect(off.open("asaas", a1)).toBe("da-epoca-isolada");
  });

  test("com CARD_ISOLATED=1: asaas grava em a1 (o serviço de cartão abre sem o SECRET)", () => {
    const on = integrationSecretsFor(parseEnv({ ...base, CARD_ISOLATED: "1", CARD_ORIGIN: "https://pagar.example.com", CARD_TICKET_KEY: "t".repeat(40) }));
    const sealed = on.seal("asaas", "chave-asaas");
    expect(sealed.startsWith("a1.")).toBe(true);
    expect(on.asaasOwnKey).toBe(true);
    expect(createIntegrationSecrets({ asaasKey: ASAAS_KEY }).open("asaas", sealed)).toBe("chave-asaas");
  });

  test("sem a selagem própria, a re-selagem não mexe em nada", () => {
    const off = createIntegrationSecrets({ secret: SECRET, asaasKey: ASAAS_KEY, sealAsaas: false });
    expect(off.asaasOwnKey).toBe(false);
    expect(off.seal("asaas", "x").startsWith("v1.")).toBe(true);
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

  test("UPDATE da re-selagem falhando (erro de consulta do drizzle): nenhum dos dois selos vai para o log", async () => {
    const s = await seedStore();
    await withStore(s.storeId, (tx) => saveIntegration(tx, s.storeId, "asaas", {}, "chave-update-789"));
    const antigo = (await rawSecret(s.storeId, "asaas"))!;
    const real = createIntegrationSecrets({ secret: requireSecret(), asaasKey: ASAAS_KEY });
    let novo = "";
    // NUL no texto: o Postgres recusa (22021) e o drizzle lança DrizzleQueryError com `params` = [novo, ..., antigo].
    const quebrado: IntegrationSecrets = {
      asaasOwnKey: true,
      open: (kind, sealed) => real.open(kind, sealed),
      seal: (kind, plain) => (novo = real.seal(kind, plain)) + "\u0000",
    };

    const lines: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    let error: unknown;
    try {
      await resealAsaasSecrets(quebrado).catch((e: unknown) => {
        error = e;
      });
    } finally {
      out.mockRestore();
    }
    expect(String(error)).toMatch(/falhou em \d+ loja/);
    expect(novo.startsWith("a1.")).toBe(true);
    const logged = lines.join("");
    expect(logged).toContain(s.storeId);
    expect(logged).toContain("falha na consulta ao banco");
    for (const v of [antigo, novo, antigo.split(".")[3]!, novo.split(".")[3]!, "chave-update-789"]) expect(logged).not.toContain(v);
    expect(await rawSecret(s.storeId, "asaas")).toBe(antigo);
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

describe("unsealAsaasSecrets (CLI asaas:unseal, rollback do isolamento)", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.drop();
  });

  const rawSecret = (storeId: string) =>
    withStore(storeId, async (tx) => {
      const [row] = await tx.select({ secret: integration.secret }).from(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, "asaas")));
      return row?.secret ?? null;
    });
  const sealedA1 = createIntegrationSecrets({ secret: requireSecret(), asaasKey: ASAAS_KEY });

  test("regrava a1 -> v1 por loja (abre só com o SECRET, como na imagem anterior), não toca no resto e é idempotente", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const antiga = await seedStore();
    const vazia = await seedStore();
    for (const s of [a, b]) {
      await t.ownerDb.insert(integration).values({ storeId: s.storeId, kind: "asaas", config: {}, secret: sealedA1.seal("asaas", `chave-${s.storeId}`) });
      await withStore(s.storeId, (tx) => saveIntegration(tx, s.storeId, "smtp", { host: "h" }, "senha-smtp"));
    }
    await withStore(antiga.storeId, (tx) => saveIntegration(tx, antiga.storeId, "asaas", {}, "chave-v1"));
    await withStore(vazia.storeId, (tx) => saveIntegration(tx, vazia.storeId, "asaas", {}, null));
    const v1Antes = await rawSecret(antiga.storeId);

    expect(await unsealAsaasSecrets({ secret: requireSecret(), asaasKey: ASAAS_KEY })).toEqual({ unsealed: 2, remaining: 0 });
    const semChave = createIntegrationSecrets({ secret: requireSecret() }); // imagem anterior: só SECRET, sem a1
    for (const s of [a, b]) {
      const sealed = (await rawSecret(s.storeId))!;
      expect(sealed.startsWith("v1.")).toBe(true);
      expect(semChave.open("asaas", sealed)).toBe(`chave-${s.storeId}`);
    }
    expect(await rawSecret(antiga.storeId)).toBe(v1Antes);
    expect(await rawSecret(vazia.storeId)).toBeNull();
    expect(await unsealAsaasSecrets({ secret: requireSecret(), asaasKey: ASAAS_KEY })).toEqual({ unsealed: 0, remaining: 0 });
  });

  test("precisa do SECRET e da ASAAS_SEAL_KEY", async () => {
    await expect(unsealAsaasSecrets({ secret: requireSecret() })).rejects.toThrow(/ASAAS_SEAL_KEY/);
    await expect(unsealAsaasSecrets({ asaasKey: ASAAS_KEY })).rejects.toThrow(/SECRET/);
  });

  test("a1 que não abre com a chave: conta como restante, segue as demais e o log não leva valores", async () => {
    const ok = await seedStore();
    const ruim = await seedStore();
    await t.ownerDb.insert(integration).values({ storeId: ok.storeId, kind: "asaas", config: {}, secret: sealedA1.seal("asaas", "chave-boa-123") });
    const alheio = createIntegrationSecrets({ secret: requireSecret(), asaasKey: "x".repeat(40) }).seal("asaas", "chave-alheia-456");
    await t.ownerDb.insert(integration).values({ storeId: ruim.storeId, kind: "asaas", config: {}, secret: alheio });

    const lines: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    let r: unknown;
    try {
      r = await unsealAsaasSecrets({ secret: requireSecret(), asaasKey: ASAAS_KEY });
    } finally {
      out.mockRestore();
    }
    expect(r).toEqual({ unsealed: 1, remaining: 1 });
    expect((await rawSecret(ok.storeId))!.startsWith("v1.")).toBe(true);
    expect(await rawSecret(ruim.storeId)).toBe(alheio);
    const logged = lines.join("");
    expect(logged).toContain(ruim.storeId);
    for (const v of [alheio, "chave-alheia-456", "chave-boa-123", ASAAS_KEY]) expect(logged).not.toContain(v);
  });
});
