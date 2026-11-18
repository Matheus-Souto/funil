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

/**
 * Reserva atômica de uma tentativa por e-mail: sob `pg_advisory_xact_lock` conta as 5 últimas
 * tentativas; se as 5 são de menos de 15 min, está bloqueado (o bloqueio dura 15 min após a última).
 * Se não, grava a tentativa ANTES do scrypt, então tentativas paralelas não passam de 5.
 * Devolve `true` se bloqueado. Tentativas bloqueadas não são gravadas.
 */
async function reserveAttempt(emailHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${emailHash}))`);
    const rows = await tx
      .select({ recent: gt(loginAttempt.at, sql`now() - make_interval(mins => ${LOCK_MINUTES})`) })
      .from(loginAttempt)
      .where(eq(loginAttempt.emailHash, emailHash))
      .orderBy(desc(loginAttempt.at))
      .limit(MAX_FAILURES);
    if (rows.length === MAX_FAILURES && rows.every((r) => r.recent)) return true;
    await tx.insert(loginAttempt).values({ emailHash });
    await tx.delete(loginAttempt).where(lt(loginAttempt.at, sql`now() - interval '1 day'`));
    return false;
  });
}

/**
 * Login por e-mail e senha na loja `storeId`. Devolve o token da sessão.
 * Erro único e genérico para e-mail desconhecido, senha errada, sem vínculo e conta bloqueada.
 * Limite: 5 tentativas malsucedidas por e-mail em 15 min; sucesso apaga as tentativas do e-mail.
 */
export async function login(input: { email: string; password: string; storeId: string }): Promise<string> {
  const email = normalizeEmail(input.email);
  const emailHash = sha256(email);
  const locked = await reserveAttempt(emailHash);

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

  if (locked || !user || !passwordOk || !member) throw bad();
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
