// Aceite do convite (spec "Equipe e convites", seções 4.3, 4.4 e 6): `team.inviteInfo` (GET da página) e
// `team.acceptInvite` (POST), com conta nova ou com a conta que já existe. Os convites são gravados direto no banco com
// um token gerado aqui (só o sha256 vai para a tabela), sem passar pelo envio do e-mail.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { UNKNOWN_IP } from "@/lib/client-ip";
import { sha256 } from "@/lib/crypto";
import { auditLog, loginAttempt, membership, teamInvite, users } from "@/lib/db/schema";
import { acceptInvite, inviteInfo } from "@/lib/team/accept";
import { TEAM, inviteTokenHash } from "@/lib/team/rules";
import { HEAVY_TEST_MS, createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const PASSWORD = "senha-da-conta-123";
const NEW_PASSWORD = "senha-nova-do-convidado";
const GONE = "Este convite não vale mais";
const DAY_MS = 86_400_000;
/**
 * Relógio fixo dos limites de tentativa: a janela é fixa (15 min, alinhada ao relógio), então todas as tentativas do
 * arquivo caem na mesma janela mesmo que o teste cruze uma borda. É o início da janela atual (nada de data futura: a
 * limpeza ocasional do `rate_limit` apaga o que for 24 h mais velho que esse relógio).
 */
const NOW = new Date(Math.floor(Date.now() / (TEAM.acceptWindowSec * 1000)) * TEAM.acceptWindowSec * 1000);
let n = 0;

const newToken = () => "inv" + "_" + randomBytes(32).toString("base64url");
const newEmail = () => `convidado${++n}-${randomBytes(3).toString("hex")}@example.com`;
let ipSeq = 0;
/** Um IP por teste: o limite por IP é global (tabela `rate_limit`). */
const newIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

const publicCall = (storeId: string, ip = newIp()) => ({ storeId, actor: { kind: "public" as const }, origin: "public" as const, server: { ip, now: NOW } });

const failure = async (p: Promise<unknown>): Promise<ActionError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof ActionError)) throw new Error(`esperava um ActionError, veio ${String(e)}`);
  return e;
};

async function seedInvite(storeId: string, o: { email?: string; role?: "admin" | "support" | "traffic"; expiresAt?: Date } = {}) {
  const token = newToken();
  const email = o.email ?? newEmail();
  const [row] = await t.ownerDb
    .insert(teamInvite)
    .values({
      storeId,
      email,
      emailHash: sha256(email),
      role: o.role ?? "support",
      tokenHash: inviteTokenHash(token),
      expiresAt: o.expiresAt ?? new Date(Date.now() + 7 * DAY_MS),
    })
    .returning({ id: teamInvite.id });
  return { token, email, inviteId: row!.id };
}

async function seedAccount(email: string, o: { storeId?: string; role?: string; password?: string } = {}) {
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email, name: "Conta Antiga", passwordHash: o.password === undefined ? "x" : await hashPassword(o.password) })
    .returning({ id: users.id });
  if (o.storeId) await t.ownerDb.insert(membership).values({ userId: u!.id, storeId: o.storeId, role: o.role ?? "admin" });
  return u!.id;
}

const inviteRow = async (id: string) => (await t.ownerDb.select().from(teamInvite).where(eq(teamInvite.id, id)))[0]!;
const membersOf = (storeId: string) => t.ownerDb.select().from(membership).where(eq(membership.storeId, storeId));

describe("team.inviteInfo", () => {
  test("devolve loja, papel, e-mail, se tem conta e a validade; GET não consome nada", async () => {
    const { storeId } = await seedStore("Maná Kids");
    const inv = await seedInvite(storeId, { role: "traffic" });
    const info = await runAction(inviteInfo, publicCall(storeId), { token: inv.token });
    const row = await inviteRow(inv.inviteId);
    expect(info).toEqual({ storeName: "Maná Kids", roleLabel: "Tráfego", email: inv.email, hasAccount: false, expiresAt: row.expiresAt });
    expect(row.status).toBe("pending");
    expect(row.email).toBe(inv.email);
  });

  test("com conta: hasAccount, e nada sobre as outras lojas da conta", async () => {
    const { storeId } = await seedStore("Loja Convidante");
    const other = await seedStore("Loja Secreta Onde Ela Já Está");
    const inv = await seedInvite(storeId);
    await seedAccount(inv.email, { storeId: other.storeId, role: "owner" });
    const info = await runAction(inviteInfo, publicCall(storeId), { token: inv.token });
    expect(info).not.toBeNull();
    expect(Object.keys(info!).sort()).toEqual(["email", "expiresAt", "hasAccount", "roleLabel", "storeName"]);
    expect(info!.hasAccount).toBe(true);
    const json = JSON.stringify(info);
    expect(json).not.toContain("Secreta");
    expect(json).not.toContain(other.storeId);
    expect(json).not.toContain("owner");
  });

  test("não audita (nem o GET com sucesso)", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    await runAction(inviteInfo, publicCall(storeId), { token: inv.token });
    expect(await t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId))).toHaveLength(0);
  });
});

describe("team.acceptInvite", () => {
  test("conta nova: cria o usuário, o vínculo com o papel do convite e encerra o convite sem o e-mail", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId, { role: "admin" });
    const out = await runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "  Maria Nova  ", password: NEW_PASSWORD });
    expect(out).toEqual({ userId: expect.any(String), storeId, role: "admin", newAccount: true });
    const [u] = await t.ownerDb.select().from(users).where(eq(users.id, out.userId));
    expect(u).toMatchObject({ email: inv.email, name: "Maria Nova", mustChangePassword: false });
    expect(await verifyPassword(NEW_PASSWORD, u!.passwordHash)).toBe(true);
    expect((await membersOf(storeId)).map((m) => [m.userId, m.role])).toEqual([[out.userId, "admin"]]);
    const row = await inviteRow(inv.inviteId);
    expect(row).toMatchObject({ status: "accepted", email: null, emailHash: sha256(inv.email), acceptedBy: out.userId });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.endedAt).not.toBeNull();
    // O e-mail do convite não muda no aceite: só nome e senha entram.
    expect(await runAction(inviteInfo, publicCall(storeId), { token: inv.token })).toBeNull();
  }, HEAVY_TEST_MS);

  test("conta que já existe, com a senha certa: só o vínculo (a senha e o nome não mudam)", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore();
    const inv = await seedInvite(storeId, { role: "support" });
    const userId = await seedAccount(inv.email, { storeId: other.storeId, role: "owner", password: PASSWORD });
    const [before] = await t.ownerDb.select().from(users).where(eq(users.id, userId));
    const out = await runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "existing", password: PASSWORD });
    expect(out).toEqual({ userId, storeId, role: "support", newAccount: false });
    const [after] = await t.ownerDb.select().from(users).where(eq(users.id, userId));
    expect(after).toEqual(before!);
    expect((await membersOf(storeId)).map((m) => [m.userId, m.role])).toEqual([[userId, "support"]]);
    expect((await membersOf(other.storeId)).map((m) => [m.userId, m.role])).toEqual([[userId, "owner"]]);
    expect(await inviteRow(inv.inviteId)).toMatchObject({ status: "accepted", email: null, acceptedBy: userId });
  }, HEAVY_TEST_MS);

  test("senha errada: forbidden \"Senha incorreta\", convite intacto; a 6ª tentativa bloqueia como o login", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    await seedAccount(inv.email, { password: PASSWORD });
    const call = publicCall(storeId);
    for (let i = 0; i < 5; i++) {
      const e = await failure(runAction(acceptInvite, call, { token: inv.token, mode: "existing", password: "senha-errada-123" }));
      expect([e.code, e.message]).toEqual(["forbidden", "Senha incorreta"]);
    }
    // Bloqueado pelo mesmo limite do login: nem a senha certa passa, e a tentativa bloqueada não é gravada.
    const locked = await failure(runAction(acceptInvite, call, { token: inv.token, mode: "existing", password: PASSWORD }));
    expect(locked.code).toBe("forbidden");
    expect(await t.ownerDb.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256(inv.email)))).toHaveLength(5);
    expect(await inviteRow(inv.inviteId)).toMatchObject({ status: "pending", email: inv.email });
    expect(await membersOf(storeId)).toHaveLength(0);
    // Passado o bloqueio, a senha certa aceita e zera as tentativas, como o login.
    await t.ownerDb.update(loginAttempt).set({ at: sql`now() - interval '16 minutes'` }).where(eq(loginAttempt.emailHash, sha256(inv.email)));
    await runAction(acceptInvite, call, { token: inv.token, mode: "existing", password: PASSWORD });
    expect(await t.ownerDb.select().from(loginAttempt).where(eq(loginAttempt.emailHash, sha256(inv.email)))).toHaveLength(0);
  }, HEAVY_TEST_MS);

  test("o mesmo token duas vezes: o segundo dá not_found", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    await runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Ana", password: NEW_PASSWORD });
    const e = await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Ana", password: NEW_PASSWORD }));
    expect([e.code, e.message]).toEqual(["not_found", GONE]);
    expect(await membersOf(storeId)).toHaveLength(1);
  }, HEAVY_TEST_MS);

  test("dois aceites em paralelo: um passa e o outro dá not_found", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    const results = await Promise.allSettled(
      [1, 2].map(() => runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Bia", password: NEW_PASSWORD })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(ActionError);
    expect([bad[0]!.reason.code, bad[0]!.reason.message]).toEqual(["not_found", GONE]);
    expect(await membersOf(storeId)).toHaveLength(1);
    expect(await t.ownerDb.select().from(users).where(eq(users.email, inv.email))).toHaveLength(1);
  }, HEAVY_TEST_MS);

  test("vencido, revogado, inventado, mal formado e de outra loja: inviteInfo null e o aceite not_found, mesma mensagem", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore();
    const expired = await seedInvite(storeId, { expiresAt: new Date(Date.now() - 1000) });
    const revoked = await seedInvite(storeId);
    await t.ownerDb.update(teamInvite).set({ status: "revoked", email: null, endedAt: new Date() }).where(eq(teamInvite.id, revoked.inviteId));
    const foreign = await seedInvite(other.storeId);
    const tokens = [expired.token, revoked.token, newToken(), foreign.token, "qualquer-coisa", "", "x".repeat(200)];
    for (const token of tokens) {
      expect(await runAction(inviteInfo, publicCall(storeId), { token })).toBeNull();
      for (const body of [
        { token, mode: "new", name: "Caio", password: NEW_PASSWORD },
        { token, mode: "existing", password: PASSWORD },
      ]) {
        const e = await failure(runAction(acceptInvite, publicCall(storeId), body));
        expect([token.slice(0, 12), e.code, e.message]).toEqual([token.slice(0, 12), "not_found", GONE]);
      }
    }
    // Nada mudou: o vencido continua como estava (GET e POST recusados não gravam), o da outra loja segue pendente.
    expect(await inviteRow(expired.inviteId)).toMatchObject({ status: "pending", email: expired.email });
    expect(await inviteRow(foreign.inviteId)).toMatchObject({ status: "pending", email: foreign.email });
    expect(await membersOf(storeId)).toHaveLength(0);
    expect(await membersOf(other.storeId)).toHaveLength(0);
  }, HEAVY_TEST_MS);

  test(`${TEAM.acceptPerIp + 1} tentativas do mesmo IP: rate_limited`, async () => {
    const { storeId } = await seedStore();
    const call = publicCall(storeId);
    for (let i = 0; i < TEAM.acceptPerIp; i++) {
      const e = await failure(runAction(acceptInvite, call, { token: newToken(), mode: "existing", password: PASSWORD }));
      expect(e.code).toBe("not_found");
    }
    const inv = await seedInvite(storeId);
    const e = await failure(runAction(acceptInvite, call, { token: inv.token, mode: "new", name: "Duda", password: NEW_PASSWORD }));
    expect(e.code).toBe("rate_limited");
    // Outro IP passa.
    await runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Duda", password: NEW_PASSWORD });
  }, HEAVY_TEST_MS);

  test("IP desconhecido não é um balde único: 11 tentativas sem rate_limited por IP, e o limite por convite vale", async () => {
    const { storeId } = await seedStore();
    const call = publicCall(storeId, UNKNOWN_IP);
    for (let i = 0; i <= TEAM.acceptPerIp; i++) {
      const e = await failure(runAction(acceptInvite, call, { token: newToken(), mode: "existing", password: PASSWORD }));
      expect(e.code).toBe("not_found");
    }
    const inv = await seedInvite(storeId);
    await seedAccount(inv.email);
    for (let i = 0; i < TEAM.acceptPerInvite; i++) {
      const e = await failure(runAction(acceptInvite, call, { token: inv.token, mode: "new", name: "Lia", password: NEW_PASSWORD }));
      expect(e.code).toBe("conflict");
    }
    const e = await failure(runAction(acceptInvite, call, { token: inv.token, mode: "new", name: "Lia", password: NEW_PASSWORD }));
    expect(e.code).toBe("rate_limited");
  });

  test("limite por IP e por convite dão a mesma mensagem", async () => {
    const { storeId } = await seedStore();
    const ipCall = publicCall(storeId);
    for (let i = 0; i < TEAM.acceptPerIp; i++) await failure(runAction(acceptInvite, ipCall, { token: newToken(), mode: "existing", password: PASSWORD }));
    const byIp = await failure(runAction(acceptInvite, ipCall, { token: newToken(), mode: "existing", password: PASSWORD }));
    const inv = await seedInvite(storeId);
    await seedAccount(inv.email);
    for (let i = 0; i < TEAM.acceptPerInvite; i++) {
      await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Lia", password: NEW_PASSWORD }));
    }
    const byInvite = await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Lia", password: NEW_PASSWORD }));
    expect([byIp.code, byIp.message]).toEqual([byInvite.code, byInvite.message]);
    expect(byIp.code).toBe("rate_limited");
  });

  test("conta existente cujo e-mail mudou (ou que sumiu) entre o prepare e o run: not_found padrão, convite pendente", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    const userId = await seedAccount(inv.email, { password: PASSWORD });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = t.ownerDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"team:" + storeId}))`);
      locked();
      await held;
      await tx.update(users).set({ email: `trocado-${randomBytes(3).toString("hex")}@example.com` }).where(eq(users.id, userId));
    });
    await isLocked;
    const pending = failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "existing", password: PASSWORD }));
    await waitForAdvisoryWaiter();
    release();
    await holder;
    const e = await pending;
    expect([e.code, e.message]).toEqual(["not_found", GONE]);
    expect(await inviteRow(inv.inviteId)).toMatchObject({ status: "pending", email: inv.email });
    expect(await membersOf(storeId)).toHaveLength(0);
    // Conta apagada: o mesmo not_found (sem estourar a FK do vínculo).
    const inv2 = await seedInvite(storeId);
    const gone = await seedAccount(inv2.email, { password: PASSWORD });
    let release2!: () => void;
    const held2 = new Promise<void>((r) => (release2 = r));
    let locked2!: () => void;
    const isLocked2 = new Promise<void>((r) => (locked2 = r));
    const holder2 = t.ownerDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"team:" + storeId}))`);
      locked2();
      await held2;
      await tx.delete(users).where(eq(users.id, gone));
    });
    await isLocked2;
    const pending2 = failure(runAction(acceptInvite, publicCall(storeId), { token: inv2.token, mode: "existing", password: PASSWORD }));
    await waitForAdvisoryWaiter();
    release2();
    await holder2;
    const e2 = await pending2;
    expect([e2.code, e2.message]).toEqual(["not_found", GONE]);
  }, HEAVY_TEST_MS);

  test(`${TEAM.acceptPerInvite + 1} tentativas no mesmo convite (IPs diferentes): rate_limited`, async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    // Cada tentativa é uma conta nova recusada por já existir conta (sem gastar o scrypt nem o bloqueio do login).
    await seedAccount(inv.email);
    for (let i = 0; i < TEAM.acceptPerInvite; i++) {
      const e = await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Eva", password: NEW_PASSWORD }));
      expect(e.code).toBe("conflict");
    }
    const e = await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Eva", password: NEW_PASSWORD }));
    expect(e.code).toBe("rate_limited");
  });

  test("conta nova quando a conta já existe: conflict com details.hasAccount", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    await seedAccount(inv.email);
    const e = await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Fábio", password: NEW_PASSWORD }));
    expect([e.code, e.details]).toEqual(["conflict", { hasAccount: true }]);
    expect(await inviteRow(inv.inviteId)).toMatchObject({ status: "pending", email: inv.email });
  });

  test("corrida: a conta nasce depois do prepare (entre o GET e o POST) → conflict hasAccount, convite segue pendente", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    // A conta é criada enquanto o aceite espera o lock da loja (segurado por esta transação).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = t.ownerDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"team:" + storeId}))`);
      locked();
      await held;
      await tx.insert(users).values({ email: inv.email, name: "Nasceu no meio", passwordHash: "x" });
    });
    await isLocked;
    const pending = failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Gil", password: NEW_PASSWORD }));
    // O aceite precisa chegar ao lock antes da conta nascer: espera a sessão dele aparecer bloqueada no advisory lock.
    await waitForAdvisoryWaiter();
    release();
    await holder;
    const e = await pending;
    expect([e.code, e.details]).toEqual(["conflict", { hasAccount: true }]);
    expect(await inviteRow(inv.inviteId)).toMatchObject({ status: "pending", email: inv.email });
    expect(await membersOf(storeId)).toHaveLength(0);
  }, HEAVY_TEST_MS);

  test("quem já é membro: o convite fecha sem duplicar nem mudar o vínculo", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId, { role: "support" });
    const userId = await seedAccount(inv.email, { storeId, role: "admin", password: PASSWORD });
    const out = await runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "existing", password: PASSWORD });
    expect(out).toEqual({ userId, storeId, role: "admin", newAccount: false });
    expect((await membersOf(storeId)).map((m) => [m.userId, m.role])).toEqual([[userId, "admin"]]);
    expect(await inviteRow(inv.inviteId)).toMatchObject({ status: "accepted", acceptedBy: userId, email: null });
  }, HEAVY_TEST_MS);

  test(`loja com ${TEAM.maxSeats} assentos ocupados: conflict, convite segue pendente`, async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId);
    const tag = randomBytes(3).toString("hex");
    const people = await t.ownerDb
      .insert(users)
      .values(Array.from({ length: TEAM.maxSeats }, (_, i) => ({ email: `cheia${i}-${tag}@example.com`, name: `P${i}`, passwordHash: "x" })))
      .returning({ id: users.id });
    await t.ownerDb.insert(membership).values(people.map((p, i) => ({ userId: p.id, storeId, role: i === 0 ? "owner" : "support" })));
    const e = await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Hugo", password: NEW_PASSWORD }));
    expect(e.code).toBe("conflict");
    expect(await inviteRow(inv.inviteId)).toMatchObject({ status: "pending", email: inv.email });
    expect(await t.ownerDb.select().from(users).where(eq(users.email, inv.email))).toHaveLength(0);
    // Com um assento livre, o convite (que já ocupava o seu) entra.
    await t.ownerDb.delete(membership).where(and(eq(membership.storeId, storeId), eq(membership.userId, people[1]!.id)));
    await runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Hugo", password: NEW_PASSWORD });
    expect(await membersOf(storeId)).toHaveLength(TEAM.maxSeats);
  }, HEAVY_TEST_MS);

  test("nada de token nem e-mail no log, no audit_log nem na saída; auditoria com inviteId, userId, role e newAccount", async () => {
    const { storeId } = await seedStore();
    const inv = await seedInvite(storeId, { role: "traffic" });
    const existing = await seedInvite(storeId);
    await seedAccount(existing.email, { password: PASSWORD });
    const out: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(((s: string) => void out.push(String(s))) as never);
    let result: unknown;
    try {
      result = await runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Íris", password: NEW_PASSWORD });
      // Recusas também passam pelo log: token usado, senha errada e conta que já existe.
      await failure(runAction(acceptInvite, publicCall(storeId), { token: inv.token, mode: "new", name: "Íris", password: NEW_PASSWORD }));
      await failure(runAction(acceptInvite, publicCall(storeId), { token: existing.token, mode: "existing", password: "senha-errada-123" }));
      await failure(runAction(acceptInvite, publicCall(storeId), { token: existing.token, mode: "new", name: "Íris", password: NEW_PASSWORD }));
    } finally {
      write.mockRestore();
    }
    const audit = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "team.acceptInvite")));
    // Falha de ator público não vai para o audit_log.
    expect(audit).toHaveLength(1);
    const userId = (result as { userId: string }).userId;
    expect(audit[0]).toMatchObject({ ok: true, origin: "public", actor: { kind: "public" } });
    expect(audit[0]!.input).toEqual({ inviteId: inv.inviteId, result: { userId, role: "traffic", newAccount: true } });
    const everything = JSON.stringify([result, audit]) + out.join("");
    for (const secret of [inv.email, inv.email.split("@")[0]!, inv.token, existing.email, existing.token, NEW_PASSWORD, "senha-errada-123", "Íris"]) {
      expect(everything).not.toContain(secret);
    }
  }, HEAVY_TEST_MS);
});

/** Espera até haver uma sessão do banco de teste esperando um advisory lock (o aceite parado no `lockTeam`). */
async function waitForAdvisoryWaiter(): Promise<void> {
  for (;;) {
    const rows = await t.ownerDb.execute(
      sql`select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
    );
    if (rows.length > 0) return;
    await new Promise<void>((r) => setImmediate(r));
  }
}
