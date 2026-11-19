import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ActionError } from "@/lib/actions/core";
import { hashPassword } from "@/lib/auth/password";
import { randomToken, timingSafeEqualStr } from "@/lib/crypto";
import { db, ownerDb } from "@/lib/db/client";
import { membership, store, users } from "@/lib/db/schema";
import { env, isLoopbackUrl } from "@/lib/env";

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

/** Slugs que a loja não pode usar: o serviço de cartão vive em `pagar.<domínio>`. */
export const RESERVED_SLUGS: readonly string[] = ["pagar"];

const slugify = (s: string) => {
  const slug = slugifyRaw(s);
  return RESERVED_SLUGS.includes(slug) ? `${slug}-loja` : slug;
};
const slugifyRaw = (s: string) =>
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

/**
 * Primeira execução (MODE=single, zero usuários): cria a loja e o dono. Segunda chamada → `conflict`.
 * Exige o `SETUP_TOKEN` do servidor (comparação em tempo constante): o certificado do domínio aparece nos logs de
 * Certificate Transparency em segundos, e sem o código um robô viraria dono da loja antes do dono de verdade.
 */
export async function setupFirstRun(
  raw: { storeName: string; email: string; password: string; name: string; setupToken: string },
  mode: "single" | "multi" = env.MODE,
  expectedToken: string | null = env.SETUP_TOKEN ?? null,
): Promise<{ storeId: string; userId: string }> {
  if (mode !== "single") throw new ActionError("forbidden", "Setup inicial só no modo single");
  if (!expectedToken) {
    throw new ActionError("forbidden", "Setup desligado: defina SETUP_TOKEN no servidor (a imagem Docker gera um e mostra no log)");
  }
  const tokenOk = timingSafeEqualStr(typeof raw.setupToken === "string" ? raw.setupToken.trim() : "", expectedToken);
  if (!tokenOk) throw new ActionError("forbidden", "Código de configuração inválido");
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
  slug: z
    .string()
    .regex(SLUG, "slug inválido (a-z, 0-9 e hífen)")
    .refine((v) => !RESERVED_SLUGS.includes(v), "slug reservado"),
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
            // Senha temporária (impressa no terminal do operador): troca obrigatória no primeiro login.
            .values({ email: input.ownerEmail, name: input.ownerEmail.split("@")[0]!, passwordHash, mustChangePassword: true })
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

/** Cor da marca da loja no checkout (`null` = padrão). A tabela `store` não tem RLS. */
export async function getStoreBrandColor(storeId: string): Promise<string | null> {
  const [row] = await db.select({ brandColor: store.brandColor }).from(store).where(eq(store.id, storeId)).limit(1);
  return row?.brandColor ?? null;
}

export interface OriginsOptions {
  mode: "single" | "multi";
  platformDomain?: string;
  baseUrl?: string;
}

/**
 * Origens de onde o checkout da loja é servido: vão no `frame-ancestors` e são o destino do `postMessage` do
 * serviço de cartão. Lê só `id`, `slug` e `domain` (o papel `card` não enxerga mais nada de `store`).
 * `single`: a origem do BASE_URL. `multi`: `https://<domain>` (se houver) e `https://<slug>.<PLATFORM_DOMAIN>`;
 * se o BASE_URL for `http` em loopback (dev), o subdomínio usa o esquema e a porta do BASE_URL.
 * Loja inexistente → `[]`.
 */
export async function storeCheckoutOrigins(
  storeId: string,
  opts: OriginsOptions = { mode: env.MODE, platformDomain: env.PLATFORM_DOMAIN, baseUrl: env.BASE_URL },
): Promise<string[]> {
  const [row] = await db
    .select({ id: store.id, slug: store.slug, domain: store.domain })
    .from(store)
    .where(eq(store.id, storeId))
    .limit(1);
  if (!row) return [];
  const base = new URL(opts.baseUrl ?? env.BASE_URL);
  if (opts.mode === "single") return [base.origin];
  const origins: string[] = [];
  if (row.domain) origins.push(`https://${normalizeHost(row.domain)}`);
  const platform = opts.platformDomain ? normalizeHost(opts.platformDomain) : "";
  if (platform) {
    const dev = base.protocol === "http:" && isLoopbackUrl(base.origin);
    origins.push(dev ? `http://${row.slug}.${platform}${base.port ? `:${base.port}` : ""}` : `https://${row.slug}.${platform}`);
  }
  return origins;
}
