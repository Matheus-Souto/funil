import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ActionError, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { randomToken, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db/client";
import { loginAttempt, membership, session, store, users } from "@/lib/db/schema";
import { hashPassword, verifyPassword } from "./password";

export const SESSION_COOKIE = "__Host-funil_session";
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

/** Limites de entrada do login/setup, checados ANTES de qualquer hash, consulta ou gravação. */
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 256;

export type PanelActor = {
  storeId: string;
  actor: Extract<Actor, { kind: "user" }>;
  /** Senha temporária ainda não trocada: o painel só abre a tela de troca de senha. */
  mustChangePassword?: boolean;
};

/** Tela de troca de senha (fora do grupo do painel, para a troca obrigatória não entrar em laço). */
export const CHANGE_PASSWORD_PATH = "/admin/senha";

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
    .select({ storeId: session.storeId, userId: session.userId, role: membership.role, mustChangePassword: users.mustChangePassword })
    .from(session)
    .innerJoin(membership, and(eq(membership.userId, session.userId), eq(membership.storeId, session.storeId)))
    .innerJoin(users, eq(users.id, session.userId))
    .where(and(eq(session.idHash, sha256(token)), gt(session.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return null;
  return { storeId: row.storeId, actor: { kind: "user", userId: row.userId, role: row.role as Role }, mustChangePassword: row.mustChangePassword };
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
 * tentativas; se as 5 são de menos de 15 min, está bloqueado (o bloqueio termina 15 min após a MAIS ANTIGA dessas 5; tentativas bloqueadas não são gravadas).
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

const tooLong = (email: unknown, password: unknown): boolean =>
  typeof email !== "string" || typeof password !== "string" || email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH;

/**
 * Confere e-mail e senha de uma conta (sem olhar vínculo com loja). É o caminho do login: limite de 5 tentativas
 * malsucedidas por e-mail em 15 min (a tentativa é reservada antes do scrypt) e hash de mentira quando o e-mail não
 * existe, para gastar o mesmo tempo. Devolve o usuário ou `null` (e-mail desconhecido, senha errada ou bloqueado).
 * Não apaga as tentativas no sucesso: quem chama decide (ver `clearLoginAttempts`).
 */
export async function verifyCredentials(email: string, password: string): Promise<{ userId: string } | null> {
  if (tooLong(email, password)) return null;
  const normalized = normalizeEmail(email);
  const locked = await reserveAttempt(sha256(normalized));
  const [user] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.email, normalized)).limit(1);
  dummyHash ??= hashPassword("senha-de-mentira-só-para-o-tempo");
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  return locked || !user || !passwordOk ? null : { userId: user.id };
}

/** Zera as tentativas de login do e-mail (depois de um login ou aceite de convite com a senha certa). */
export async function clearLoginAttempts(email: string): Promise<void> {
  await db.delete(loginAttempt).where(eq(loginAttempt.emailHash, sha256(normalizeEmail(email))));
}

/**
 * Login por e-mail e senha na loja `storeId`. Devolve o token da sessão.
 * Erro único e genérico para e-mail desconhecido, senha errada, sem vínculo e conta bloqueada.
 * Limite: 5 tentativas malsucedidas por e-mail em 15 min; sucesso apaga as tentativas do e-mail.
 */
export async function login(input: { email: string; password: string; storeId: string }): Promise<string> {
  if (tooLong(input.email, input.password)) throw bad();
  const cred = await verifyCredentials(input.email, input.password);
  const [member] = cred
    ? await db
        .select({ role: membership.role })
        .from(membership)
        .where(and(eq(membership.userId, cred.userId), eq(membership.storeId, input.storeId)))
        .limit(1)
    : [];

  if (!cred || !member) throw bad();
  await clearLoginAttempts(input.email);
  return createSession(cred.userId, input.storeId);
}

/**
 * Login no host do painel da plataforma (MODE=multi, host do BASE_URL que não é loja, ex.: `app.plataforma.com.br`):
 * mesmas regras do `login` (limite de tentativas, erro único e genérico), mas sem loja fixa pelo host. A sessão abre na
 * primeira loja da pessoa na ordem da lista "Suas lojas" (nome, depois id); as outras abrem pelo endereço de cada uma.
 * Conta sem vínculo com nenhuma loja dá o mesmo erro de senha errada.
 */
export async function loginOnPanelHost(input: { email: string; password: string }): Promise<string> {
  if (tooLong(input.email, input.password)) throw bad();
  const cred = await verifyCredentials(input.email, input.password);
  const [member] = cred
    ? await db
        .select({ storeId: membership.storeId })
        .from(membership)
        .innerJoin(store, eq(store.id, membership.storeId))
        .where(eq(membership.userId, cred.userId))
        .orderBy(asc(store.name), asc(store.id))
        .limit(1)
    : [];
  if (!cred || !member) throw bad();
  await clearLoginAttempts(input.email);
  return createSession(cred.userId, member.storeId);
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

/**
 * Porta de entrada de TODA página e server action do painel (o layout não protege server actions):
 * sem sessão válida redireciona para /admin/login; com senha temporária ainda não trocada, para a troca de senha
 * (só a própria tela de troca passa `allowPasswordChange`); com sessão devolve a loja e o ator para `runAction`.
 */
export async function requirePanelActor(opts: { allowPasswordChange?: boolean } = {}): Promise<PanelActor> {
  const panel = await getPanelActor();
  if (!panel) redirect("/admin/login");
  if (panel.mustChangePassword && !opts.allowPasswordChange) redirect(CHANGE_PASSWORD_PATH);
  return panel;
}

/** Depois de trocar a senha (todas as sessões do usuário foram apagadas): sessão nova só para este navegador. */
export async function renewSessionCookie(panel: PanelActor): Promise<void> {
  await setSessionCookie(await createSession(panel.actor.userId, panel.storeId));
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(token);
  jar.delete(SESSION_COOKIE);
}

/** Quem está no painel (usuário; nome, endereço e cor da loja) para a moldura e os links. Tabelas globais, sem RLS. */
export async function getPanelIdentity(panel: PanelActor): Promise<{
  userName: string;
  userEmail: string;
  storeName: string;
  store: { slug: string; domain: string | null; brandColor: string | null };
}> {
  const [u] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, panel.actor.userId)).limit(1);
  const [s] = await db
    .select({ name: store.name, slug: store.slug, domain: store.domain, brandColor: store.brandColor })
    .from(store)
    .where(eq(store.id, panel.storeId))
    .limit(1);
  return {
    userName: u?.name ?? "",
    userEmail: u?.email ?? "",
    storeName: s?.name ?? "",
    store: { slug: s?.slug ?? "", domain: s?.domain ?? null, brandColor: s?.brandColor ?? null },
  };
}
