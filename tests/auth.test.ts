import { eq, sql } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, login, loginOnPanelHost, lookupSession, verifyCredentials } from "@/lib/auth/session";
import { sha256 } from "@/lib/crypto";
import { loginAttempt, membership, session, users } from "@/lib/db/schema";
import { HEAVY_TEST_MS, createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const PASSWORD = "senha-correta-123";
let n = 0;

async function seedUser(storeId: string | null, role = "owner") {
  const email = `user${++n}@exemplo.com`;
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email, name: "Fulana", passwordHash: await hashPassword(PASSWORD) })
    .returning({ id: users.id });
  if (storeId) await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role });
  return { userId: u!.id, email };
}

const rejects = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ActionError);
  return e as ActionError;
};

describe("senha", () => {
  test("senha certa verifica, errada não", async () => {
    const h = await hashPassword(PASSWORD);
    expect(h.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword(PASSWORD, h)).toBe(true);
    expect(await verifyPassword("outra-senha-longa", h)).toBe(false);
  });

  test("hash tem sal próprio e hash malformado não verifica", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
    expect(await verifyPassword(PASSWORD, "lixo")).toBe(false);
    expect(await verifyPassword(PASSWORD, "scrypt$32768$8$1$x$y")).toBe(false);
  });

  test("mínimo de 10 caracteres", async () => {
    expect((await rejects(hashPassword("curta123"))).code).toBe("invalid_input");
  });
});

describe("sessão", () => {
  test("sessão válida devolve o ator com o papel atual; guarda só o hash do token", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId, "support");
    const token = await createSession(u.userId, storeId);
    expect(await lookupSession(token)).toEqual({ storeId, actor: { kind: "user", userId: u.userId, role: "support" }, mustChangePassword: false });
    const rows = await t.ownerDb.select().from(session).where(eq(session.idHash, sha256(token)));
    expect(rows).toHaveLength(1);
    expect(await lookupSession("token-inexistente")).toBeNull();
    // mudança de papel vale na hora
    await t.ownerDb.update(membership).set({ role: "admin" }).where(eq(membership.userId, u.userId));
    expect((await lookupSession(token))?.actor).toEqual({ kind: "user", userId: u.userId, role: "admin" });
  });

  test("sessão expirada → null", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const token = await createSession(u.userId, storeId);
    await t.ownerDb.update(session).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(session.idHash, sha256(token)));
    expect(await lookupSession(token)).toBeNull();
  });

  test("validade de 30 dias", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const token = await createSession(u.userId, storeId);
    const [row] = await t.ownerDb.select().from(session).where(eq(session.idHash, sha256(token)));
    const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
  });

  test("usuário sem membership na loja da sessão → null (membership apagada também)", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const u = await seedUser(a.storeId);
    // sessão forjada para a loja B sem vínculo
    const forged = await createSession(u.userId, b.storeId);
    expect(await lookupSession(forged)).toBeNull();
    const token = await createSession(u.userId, a.storeId);
    expect(await lookupSession(token)).not.toBeNull();
    await t.ownerDb.delete(membership).where(eq(membership.userId, u.userId));
    expect(await lookupSession(token)).toBeNull();
  });
});

describe("login", () => {
  test("credenciais certas criam sessão da loja", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const token = await login({ email: u.email.toUpperCase(), password: PASSWORD, storeId });
    expect((await lookupSession(token))?.actor).toMatchObject({ userId: u.userId });
  });

  test("e-mail desconhecido, senha errada e sem membership dão o mesmo erro", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const u = await seedUser(a.storeId);
    const errs = [
      await rejects(login({ email: "ninguem@exemplo.com", password: PASSWORD, storeId: a.storeId })),
      await rejects(login({ email: u.email, password: "senha-errada-123", storeId: a.storeId })),
      await rejects(login({ email: u.email, password: PASSWORD, storeId: b.storeId })),
    ];
    expect(new Set(errs.map((e) => `${e.code}|${e.message}`)).size).toBe(1);
  });

  test("6ª tentativa errada (e a certa depois) é bloqueada; mesmo erro genérico", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const generic = await rejects(login({ email: u.email, password: "errada-errada-1", storeId }));
    for (let i = 0; i < 4; i++) await rejects(login({ email: u.email, password: "errada-errada-1", storeId }));
    const locked = await rejects(login({ email: u.email, password: PASSWORD, storeId }));
    expect(`${locked.code}|${locked.message}`).toBe(`${generic.code}|${generic.message}`);
    // bloqueio não conta tentativas novas: continuam 5 registros
    const rows = await t.ownerDb.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256(u.email)));
    expect(rows).toHaveLength(5);
  }, HEAVY_TEST_MS);

  test("10 logins errados em paralelo: todos rejeitados e exatamente 5 tentativas gravadas; depois nem a senha certa entra", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => login({ email: u.email, password: "errada-errada-1", storeId })),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    const rows = await t.ownerDb.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256(u.email)));
    expect(rows).toHaveLength(5);
    await rejects(login({ email: u.email, password: PASSWORD, storeId }));
    // senha certa em paralelo com o bloqueio também não passa
    const par = await Promise.allSettled(Array.from({ length: 3 }, () => login({ email: u.email, password: PASSWORD, storeId })));
    expect(par.every((r) => r.status === "rejected")).toBe(true);
    await t.ownerDb.update(loginAttempt).set({ at: sql`now() - interval '16 minutes'` }).where(eq(loginAttempt.emailHash, sha256(u.email)));
    expect(await login({ email: u.email, password: PASSWORD, storeId })).toBeString();
  }, HEAVY_TEST_MS);

  test("o bloqueio vale também para e-mail inexistente e guarda só o hash do e-mail", async () => {
    const { storeId } = await seedStore();
    const email = "fantasma@exemplo.com";
    for (let i = 0; i < 5; i++) await rejects(login({ email, password: "errada-errada-1", storeId }));
    const rows = await t.ownerDb.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256(email)));
    expect(rows).toHaveLength(5);
    const all = JSON.stringify(await t.ownerDb.select().from(loginAttempt));
    expect(all).not.toContain("fantasma");
    // depois de 15 min do último erro o bloqueio acaba
    await t.ownerDb.update(loginAttempt).set({ at: sql`now() - interval '16 minutes'` }).where(eq(loginAttempt.emailHash, sha256(email)));
    const u = await seedUser(storeId);
    await t.ownerDb.update(users).set({ email }).where(eq(users.id, u.userId));
    expect(await login({ email, password: PASSWORD, storeId })).toBeString();
  }, HEAVY_TEST_MS);

  test("4 falhas + sucesso não bloqueiam e o sucesso zera o contador", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    for (let i = 0; i < 4; i++) await rejects(login({ email: u.email, password: "errada-errada-1", storeId }));
    await login({ email: u.email, password: PASSWORD, storeId });
    for (let i = 0; i < 4; i++) await rejects(login({ email: u.email, password: "errada-errada-1", storeId }));
    expect(await login({ email: u.email, password: PASSWORD, storeId })).toBeString();
  }, HEAVY_TEST_MS);
});

describe("loginOnPanelHost (host do painel da plataforma, MODE=multi)", () => {
  test("abre a sessão na primeira loja da pessoa por nome; o papel é o daquela loja", async () => {
    const zeta = await seedStore("Zeta");
    const alfa = await seedStore("Alfa");
    const u = await seedUser(zeta.storeId, "owner");
    await t.ownerDb.insert(membership).values({ userId: u.userId, storeId: alfa.storeId, role: "support" });
    const token = await loginOnPanelHost({ email: u.email.toUpperCase(), password: PASSWORD });
    expect(await lookupSession(token)).toMatchObject({ storeId: alfa.storeId, actor: { userId: u.userId, role: "support" } });
  });

  test("e-mail desconhecido, senha errada e conta sem loja dão o mesmo erro do login", async () => {
    const a = await seedStore();
    const u = await seedUser(a.storeId);
    const orphan = await seedUser(null);
    const errs = [
      await rejects(loginOnPanelHost({ email: "ninguem@exemplo.com", password: PASSWORD })),
      await rejects(loginOnPanelHost({ email: u.email, password: "senha-errada-123" })),
      await rejects(loginOnPanelHost({ email: orphan.email, password: PASSWORD })),
      await rejects(login({ email: u.email, password: "senha-errada-123", storeId: a.storeId })),
    ];
    expect(new Set(errs.map((e) => `${e.code}|${e.message}`)).size).toBe(1);
  });

  test("divide o bloqueio de 5 tentativas com o login da loja", async () => {
    const a = await seedStore();
    const u = await seedUser(a.storeId);
    for (let i = 0; i < 5; i++) await rejects(loginOnPanelHost({ email: u.email, password: "senha-errada-123" }));
    await rejects(loginOnPanelHost({ email: u.email, password: PASSWORD }));
    await rejects(login({ email: u.email, password: PASSWORD, storeId: a.storeId }));
  }, HEAVY_TEST_MS);
});

describe("verifyCredentials (o mesmo caminho do login)", () => {
  test("senha certa devolve o usuário mesmo sem vínculo; errada e e-mail desconhecido devolvem null", async () => {
    const u = await seedUser(null);
    expect(await verifyCredentials(u.email.toUpperCase(), PASSWORD)).toEqual({ userId: u.userId });
    expect(await verifyCredentials(u.email, "senha-errada-123")).toBeNull();
    expect(await verifyCredentials("ninguem-aqui@exemplo.com", PASSWORD)).toBeNull();
    expect(await verifyCredentials(`${"a".repeat(250)}@exemplo.com`, PASSWORD)).toBeNull();
    expect(await verifyCredentials(u.email, "x".repeat(257))).toBeNull();
  }, HEAVY_TEST_MS);

  test("divide o bloqueio com o login: 5 erros pela verificação bloqueiam o login, e vice-versa", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId);
    for (let i = 0; i < 5; i++) expect(await verifyCredentials(a.email, "errada-errada-1")).toBeNull();
    await rejects(login({ email: a.email, password: PASSWORD, storeId }));
    const b = await seedUser(storeId);
    for (let i = 0; i < 5; i++) await rejects(login({ email: b.email, password: "errada-errada-1", storeId }));
    expect(await verifyCredentials(b.email, PASSWORD)).toBeNull();
    const rows = await t.ownerDb.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256(b.email)));
    expect(rows).toHaveLength(5);
    await t.ownerDb.update(loginAttempt).set({ at: sql`now() - interval '16 minutes'` }).where(eq(loginAttempt.emailHash, sha256(b.email)));
    expect(await verifyCredentials(b.email, PASSWORD)).toEqual({ userId: b.userId });
  }, HEAVY_TEST_MS);
});

describe("limites de tamanho do login", () => {
  test("e-mail > 254 e senha > 256 são recusados antes de qualquer trabalho (sem tentativa gravada)", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const before = (await t.ownerDb.select().from(loginAttempt)).length;
    const errs = [
      await rejects(login({ email: `${"a".repeat(250)}@exemplo.com`, password: PASSWORD, storeId })),
      await rejects(login({ email: u.email, password: "x".repeat(257), storeId })),
      await rejects(login({ email: u.email, password: "x".repeat(1_000_000), storeId })),
    ];
    expect(new Set(errs.map((e) => `${e.code}|${e.message}`)).size).toBe(1);
    expect((await t.ownerDb.select().from(loginAttempt)).length).toBe(before);
  });

  test("no limite (senha de 256) segue o fluxo normal e grava a tentativa", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    await rejects(login({ email: u.email, password: "x".repeat(256), storeId }));
    const rows = await t.ownerDb.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256(u.email)));
    expect(rows).toHaveLength(1);
  });
});
