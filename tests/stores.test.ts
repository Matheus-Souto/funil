import { eq } from "drizzle-orm";
import { ActionError } from "@/lib/actions/core";
import { verifyPassword } from "@/lib/auth/password";
import { membership, store, users } from "@/lib/db/schema";
import { createStoreWithOwner, resolveStore, setupFirstRun } from "@/lib/stores";
import { createTestDb, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.ownerDb.delete(users);
  await t.ownerDb.delete(store);
});

const setup = { storeName: "Minha Loja", email: "Dona@Exemplo.com", password: "senha-longa-123", name: "Dona" };
const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as ActionError).code;

describe("setupFirstRun", () => {
  test("cria loja e dono (e-mail normalizado, senha com hash)", async () => {
    const r = await setupFirstRun(setup, "single");
    const [u] = await t.ownerDb.select().from(users).where(eq(users.id, r.userId));
    expect(u!.email).toBe("dona@exemplo.com");
    expect(u!.passwordHash).not.toContain("senha-longa");
    expect(await verifyPassword(setup.password, u!.passwordHash)).toBe(true);
    const [m] = await t.ownerDb.select().from(membership).where(eq(membership.userId, r.userId));
    expect(m).toMatchObject({ storeId: r.storeId, role: "owner" });
    expect((await t.ownerDb.select().from(store))[0]).toMatchObject({ id: r.storeId, name: "Minha Loja", slug: "minha-loja" });
  });

  test("segunda vez → conflict", async () => {
    await setupFirstRun(setup, "single");
    expect(await code(setupFirstRun({ ...setup, email: "outra@exemplo.com" }, "single"))).toBe("conflict");
  });

  test("duas chamadas simultâneas: exatamente uma vence", async () => {
    const results = await Promise.allSettled([
      setupFirstRun({ ...setup, email: "a@exemplo.com" }, "single"),
      setupFirstRun({ ...setup, email: "b@exemplo.com" }, "single"),
      setupFirstRun({ ...setup, email: "c@exemplo.com" }, "single"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as ActionError).code).toBe("conflict");
    expect(await t.ownerDb.select().from(users)).toHaveLength(1);
    expect(await t.ownerDb.select().from(store)).toHaveLength(1);
  });

  test("fora do modo single → forbidden; senha curta → invalid_input", async () => {
    expect(await code(setupFirstRun(setup, "multi"))).toBe("forbidden");
    expect(await code(setupFirstRun({ ...setup, password: "curta" }, "single"))).toBe("invalid_input");
    expect(await t.ownerDb.select().from(users)).toHaveLength(0);
  });
});

describe("limites de tamanho do setup", () => {
  test("e-mail > 254, senha > 256, nomes > 100 → invalid_input sem criar nada", async () => {
    const cases = [
      { ...setup, email: `${"a".repeat(250)}@x.com` },
      { ...setup, password: "x".repeat(257) },
      { ...setup, name: "n".repeat(101) },
      { ...setup, storeName: "l".repeat(101) },
    ];
    for (const c of cases) expect(await code(setupFirstRun(c, "single"))).toBe("invalid_input");
    expect(await t.ownerDb.select().from(users)).toHaveLength(0);
  });

  test("nos limites (nomes 100, senha 256) passa", async () => {
    const r = await setupFirstRun({ ...setup, name: "n".repeat(100), storeName: "l".repeat(100), password: "x".repeat(256) }, "single");
    expect(r.userId).toBeString();
  });
});

describe("resolveStore", () => {
  async function seed() {
    const [a] = await t.ownerDb.insert(store).values({ name: "A", slug: "alfa", domain: "loja-a.com.br" }).returning();
    const [b] = await t.ownerDb.insert(store).values({ name: "B", slug: "beta" }).returning();
    return { a: a!, b: b! };
  }

  test("single: a única loja, qualquer host", async () => {
    const [a] = await t.ownerDb.insert(store).values({ name: "A", slug: "alfa" }).returning();
    expect(await resolveStore("qualquer.com:3000", { mode: "single" })).toEqual({ id: a!.id, slug: "alfa", name: "A" });
  });

  test("single sem loja → null", async () => {
    expect(await resolveStore("x.com", { mode: "single" })).toBeNull();
  });

  test("multi: por domínio (minúsculas, sem porta) e por subdomínio", async () => {
    const { a, b } = await seed();
    const o = { mode: "multi", platformDomain: "plataforma.com" } as const;
    expect((await resolveStore("LOJA-A.com.br:443", o))?.id).toBe(a.id);
    expect((await resolveStore("beta.plataforma.com", o))?.id).toBe(b.id);
    expect((await resolveStore("Beta.Plataforma.com:3000", o))?.id).toBe(b.id);
  });

  test("multi: host desconhecido → null (inclui domínio base, sub-sub e slug inexistente)", async () => {
    await seed();
    const o = { mode: "multi", platformDomain: "plataforma.com" } as const;
    for (const h of ["outra.com", "plataforma.com", "gama.plataforma.com", "x.beta.plataforma.com", "", "evilplataforma.com"]) {
      expect(await resolveStore(h, o)).toBeNull();
    }
    expect(await resolveStore("beta.plataforma.com", { mode: "multi" })).toBeNull();
  });
});

describe("createStoreWithOwner (CLI)", () => {
  test("cria loja e dono novo com senha temporária", async () => {
    const r = await createStoreWithOwner({ name: "Nova", slug: "nova", ownerEmail: "Dono@Exemplo.com", domain: "Nova.com.br" });
    expect(r.temporaryPassword).toBeString();
    const [u] = await t.ownerDb.select().from(users).where(eq(users.id, r.userId));
    expect(u!.email).toBe("dono@exemplo.com");
    expect(await verifyPassword(r.temporaryPassword!, u!.passwordHash)).toBe(true);
    expect((await t.ownerDb.select().from(store).where(eq(store.id, r.storeId)))[0]!.domain).toBe("nova.com.br");
    expect((await t.ownerDb.select().from(membership))[0]).toMatchObject({ storeId: r.storeId, role: "owner" });
  });

  test("usuário existente é vinculado, sem senha nova", async () => {
    const a = await createStoreWithOwner({ name: "A", slug: "a-loja", ownerEmail: "dono@exemplo.com" });
    const b = await createStoreWithOwner({ name: "B", slug: "b-loja", ownerEmail: "dono@exemplo.com" });
    expect(b.userId).toBe(a.userId);
    expect(b.temporaryPassword).toBeNull();
    expect(await t.ownerDb.select().from(membership)).toHaveLength(2);
  });

  test("slug inválido ou repetido → erro e nada é criado", async () => {
    expect(await code(createStoreWithOwner({ name: "X", slug: "Slug Ruim", ownerEmail: "x@exemplo.com" }))).toBe("invalid_input");
    await createStoreWithOwner({ name: "A", slug: "dup", ownerEmail: "a@exemplo.com" });
    expect(await code(createStoreWithOwner({ name: "B", slug: "dup", ownerEmail: "b@exemplo.com" }))).toBe("conflict");
    expect(await t.ownerDb.select().from(users)).toHaveLength(1);
  });
});
