import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { hashPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { membership, users } from "@/lib/db/schema";
import { createTestDb, seedStore, type TestDb } from "./db";

// Jar controlável no lugar de `cookies()` (que só existe dentro de uma requisição do Next).
const jar = new Map<string, string>();
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: () => undefined,
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));

const { requirePanelActor } = await import("@/lib/auth/session");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(() => jar.clear());

const PANEL_DIR = join(import.meta.dir, "..", "src", "app", "admin", "(panel)");
const files = [...new Glob("**/*.{ts,tsx}").scanSync(PANEL_DIR)].sort();

/** Chama `fn` e devolve o destino do redirect do Next (ou null se não redirecionou). */
async function redirectTarget(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "?";
    throw e;
  }
}

describe("requirePanelActor", () => {
  test("sem cookie ou com cookie inválido redireciona para /admin/login", async () => {
    expect(await redirectTarget(() => requirePanelActor())).toBe("/admin/login");
    jar.set(SESSION_COOKIE, "token-que-nao-existe");
    expect(await redirectTarget(() => requirePanelActor())).toBe("/admin/login");
  });

  test("com sessão válida devolve { storeId, actor }", async () => {
    const { storeId } = await seedStore();
    const [u] = await t.ownerDb
      .insert(users)
      .values({ email: "painel@exemplo.com", name: "P", passwordHash: await hashPassword("senha-correta-123") })
      .returning({ id: users.id });
    await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role: "admin" });
    jar.set(SESSION_COOKIE, await createSession(u!.id, storeId));
    expect(await requirePanelActor()).toEqual({ storeId, actor: { kind: "user", userId: u!.id, role: "admin" }, mustChangePassword: false });
  });

  test("senha temporária: toda página/ação vai para a troca de senha; só a tela de troca passa", async () => {
    const { storeId } = await seedStore();
    const [u] = await t.ownerDb
      .insert(users)
      .values({ email: "temporaria@exemplo.com", name: "T", passwordHash: await hashPassword("senha-correta-123"), mustChangePassword: true })
      .returning({ id: users.id });
    await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role: "owner" });
    jar.set(SESSION_COOKIE, await createSession(u!.id, storeId));
    expect(await redirectTarget(() => requirePanelActor())).toBe("/admin/senha");
    expect(await requirePanelActor({ allowPasswordChange: true })).toMatchObject({ storeId, mustChangePassword: true });
  });

  test("a tela de troca de senha exige sessão", async () => {
    const mod = (await import(join(import.meta.dir, "..", "src", "app", "admin", "senha", "page.tsx"))) as { default: (p: unknown) => unknown };
    expect(await redirectTarget(() => mod.default({ searchParams: Promise.resolve({}) }))).toBe("/admin/login");
  });
});

describe("painel exige sessão em cada página e server action", () => {
  test("há arquivos no painel (a varredura não está vazia)", () => {
    expect(files.some((f) => f.endsWith("page.tsx"))).toBe(true);
    expect(files.some((f) => /actions\.ts$/.test(f))).toBe(true);
  });

  for (const f of files.filter((x) => /(^|\/)page\.tsx$/.test(x))) {
    test(`página ${f} redireciona sem sessão (sem depender do layout)`, async () => {
      const mod = (await import(join(PANEL_DIR, f))) as { default: (p: unknown) => unknown };
      const props = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };
      expect(await redirectTarget(() => mod.default(props))).toBe("/admin/login");
    });
  }

  for (const f of files.filter((x) => /\.tsx?$/.test(x) && /^\s*["']use server["']/m.test(readFileSync(join(PANEL_DIR, x), "utf8")))) {
    test(`toda server action exportada de ${relative(PANEL_DIR, join(PANEL_DIR, f))} recusa sem sessão`, async () => {
      const mod = (await import(join(PANEL_DIR, f))) as Record<string, unknown>;
      const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
      expect(fns.length).toBeGreaterThan(0);
      for (const [name, fn] of fns) {
        const target = await redirectTarget(() => (fn as (...a: unknown[]) => unknown)(new FormData()));
        expect(target, `${name} não recusou sem sessão`).toBe("/admin/login");
      }
    });
  }
});

describe("rotas do painel exigem sessão", () => {
  const API_DIR = join(import.meta.dir, "..", "src", "app", "admin", "api");
  const routes = [...new Glob("**/route.ts").scanSync(API_DIR)].sort();

  test("há rotas na varredura", () => {
    expect(routes).toContain("products/upload/route.ts");
  });

  for (const f of routes) {
    test(`${f}: cada método HTTP redireciona sem sessão e antes de ler o corpo`, async () => {
      const mod = (await import(join(API_DIR, f))) as Record<string, unknown>;
      const methods = Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k));
      expect(methods.length).toBeGreaterThan(0);
      for (const m of methods) {
        let read = false;
        const body = new ReadableStream({ pull: () => void (read = true) }, { highWaterMark: 0 });
        const req = new Request("http://localhost/x?name=a&fileName=a.pdf", {
          method: m === "GET" ? "GET" : "POST",
          headers: { "content-type": "application/pdf" },
          ...(m === "GET" ? {} : { body, duplex: "half" }),
        } as RequestInit);
        expect(await redirectTarget(() => (mod[m] as (r: Request) => unknown)(req)), `${m} ${f}`).toBe("/admin/login");
        expect(read).toBe(false);
      }
    });
  }
});
