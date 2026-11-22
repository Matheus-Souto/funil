// Troca de senha (exige a atual, derruba as sessões), senha temporária com troca obrigatória e revogação de sessões
// de um membro pelo dono.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import { changePassword, listTeam, revokeMemberSessions } from "@/lib/auth/account";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, lookupSession } from "@/lib/auth/session";
import { auditLog, membership, session, users } from "@/lib/db/schema";
import { createStoreWithOwner } from "@/lib/stores";
import { HEAVY_TEST_MS, createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const PASSWORD = "senha-atual-123";
let n = 0;

async function seedUser(storeId: string, role: "owner" | "admin" | "support" | "traffic" = "owner", must = false) {
  const email = `conta${++n}@exemplo.com`;
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email, name: `Pessoa ${n}`, passwordHash: await hashPassword(PASSWORD), mustChangePassword: must })
    .returning({ id: users.id });
  await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role });
  return { userId: u!.id, email, actor: { kind: "user", userId: u!.id, role } as Extract<Actor, { kind: "user" }> };
}

const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as ActionError | null)?.code ?? "ok";
const sessionsOf = (userId: string) => t.ownerDb.select().from(session).where(eq(session.userId, userId));
const userRow = async (id: string) => (await t.ownerDb.select().from(users).where(eq(users.id, id)))[0]!;

describe("account.changePassword", () => {
  test("exige a senha atual; troca o hash, limpa a troca obrigatória e derruba todas as sessões do usuário", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    const u = await seedUser(storeId, "support", true);
    await t.ownerDb.insert(membership).values({ userId: u.userId, storeId: other.storeId, role: "admin" });
    await createSession(u.userId, storeId);
    await createSession(u.userId, other.storeId);
    const call = { storeId, actor: u.actor, origin: "panel" as const };

    expect(await code(runAction(changePassword, call, { currentPassword: "senha-errada-123", newPassword: "senha-nova-4567" }))).toBe("forbidden");
    expect(await verifyPassword(PASSWORD, (await userRow(u.userId)).passwordHash)).toBe(true);
    expect(await sessionsOf(u.userId)).toHaveLength(2);

    await runAction(changePassword, call, { currentPassword: PASSWORD, newPassword: "senha-nova-4567" });
    const row = await userRow(u.userId);
    expect(await verifyPassword("senha-nova-4567", row.passwordHash)).toBe(true);
    expect(row.mustChangePassword).toBe(false);
    expect(await sessionsOf(u.userId)).toHaveLength(0);
  }, HEAVY_TEST_MS);

  test("senha nova curta ou igual à atual: invalid_input; auditoria sem nenhuma das senhas", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const call = { storeId, actor: u.actor, origin: "panel" as const };
    expect(await code(runAction(changePassword, call, { currentPassword: PASSWORD, newPassword: "curta" }))).toBe("invalid_input");
    expect(await code(runAction(changePassword, call, { currentPassword: PASSWORD, newPassword: PASSWORD }))).toBe("invalid_input");
    await runAction(changePassword, call, { currentPassword: PASSWORD, newPassword: "outra-senha-boa-1" });
    const audits = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "account.changePassword")));
    expect(audits.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(audits);
    for (const p of [PASSWORD, "outra-senha-boa-1", "curta"]) expect(text).not.toContain(p);
  }, HEAVY_TEST_MS);

  test("muitas senhas atuais erradas: rate_limited (sem scrypt sem fim para quem roubou a sessão)", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId);
    const call = { storeId, actor: u.actor, origin: "panel" as const };
    for (let i = 0; i < 5; i++) {
      expect(await code(runAction(changePassword, call, { currentPassword: `errada-${i}-1234`, newPassword: "senha-nova-4567" }))).toBe("forbidden");
    }
    expect(await code(runAction(changePassword, call, { currentPassword: PASSWORD, newPassword: "senha-nova-4567" }))).toBe("rate_limited");
  }, HEAVY_TEST_MS);

  test("todos os papéis trocam a própria senha; MCP/IA não (sensível)", async () => {
    const { storeId } = await seedStore();
    const u = await seedUser(storeId, "traffic");
    expect(await code(runAction(changePassword, { storeId, actor: u.actor, origin: "mcp" }, { currentPassword: PASSWORD, newPassword: "senha-nova-4567" }))).toBe(
      "approval_required",
    );
    expect(await code(runAction(changePassword, { storeId, actor: u.actor, origin: "panel" }, { currentPassword: PASSWORD, newPassword: "senha-nova-4567" }))).toBe(
      "ok",
    );
  }, HEAVY_TEST_MS);
});

describe("senha temporária: troca obrigatória", () => {
  test("store:create marca o dono novo; a sessão diz que precisa trocar; usuário existente vinculado não muda", async () => {
    const r = await createStoreWithOwner({ name: "Nova", slug: `nova-${++n}`, ownerEmail: `temp${n}@exemplo.com` });
    expect((await userRow(r.userId)).mustChangePassword).toBe(true);
    const token = await createSession(r.userId, r.storeId);
    expect(await lookupSession(token)).toMatchObject({ storeId: r.storeId, mustChangePassword: true });
    const { storeId } = await seedStore();
    const existing = await seedUser(storeId);
    const linked = await createStoreWithOwner({ name: "B", slug: `b-${++n}`, ownerEmail: existing.email });
    expect(linked.temporaryPassword).toBeNull();
    expect((await userRow(existing.userId)).mustChangePassword).toBe(false);
  }, HEAVY_TEST_MS);
});

describe("equipe: listar e encerrar sessões de um membro (dono)", () => {
  test("dono lista membros e encerra as sessões de um deles só nesta loja", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    const owner = await seedUser(storeId, "owner");
    const member = await seedUser(storeId, "traffic");
    await t.ownerDb.insert(membership).values({ userId: member.userId, storeId: other.storeId, role: "admin" });
    await createSession(member.userId, storeId);
    await createSession(member.userId, storeId);
    await createSession(member.userId, other.storeId);
    const call = { storeId, actor: owner.actor, origin: "panel" as const };

    const team = (await runAction(listTeam, call, {})).members;
    expect(team.map((m) => [m.email, m.role, m.activeSessions]).sort()).toEqual(
      [
        [owner.email, "owner", 0],
        [member.email, "traffic", 2],
      ].sort(),
    );

    expect(await runAction(revokeMemberSessions, call, { userId: member.userId })).toEqual({ revoked: 2 });
    const left = await sessionsOf(member.userId);
    expect(left.map((s) => s.storeId)).toEqual([other.storeId]);
  });

  test("só o dono (team.manage); sensível; membro de outra loja: not_found; a si mesmo: conflict", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    const owner = await seedUser(storeId, "owner");
    const admin = await seedUser(storeId, "admin");
    const stranger = await seedUser(other.storeId, "support");
    const call = { storeId, actor: owner.actor, origin: "panel" as const };
    expect(await code(runAction(listTeam, { ...call, actor: admin.actor }, {}))).toBe("forbidden");
    expect(await code(runAction(revokeMemberSessions, { ...call, actor: admin.actor }, { userId: owner.userId }))).toBe("forbidden");
    expect(await code(runAction(revokeMemberSessions, { ...call, origin: "mcp" }, { userId: admin.userId }))).toBe("approval_required");
    expect(await code(runAction(revokeMemberSessions, call, { userId: stranger.userId }))).toBe("not_found");
    expect(await code(runAction(revokeMemberSessions, call, { userId: owner.userId }))).toBe("conflict");
  });

  test("um dono não encerra as sessões de outro dono: forbidden, e as sessões continuam", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const b = await seedUser(storeId, "owner");
    await createSession(b.userId, storeId);
    const e = await runAction(revokeMemberSessions, { storeId, actor: a.actor, origin: "panel" as const }, { userId: b.userId }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ActionError);
    expect([(e as ActionError).code, (e as ActionError).message]).toEqual(["forbidden", "Um dono não encerra as sessões de outro dono"]);
    expect(await sessionsOf(b.userId)).toHaveLength(1);
  });
});
