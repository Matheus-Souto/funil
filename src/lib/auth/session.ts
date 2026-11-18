import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { ActionError, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { randomToken, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { loginAttempt, membership, session, users } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "./password";

export const SESSION_COOKIE = "__Host-funil_session";
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export type PanelActor = { storeId: string; actor: Extract<Actor, { kind: "user" }> };

/** Cria a sessão (guarda só sha256 do token) e devolve o token para o cookie. */
export async function createSession(userId: string, storeId: string): Promise<string> {
  const token = randomToken(32);
  await db.insert(session).values({
    idHash: sha256(token),
    userId,
    storeId,
    expiresAt: sql`now() + make_interval(days => ${SESSION_DAYS})`,
  });
  return token;
}

/** Sessão válida e não expirada + membership ainda existente (papel atual). Senão, `null`. */
export async function lookupSession(token: string): Promise<PanelActor | null> {
  if (!token) return null;
  const [row] = await db
    .select({ storeId: session.storeId, userId: session.userId, role: membership.role })
    .from(session)
    .innerJoin(membership, and(eq(membership.userId, session.userId), eq(membership.storeId, session.storeId)))
    .where(and(eq(session.idHash, sha256(token)), gt(session.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return null;
  return { storeId: row.storeId, actor: { kind: "user", userId: row.userId, role: row.role as Role } };
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(session).where(eq(session.idHash, sha256(token)));
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const bad = () => new ActionError("forbidden", "E-mail ou senha inválidos");

// Hash de mentira para gastar o mesmo tempo quando o e-mail não existe.
let dummyHash: Promise<string> | undefined;

/** Falhas recentes: bloqueado se as 5 últimas são de menos de 15 min (o bloqueio dura 15 min após a última). */
async function isLocked(emailHash: string): Promise<boolean> {
  const rows = await db
    .select({ recent: gt(loginAttempt.at, sql`now() - make_interval(mins => ${LOCK_MINUTES})`) })
    .from(loginAttempt)
    .where(eq(loginAttempt.emailHash, emailHash))
    .orderBy(desc(loginAttempt.at))
    .limit(MAX_FAILURES);
  return rows.length === MAX_FAILURES && rows.every((r) => r.recent);
}

async function recordFailure(emailHash: string): Promise<void> {
  await db.insert(loginAttempt).values({ emailHash });
  await db.delete(loginAttempt).where(lt(loginAttempt.at, sql`now() - interval '1 day'`));
}

/**
 * Login por e-mail e senha na loja `storeId`. Devolve o token da sessão.
 * Erro único e genérico para e-mail desconhecido, senha errada, sem vínculo e conta bloqueada.
 */
export async function login(input: { email: string; password: string; storeId: string }): Promise<string> {
  const email = normalizeEmail(input.email);
  const emailHash = sha256(email);
  const locked = await isLocked(emailHash);

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  dummyHash ??= hashPassword("senha-de-mentira-só-para-o-tempo");
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash));
  const [member] = user
    ? await db
        .select({ role: membership.role })
        .from(membership)
        .where(and(eq(membership.userId, user.id), eq(membership.storeId, input.storeId)))
        .limit(1)
    : [];

  if (locked) throw bad();
  if (!user || !passwordOk || !member) {
    await recordFailure(emailHash);
    throw bad();
  }
  await db.delete(loginAttempt).where(eq(loginAttempt.emailHash, emailHash));
  return createSession(user.id, input.storeId);
}

/** Grava o cookie de sessão (só em server action ou route handler). */
export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

/** Ator do painel a partir do cookie, ou `null`. Usado por toda página e ação do painel. */
export async function getPanelActor(): Promise<PanelActor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? lookupSession(token) : null;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(token);
  jar.delete(SESSION_COOKIE);
}
