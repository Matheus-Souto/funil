// Gerir a equipe (spec "Equipe e convites", seções 4.1, 4.2, 7 e 8): trocar papel, remover, sair da loja, as lojas da
// conta e a corrida entre criar token MCP e deixar de ser dono.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import type { Role } from "@/lib/actions/permissions";
import { listTeam, revokeMemberSessions } from "@/lib/auth/account";
import { createSession, lookupSession } from "@/lib/auth/session";
import { sha256 } from "@/lib/crypto";
import { approvalRequest, auditLog, mcpToken, membership, session, store, users } from "@/lib/db/schema";
import { createMcpToken, revokeMcpToken } from "@/lib/mcp/tokens";
import { accountStores, changeRole, leaveStore, removeMember } from "@/lib/team/members";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

type MemberRole = "owner" | "admin" | "support" | "traffic";
type UserActor = Extract<Actor, { kind: "user" }>;
let n = 0;

async function seedUser(storeId: string, role: MemberRole) {
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email: `membro${++n}-${randomUUID().slice(0, 6)}@example.com`, name: `Pessoa ${n}`, passwordHash: "x" })
    .returning({ id: users.id });
  await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role });
  return { userId: u!.id, actor: { kind: "user", userId: u!.id, role } as UserActor };
}

const panel = (storeId: string, actor: Actor) => ({ storeId, actor, origin: "panel" as const });

const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.then(() => null, (x: unknown) => x);
  if (e === null) return "ok";
  if (!(e instanceof ActionError)) throw e;
  return e.code;
};
const failure = async (p: Promise<unknown>): Promise<ActionError> => {
  const e = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof ActionError)) throw new Error(`esperava um ActionError, veio ${String(e)}`);
  return e;
};

const roleOf = async (storeId: string, userId: string) =>
  (await t.ownerDb.select({ role: membership.role }).from(membership).where(and(eq(membership.storeId, storeId), eq(membership.userId, userId))))[0]?.role ?? null;
const owners = async (storeId: string) =>
  (await t.ownerDb.select().from(membership).where(and(eq(membership.storeId, storeId), eq(membership.role, "owner")))).length;
const sessionsOf = (userId: string) => t.ownerDb.select().from(session).where(eq(session.userId, userId));

async function tokenOf(storeId: string, createdBy: string, role: Role = "owner") {
  const [row] = await t.ownerDb
    .insert(mcpToken)
    .values({ storeId, name: "agente", role, tokenHash: sha256(randomUUID()), last4: "abcd", createdBy })
    .returning({ id: mcpToken.id });
  return row!.id;
}
async function pendingOf(storeId: string, tokenId: string) {
  const [row] = await t.ownerDb
    .insert(approvalRequest)
    .values({ storeId, tokenId, action: "products.update", inputSealed: "selado", inputSha256: sha256(randomUUID()), summary: {}, expiresAt: new Date(Date.now() + 3_600_000) })
    .returning({ id: approvalRequest.id });
  return row!.id;
}
/** Sessões do banco de teste esperando um lock do tipo dado (`advisory`, `transactionid`...). */
async function lockWaiters(locktype: string): Promise<number> {
  const rows = await t.ownerDb.execute(
    sql`select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = ${locktype} and not l.granted and a.datname = current_database()`,
  );
  return rows.length;
}
async function waitUntil(cond: () => Promise<boolean>): Promise<void> {
  while (!(await cond())) await new Promise<void>((r) => setImmediate(r));
}
const waitForLockWaiter = (locktype: string) => waitUntil(async () => (await lockWaiters(locktype)) > 0);

const tokenRow = async (id: string) => (await t.ownerDb.select().from(mcpToken).where(eq(mcpToken.id, id)))[0]!;
const requestRow = async (id: string) => (await t.ownerDb.select().from(approvalRequest).where(eq(approvalRequest.id, id)))[0]!;
const auditsOf = (storeId: string, action: string) =>
  t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, action)));

describe("team.changeRole", () => {
  test("dono promove admin a dono; auditoria com userId, from, to e tokensRevoked", async () => {
    const { storeId } = await seedStore();
    const owner = await seedUser(storeId, "owner");
    const admin = await seedUser(storeId, "admin");
    expect(await runAction(changeRole, panel(storeId, owner.actor), { userId: admin.userId, role: "owner" })).toEqual({ tokensRevoked: 0 });
    expect(await roleOf(storeId, admin.userId)).toBe("owner");
    const [a] = await auditsOf(storeId, "team.changeRole");
    expect(a!.input).toEqual({ userId: admin.userId, from: "admin", to: "owner", result: { tokensRevoked: 0 } });
  });

  test("dono tenta rebaixar outro dono: forbidden, e nada muda", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const b = await seedUser(storeId, "owner");
    const e = await failure(runAction(changeRole, panel(storeId, a.actor), { userId: b.userId, role: "admin" }));
    expect(e.code).toBe("forbidden");
    expect(e.message).toBe("Um dono não muda o papel de outro dono");
    expect(await roleOf(storeId, b.userId)).toBe("owner");
  });

  test("único dono se rebaixa: conflict", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const e = await failure(runAction(changeRole, panel(storeId, a.actor), { userId: a.userId, role: "admin" }));
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("A loja precisa de pelo menos um dono");
    expect(await roleOf(storeId, a.userId)).toBe("owner");
  });

  test("dois donos se rebaixam em paralelo: um passa, o outro dá conflict e sobra um dono", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const b = await seedUser(storeId, "owner");
    const codes = await Promise.all([
      code(runAction(changeRole, panel(storeId, a.actor), { userId: a.userId, role: "admin" })),
      code(runAction(changeRole, panel(storeId, b.actor), { userId: b.userId, role: "support" })),
    ]);
    expect(codes.sort()).toEqual(["conflict", "ok"]);
    expect(await owners(storeId)).toBe(1);
  });

  test("rebaixar a si mesmo com outro dono restando revoga os tokens que criou e cancela os pedidos pendentes deles", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    const a = await seedUser(storeId, "owner");
    const b = await seedUser(storeId, "owner");
    await t.ownerDb.insert(membership).values({ userId: a.userId, storeId: other.storeId, role: "owner" });
    const mine1 = await tokenOf(storeId, a.userId);
    const mine2 = await tokenOf(storeId, a.userId, "reader");
    const theirs = await tokenOf(storeId, b.userId);
    const elsewhere = await tokenOf(other.storeId, a.userId);
    const req = await pendingOf(storeId, mine1);

    expect(await runAction(changeRole, panel(storeId, a.actor), { userId: a.userId, role: "admin" })).toEqual({ tokensRevoked: 2 });
    expect(await roleOf(storeId, a.userId)).toBe("admin");
    expect((await tokenRow(mine1)).revokedAt).not.toBeNull();
    expect((await tokenRow(mine2)).revokedAt).not.toBeNull();
    expect((await tokenRow(theirs)).revokedAt).toBeNull();
    expect((await tokenRow(elsewhere)).revokedAt).toBeNull();
    expect(await requestRow(req)).toMatchObject({ status: "canceled", inputSealed: null });
  });

  test("trocar papel não apaga a sessão, e lookupSession devolve o papel novo", async () => {
    const { storeId } = await seedStore();
    const owner = await seedUser(storeId, "owner");
    const sup = await seedUser(storeId, "support");
    const cookie = await createSession(sup.userId, storeId);
    await runAction(changeRole, panel(storeId, owner.actor), { userId: sup.userId, role: "traffic" });
    expect(await sessionsOf(sup.userId)).toHaveLength(1);
    expect((await lookupSession(cookie))?.actor).toEqual({ kind: "user", userId: sup.userId, role: "traffic" });
  });

  test("membro de outra loja: not_found; papel fora da lista (reader): invalid_input", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    const owner = await seedUser(storeId, "owner");
    const stranger = await seedUser(other.storeId, "support");
    expect(await code(runAction(changeRole, panel(storeId, owner.actor), { userId: stranger.userId, role: "admin" }))).toBe("not_found");
    const sup = await seedUser(storeId, "support");
    expect(await code(runAction(changeRole, panel(storeId, owner.actor), { userId: sup.userId, role: "reader" }))).toBe("invalid_input");
  });

  test("ator com papel antigo (já rebaixado) não gere mais a equipe: forbidden", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const b = await seedUser(storeId, "owner");
    const sup = await seedUser(storeId, "support");
    await runAction(changeRole, panel(storeId, a.actor), { userId: a.userId, role: "admin" });
    // `a.actor` ainda diz `owner` (sessão lida antes do rebaixamento).
    expect(await code(runAction(changeRole, panel(storeId, a.actor), { userId: sup.userId, role: "admin" }))).toBe("forbidden");
    expect(await code(runAction(removeMember, panel(storeId, a.actor), { userId: sup.userId }))).toBe("forbidden");
    expect(await roleOf(storeId, sup.userId)).toBe("support");
    expect(await roleOf(storeId, b.userId)).toBe("owner");
  });
});

describe("team.remove", () => {
  test("dono tenta remover outro dono: forbidden; remover a si mesmo: conflict", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const b = await seedUser(storeId, "owner");
    expect(await code(runAction(removeMember, panel(storeId, a.actor), { userId: b.userId }))).toBe("forbidden");
    const e = await failure(runAction(removeMember, panel(storeId, a.actor), { userId: a.userId }));
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("Use Sair da loja");
    expect(await owners(storeId)).toBe(2);
  });

  test("apaga o vínculo e só as sessões desta loja; a sessão removida não abre mais", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    const owner = await seedUser(storeId, "owner");
    const adm = await seedUser(storeId, "admin");
    await t.ownerDb.insert(membership).values({ userId: adm.userId, storeId: other.storeId, role: "support" });
    const here1 = await createSession(adm.userId, storeId);
    await createSession(adm.userId, storeId);
    const there = await createSession(adm.userId, other.storeId);

    expect(await runAction(removeMember, panel(storeId, owner.actor), { userId: adm.userId })).toEqual({ sessionsEnded: 2, tokensRevoked: 0 });
    expect(await roleOf(storeId, adm.userId)).toBeNull();
    expect(await roleOf(other.storeId, adm.userId)).toBe("support");
    expect(await lookupSession(here1)).toBeNull();
    expect((await lookupSession(there))?.storeId).toBe(other.storeId);
    expect(await sessionsOf(adm.userId)).toHaveLength(1);
    const [a] = await auditsOf(storeId, "team.remove");
    expect(a!.input).toEqual({ userId: adm.userId, role: "admin", result: { sessionsEnded: 2, tokensRevoked: 0 } });
  });

  test("revoga os tokens que a pessoa criou nesta loja", async () => {
    const { storeId } = await seedStore();
    const owner = await seedUser(storeId, "owner");
    const adm = await seedUser(storeId, "admin");
    // Token que sobrou de quando a pessoa era dona.
    const tok = await tokenOf(storeId, adm.userId);
    expect(await runAction(removeMember, panel(storeId, owner.actor), { userId: adm.userId })).toEqual({ sessionsEnded: 0, tokensRevoked: 1 });
    expect((await tokenRow(tok)).revokedAt).not.toBeNull();
  });
});

describe("team.leave", () => {
  test("suporte sai: vínculo e sessões desta loja apagados, a outra loja continua", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    await seedUser(storeId, "owner");
    const sup = await seedUser(storeId, "support");
    await t.ownerDb.insert(membership).values({ userId: sup.userId, storeId: other.storeId, role: "admin" });
    const here = await createSession(sup.userId, storeId);
    const there = await createSession(sup.userId, other.storeId);

    expect(await runAction(leaveStore, panel(storeId, sup.actor), {})).toEqual({ sessionsEnded: 1, tokensRevoked: 0 });
    expect(await roleOf(storeId, sup.userId)).toBeNull();
    expect(await lookupSession(here)).toBeNull();
    expect((await lookupSession(there))?.storeId).toBe(other.storeId);
    const [a] = await auditsOf(storeId, "team.leave");
    expect(a!.input).toEqual({ userId: sup.userId, role: "support", result: { sessionsEnded: 1, tokensRevoked: 0 } });
  });

  test("único dono não sai: conflict", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const e = await failure(runAction(leaveStore, panel(storeId, a.actor), {}));
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("A loja precisa de pelo menos um dono");
    expect(await roleOf(storeId, a.userId)).toBe("owner");
  });

  test("dono sai com outro dono restando e os tokens que criou são revogados", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    await seedUser(storeId, "owner");
    const tok = await tokenOf(storeId, a.userId);
    expect(await runAction(leaveStore, panel(storeId, a.actor), {})).toEqual({ sessionsEnded: 0, tokensRevoked: 1 });
    expect((await tokenRow(tok)).revokedAt).not.toBeNull();
    expect(await owners(storeId)).toBe(1);
  });
});

describe("account.stores", () => {
  const multi = { env: { MODE: "multi" as const, PLATFORM_DOMAIN: "lojas.example.com", BASE_URL: "https://base.example.com" } };
  const single = { env: { MODE: "single" as const, PLATFORM_DOMAIN: undefined, BASE_URL: "https://base.example.com/" } };

  test("MODE=multi: só as lojas com vínculo, com o painel de cada uma e a atual marcada", async () => {
    const a = await seedStore("Loja A");
    const b = await seedStore("Loja B");
    const c = await seedStore("Loja Sem Vínculo");
    await t.ownerDb.update(store).set({ domain: "loja-b.example.com" }).where(eq(store.id, b.storeId));
    const me = await seedUser(a.storeId, "support");
    await t.ownerDb.insert(membership).values({ userId: me.userId, storeId: b.storeId, role: "owner" });
    await seedUser(c.storeId, "owner");
    const [slugA] = await t.ownerDb.select({ slug: store.slug }).from(store).where(eq(store.id, a.storeId));

    const out = await runAction(accountStores, { ...panel(a.storeId, me.actor), server: multi }, {});
    expect(out).toEqual([
      { storeId: a.storeId, name: "Loja A", panelUrl: `https://${slugA!.slug}.lojas.example.com/admin`, current: true },
      { storeId: b.storeId, name: "Loja B", panelUrl: "https://loja-b.example.com/admin", current: false },
    ]);
    expect(JSON.stringify(out)).not.toContain(c.storeId);
    expect(await auditsOf(a.storeId, "account.stores")).toHaveLength(0);
  });

  test("MODE=single: só a loja atual", async () => {
    const a = await seedStore("Única");
    const b = await seedStore("Outra");
    const me = await seedUser(a.storeId, "traffic");
    await t.ownerDb.insert(membership).values({ userId: me.userId, storeId: b.storeId, role: "owner" });
    expect(await runAction(accountStores, { ...panel(a.storeId, me.actor), server: single }, {})).toEqual([
      { storeId: a.storeId, name: "Única", panelUrl: "https://base.example.com/admin", current: true },
    ]);
  });
});

describe("team.list", () => {
  test("cada membro traz quantos tokens ativos criou nesta loja", async () => {
    const { storeId } = await seedStore();
    const other = await seedStore("Outra");
    const owner = await seedUser(storeId, "owner");
    const adm = await seedUser(storeId, "admin");
    await tokenOf(storeId, owner.userId);
    await tokenOf(storeId, owner.userId, "reader");
    const revoked = await tokenOf(storeId, owner.userId);
    await t.ownerDb.update(mcpToken).set({ revokedAt: new Date() }).where(eq(mcpToken.id, revoked));
    await tokenOf(other.storeId, owner.userId);
    const { members } = await runAction(listTeam, panel(storeId, owner.actor), {});
    const by = new Map(members.map((m) => [m.userId, m.tokensCreated]));
    expect(by.get(owner.userId)).toBe(2);
    expect(by.get(adm.userId)).toBe(0);
  });
});

describe("mcpTokens.create x deixar de ser dono", () => {
  test("dono rebaixado (com outro dono restando): criar token com o ator antigo dá forbidden", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    await seedUser(storeId, "owner");
    await runAction(changeRole, panel(storeId, a.actor), { userId: a.userId, role: "admin" });
    expect(await code(runAction(createMcpToken, panel(storeId, a.actor), { name: "tardio", role: "owner" }))).toBe("forbidden");
    expect(await t.ownerDb.select().from(mcpToken).where(eq(mcpToken.storeId, storeId))).toHaveLength(0);
  });

  test("em paralelo: o dono se rebaixa enquanto cria um token com o mesmo ator; não sobra token ativo dele", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    await seedUser(storeId, "owner");
    // Ordem forçada da pior corrida: a criação lê o papel (ainda dono) e para no insert, porque a FK de `created_by`
    // precisa de `for key share` na linha do usuário, travada aqui com `for update`. O rebaixamento corre nesse meio
    // tempo. Com o lock da equipe na criação, o rebaixamento espera o token nascer e o revoga; sem ele, o rebaixamento
    // termina antes e o token nasce depois, ativo.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = t.ownerDb.transaction(async (tx) => {
      await tx.execute(sql`select 1 from users where id = ${a.userId} for update`);
      locked();
      await held;
    });
    await isLocked;
    const create = code(runAction(createMcpToken, panel(storeId, a.actor), { name: "corrida", role: "owner" }));
    await waitForLockWaiter("transactionid");
    let demoteDone = false;
    const demote = code(runAction(changeRole, panel(storeId, a.actor), { userId: a.userId, role: "admin" })).finally(() => (demoteDone = true));
    // Espera o rebaixamento terminar (sem o lock na criação) ou parar no lock da equipe (com ele).
    await waitUntil(async () => demoteDone || (await lockWaiters("advisory")) > 0);
    release();
    await holder;
    expect(await demote).toBe("ok");
    expect(["ok", "forbidden"]).toContain(await create);
    const active = await t.ownerDb
      .select()
      .from(mcpToken)
      .where(and(eq(mcpToken.storeId, storeId), eq(mcpToken.createdBy, a.userId), isNull(mcpToken.revokedAt)));
    expect(active).toHaveLength(0);
  });

  test("quem saiu da loja também não cria token", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    await seedUser(storeId, "owner");
    await runAction(leaveStore, panel(storeId, a.actor), {});
    expect(await code(runAction(createMcpToken, panel(storeId, a.actor), { name: "tardio", role: "reader" }))).toBe("forbidden");
  });
});

describe("papel relido sob o lock nas outras mutações de equipe", () => {
  test("dono já rebaixado: forbidden em team.revokeSessions e mcpTokens.revoke", async () => {
    const { storeId } = await seedStore();
    const a = await seedUser(storeId, "owner");
    const b = await seedUser(storeId, "owner");
    const sup = await seedUser(storeId, "support");
    await createSession(sup.userId, storeId);
    const tok = await tokenOf(storeId, b.userId);
    await runAction(changeRole, panel(storeId, a.actor), { userId: a.userId, role: "admin" });
    expect(await code(runAction(revokeMemberSessions, panel(storeId, a.actor), { userId: sup.userId }))).toBe("forbidden");
    expect(await code(runAction(revokeMcpToken, panel(storeId, a.actor), { id: tok }))).toBe("forbidden");
    expect(await sessionsOf(sup.userId)).toHaveLength(1);
    expect((await tokenRow(tok)).revokedAt).toBeNull();
  });
});

describe("pelo MCP", () => {
  test("ator token, qualquer papel: todas forbidden", async () => {
    const { storeId } = await seedStore();
    const sup = await seedUser(storeId, "support");
    const roles: Role[] = ["owner", "admin", "support", "traffic", "reader"];
    for (const role of roles) {
      const call = { storeId, actor: { kind: "token", tokenId: randomUUID(), role } as Actor, origin: "mcp" as const };
      expect([role, await code(runAction(changeRole, call, { userId: sup.userId, role: "admin" }))]).toEqual([role, "forbidden"]);
      expect([role, await code(runAction(removeMember, call, { userId: sup.userId }))]).toEqual([role, "forbidden"]);
      expect([role, await code(runAction(leaveStore, call, {}))]).toEqual([role, "forbidden"]);
      expect([role, await code(runAction(accountStores, call, {}))]).toEqual([role, "forbidden"]);
    }
    expect(await roleOf(storeId, sup.userId)).toBe("support");
  });
});
