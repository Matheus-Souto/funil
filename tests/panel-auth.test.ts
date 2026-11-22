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
    // Sair continua possível com a senha temporária.
    const { logoutAction } = await import("@/app/admin/(panel)/actions");
    expect(await redirectTarget(() => logoutAction())).toBe("/admin/login");
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

describe("rotas do painel com sessão", () => {
  /** Usuário com o papel pedido na loja, já logado (cookie no jar). */
  async function login(storeId: string, role: "owner" | "admin" | "support" | "traffic") {
    const [u] = await t.ownerDb
      .insert(users)
      .values({ email: `${role}.${crypto.randomUUID()}@exemplo.com`, name: role, passwordHash: await hashPassword("senha-correta-123") })
      .returning({ id: users.id });
    await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role });
    jar.set(SESSION_COOKIE, await createSession(u!.id, storeId));
  }

  test("GET /admin/api/products/<id>/file: dono baixa como anexo (pdf, nosniff, no-store); support e tráfego recebem 403; produto de outra loja 404", async () => {
    const { runAction } = await import("@/lib/actions/core");
    const { createProduct } = await import("@/lib/catalog/products");
    const { makePdf } = await import("./pdf-fixtures");
    const { GET } = await import("@/app/admin/api/products/[id]/file/route");
    const { storeId } = await seedStore();
    const raw = await makePdf(1);
    const p = await runAction(createProduct, { storeId, actor: { kind: "user", userId: "u1", role: "owner" }, origin: "panel" }, { name: "Guia", fileName: "guia.pdf", file: raw });
    const get = (id: string) => GET(new Request(`http://localhost/admin/api/products/${id}/file`), { params: Promise.resolve({ id }) });

    await login(storeId, "owner");
    const ok = await get(p.id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await ok.arrayBuffer()).equals(Buffer.from(raw))).toBe(true);
    // O `sandbox` que chega ao navegador vem do next.config.ts (o E2E confere o cabeçalho real da resposta HTTP).

    for (const role of ["support", "traffic"] as const) {
      await login(storeId, role);
      expect((await get(p.id)).status, role).toBe(403);
    }
    const other = await seedStore();
    await login(other.storeId, "owner");
    expect((await get(p.id)).status).toBe(404);
  });

  test("GET /admin/orders.csv: vários status saem só com eles; status inválido é 400 (não uma planilha com tudo)", async () => {
    const { GET } = await import("@/app/admin/orders.csv/route");
    const { seedOrder, seedPanelStore } = await import("./panel-helpers");
    const s = await seedPanelStore();
    await seedOrder(s, { status: "paid", name: "Cliente Pago" });
    await seedOrder(s, { status: "pending", name: "Cliente Pendente" });
    await seedOrder(s, { status: "expired", name: "Cliente Expirado" });
    await login(s.storeId, "owner");
    const ok = await GET(new Request("http://localhost/admin/orders.csv?status=paid&status=pending"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    // As linhas da planilha: só os dois status pedidos (o cabeçalho fica na 1ª linha).
    const lines = (await ok.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines).toHaveLength(3);
    const body = lines.slice(1).join("\n");
    expect(body).toContain("Cliente Pago");
    expect(body).toContain("Cliente Pendente");
    expect(body).not.toContain("Cliente Expirado");
    const bad = await GET(new Request("http://localhost/admin/orders.csv?status=pago"));
    expect(bad.status).toBe(400);
  });
});

/** Chama `fn` e diz se ela deu `notFound()` do Next. */
async function isNotFound(fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return true;
    throw e;
  }
}

describe("Equipe e convites: páginas", () => {
  async function loginAs(storeId: string, role: "owner" | "admin" | "support" | "traffic") {
    const [u] = await t.ownerDb
      .insert(users)
      .values({ email: `${role}.${crypto.randomUUID()}@exemplo.com`, name: role, passwordHash: await hashPassword("senha-correta-123") })
      .returning({ id: users.id });
    await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role });
    jar.set(SESSION_COOKIE, await createSession(u!.id, storeId));
  }
  const props = { params: Promise.resolve({}), searchParams: Promise.resolve({}) };

  test("/admin/equipe: notFound para admin, atendimento e tráfego; o dono abre", async () => {
    const mod = (await import(join(PANEL_DIR, "equipe", "page.tsx"))) as { default: (p: unknown) => unknown };
    const { storeId } = await seedStore();
    for (const role of ["admin", "support", "traffic"] as const) {
      await loginAs(storeId, role);
      expect(await isNotFound(() => mod.default(props)), role).toBe(true);
    }
    await loginAs(storeId, "owner");
    expect(await isNotFound(() => mod.default(props))).toBe(false);
  });

  test("/admin/convite/<token> abre sem sessão (convite inválido mostra a mensagem, sem redirecionar)", async () => {
    const mod = (await import(join(import.meta.dir, "..", "src", "app", "admin", "convite", "[token]", "page.tsx"))) as { default: (p: unknown) => unknown };
    await seedStore();
    expect(await redirectTarget(() => mod.default({ params: Promise.resolve({ token: "x" }), searchParams: Promise.resolve({}) }))).toBeNull();
  });

  test("Configurações ?aba=equipe redireciona para /admin/equipe", async () => {
    const mod = (await import(join(PANEL_DIR, "settings", "page.tsx"))) as { default: (p: unknown) => unknown };
    const { storeId } = await seedStore();
    await loginAs(storeId, "owner");
    expect(await redirectTarget(() => mod.default({ searchParams: Promise.resolve({ aba: "equipe" }) }))).toBe("/admin/equipe");
  });
});
