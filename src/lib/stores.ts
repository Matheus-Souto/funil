import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError } from "@/lib/actions/core";
import { hashPassword } from "@/lib/auth/password";
import { randomToken } from "@/lib/crypto";
import { db, ownerDb } from "@/lib/db/client";
import { membership, store, users } from "@/lib/db/schema";
import { env } from "@/lib/env";

export interface ResolvedStore {
  id: string;
  slug: string;
  name: string;
}
export interface ResolveOptions {
  mode: "single" | "multi";
  platformDomain?: string;
}

/** Minúsculas, sem porta e sem ponto final. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

const cols = { id: store.id, slug: store.slug, name: store.name };

/** `single`: a única loja. `multi`: `store.domain = host` ou `<slug>.PLATFORM_DOMAIN`. */
export async function resolveStore(
  host: string,
  opts: ResolveOptions = { mode: env.MODE, platformDomain: env.PLATFORM_DOMAIN },
): Promise<ResolvedStore | null> {
  if (opts.mode === "single") {
    const [row] = await db.select(cols).from(store).orderBy(store.createdAt).limit(1);
    return row ?? null;
  }
  const h = normalizeHost(host);
  if (!h) return null;
  const [byDomain] = await db.select(cols).from(store).where(eq(store.domain, h)).limit(1);
  if (byDomain) return byDomain;
  const base = opts.platformDomain ? normalizeHost(opts.platformDomain) : "";
  if (!base || !h.endsWith(`.${base}`)) return null;
  const slug = h.slice(0, -(base.length + 1));
  if (!slug || slug.includes(".")) return null;
  const [bySlug] = await db.select(cols).from(store).where(eq(store.slug, slug)).limit(1);
  return bySlug ?? null;
}

const SETUP_LOCK = 7_303_005;
const email = z.string().max(254).trim().toLowerCase().pipe(z.email());
const setupInput = z.object({
  storeName: z.string().max(100).trim().min(1),
  email,
  password: z.string().min(10, "A senha precisa ter no mínimo 10 caracteres").max(256),
  name: z.string().max(100).trim().min(1),
});

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "") || "loja";

/** Verdadeiro se o setup inicial ainda é possível: modo `single` e nenhum usuário. */
export async function needsSetup(mode: "single" | "multi" = env.MODE): Promise<boolean> {
  if (mode !== "single") return false;
  const [{ n }] = await db.select({ n: count() }).from(users);
  return n === 0;
}

/** Primeira execução (MODE=single, zero usuários): cria a loja e o dono. Segunda chamada → `conflict`. */
export async function setupFirstRun(
  raw: { storeName: string; email: string; password: string; name: string },
  mode: "single" | "multi" = env.MODE,
): Promise<{ storeId: string; userId: string }> {
  if (mode !== "single") throw new ActionError("forbidden", "Setup inicial só no modo single");
  const parsed = setupInput.safeParse(raw);
  if (!parsed.success) {
    throw new ActionError(
      "invalid_input",
      "Dados inválidos",
      parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  }
  const input = parsed.data;
  const passwordHash = await hashPassword(input.password);
  // O lock serializa setups concorrentes: o segundo vê o usuário criado pelo primeiro.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    const [{ n }] = await tx.select({ n: count() }).from(users);
    if (n > 0) throw new ActionError("conflict", "O setup inicial já foi feito");
    const [s] = await tx.insert(store).values({ name: input.storeName, slug: slugify(input.storeName) }).returning({ id: store.id });
    const [u] = await tx
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash })
      .returning({ id: users.id });
    await tx.insert(membership).values({ userId: u!.id, storeId: s!.id, role: "owner" });
    return { storeId: s!.id, userId: u!.id };
  });
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const createStoreInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(SLUG, "slug inválido (a-z, 0-9 e hífen)"),
  ownerEmail: email,
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "domínio inválido")
    .optional(),
});

/**
 * CLI `store:create` (papel dono): cria a loja e o dono, ou vincula um usuário existente.
 * `temporaryPassword` só vem preenchida quando o usuário foi criado agora.
 */
export async function createStoreWithOwner(raw: {
  name: string;
  slug: string;
  ownerEmail: string;
  domain?: string;
}): Promise<{ storeId: string; userId: string; temporaryPassword: string | null }> {
  const parsed = createStoreInput.safeParse(raw);
  if (!parsed.success) {
    throw new ActionError(
      "invalid_input",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const input = parsed.data;
  const temporaryPassword = randomToken(12);
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    return await ownerDb.transaction(async (tx) => {
      const [s] = await tx
        .insert(store)
        .values({ name: input.name, slug: input.slug, domain: input.domain ?? null })
        .returning({ id: store.id });
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.ownerEmail)).limit(1);
      const [created] = existing
        ? []
        : await tx
            .insert(users)
            .values({ email: input.ownerEmail, name: input.ownerEmail.split("@")[0]!, passwordHash })
            .returning({ id: users.id });
      const userId = (existing ?? created)!.id;
      await tx.insert(membership).values({ userId, storeId: s!.id, role: "owner" });
      return { storeId: s!.id, userId, temporaryPassword: created ? temporaryPassword : null };
    });
  } catch (e) {
    if (e instanceof Error && /unique|duplicate/i.test(`${e.message} ${String((e as { cause?: unknown }).cause)}`)) {
      throw new ActionError("conflict", "Slug ou domínio já em uso");
    }
    throw e;
  }
}
