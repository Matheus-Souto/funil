// Regras de equipe (src/lib/team/rules.ts): canGrant, limites, lock por loja, donos, assentos e revogação dos tokens
// de quem deixa de ser dono. Nenhum literal com formato de segredo: tudo montado em tempo de execução.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { ROLE_PERMISSIONS, type Role } from "@/lib/actions/permissions";
import { sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { approvalRequest, membership, mcpToken, teamInvite, users } from "@/lib/db/schema";
import { INVITE_ROLES, TEAM, canGrant, inviteTokenHash, needsPassword, lockTeam, ownerCount, revokeTokensCreatedBy, seatsUsed } from "@/lib/team/rules";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const ROLES = ["owner", "admin", "support", "traffic", "reader"] as const satisfies readonly Role[];

async function newUser(label = "u"): Promise<string> {
  const [u] = await t.ownerDb
    .insert(users)
    .values({ email: `${label}-${randomUUID()}@example.com`, name: label, passwordHash: "x" })
    .returning({ id: users.id });
  return u!.id;
}

describe("constantes", () => {
  test("TEAM e INVITE_ROLES", () => {
    expect(TEAM).toEqual({
      inviteDays: 7,
      maxPending: 20,
      maxSeats: 50,
      invitesPerDay: 30,
      resendGapSec: 120,
      maxSends: 5,
      acceptPerIp: 10,
      acceptPerInvite: 10,
      inviteInfoPerIp: 60,
      acceptWindowSec: 900,
      retentionDays: 30,
    });
    expect([...INVITE_ROLES]).toEqual(["admin", "support", "traffic"]);
  });

  test("inviteTokenHash é o sha256 do token", () => {
    const token = ["inv", "abc"].join("_");
    expect(inviteTokenHash(token)).toBe(sha256(token));
  });
});

describe("canGrant", () => {
  // Esperado: as permissões do papel-alvo cabem nas do ator.
  const expected: Record<Role, Record<Role, boolean>> = {
    owner: { owner: true, admin: true, support: true, traffic: true, reader: true },
    admin: { owner: false, admin: true, support: true, traffic: true, reader: true },
    support: { owner: false, admin: false, support: true, traffic: false, reader: false },
    traffic: { owner: false, admin: false, support: false, traffic: true, reader: true },
    reader: { owner: false, admin: false, support: false, traffic: false, reader: true },
  };
  for (const actor of ROLES) {
    for (const target of ROLES) {
      test(`${actor} -> ${target}: ${expected[actor][target]}`, () => {
        expect(canGrant(actor, target)).toBe(expected[actor][target]);
      });
    }
  }

  test("é exatamente a contenção de permissões", () => {
    for (const a of ROLES) for (const b of ROLES) expect(canGrant(a, b)).toBe(ROLE_PERMISSIONS[b].every((p) => ROLE_PERMISSIONS[a].includes(p)));
  });
});

describe("needsPassword", () => {
  test("promover a Dono ou Administrador (ou convidar como Administrador) pede; o resto não", () => {
    const MEMBER: Role[] = ["owner", "admin", "support", "traffic"];
    const asks: string[] = [];
    for (const to of MEMBER) {
      if (needsPassword(null, to)) asks.push(`convite->${to}`);
      for (const from of MEMBER) if (needsPassword(from, to)) asks.push(`${from}->${to}`);
    }
    expect(asks.sort()).toEqual(
      ["admin->owner", "convite->admin", "convite->owner", "support->admin", "support->owner", "traffic->admin", "traffic->owner"].sort(),
    );
  });
});

describe("lockTeam", () => {
  test("lock tomado na mesma loja, livre em outra", async () => {
    const { storeId } = await seedStore("Lock A");
    const { storeId: other } = await seedStore("Lock B");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const first = withStore(storeId, async (tx) => {
      await lockTeam(tx, storeId);
      held();
      await gate;
    });
    const tryLock = (id: string) =>
      withStore(id, async (tx) => {
        const r = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${"team:" + storeId})) as ok`);
        return r[0]!.ok;
      });
    try {
      await holding;
      // Outra loja passa direto.
      await withStore(other, (tx) => lockTeam(tx, other));
      // Mesma loja: o lock está tomado (try-lock por fora enxerga isso).
      expect(await tryLock(storeId)).toBe(false);
      release();
      await first;
      expect(await tryLock(storeId)).toBe(true);
    } finally {
      release();
      await first;
    }
  });
});

describe("ownerCount e seatsUsed", () => {
  test("conta donos e membros da loja, e convites pending no prazo (vencido não conta)", async () => {
    const { storeId } = await seedStore("Assentos");
    const { storeId: other } = await seedStore("Assentos B");
    const [o1, o2, a1] = [await newUser("o1"), await newUser("o2"), await newUser("a1")];
    await t.ownerDb.insert(membership).values([
      { userId: o1, storeId, role: "owner" },
      { userId: o2, storeId, role: "owner" },
      { userId: a1, storeId, role: "admin" },
      { userId: o1, storeId: other, role: "owner" },
    ]);
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    const invite = (email: string, expiresAt: Date, status = "pending") => ({
      storeId,
      email: status === "pending" ? email : null,
      emailHash: sha256(email),
      role: "support",
      tokenHash: sha256(randomUUID()),
      status,
      expiresAt,
      endedAt: status === "pending" ? null : new Date(),
    });
    await t.ownerDb.insert(teamInvite).values([
      invite("a@example.com", future),
      invite("b@example.com", future),
      invite("vencido@example.com", past),
      invite("revogado@example.com", future, "revoked"),
    ]);
    expect(await withStore(storeId, (tx) => ownerCount(tx, storeId))).toBe(2);
    expect(await withStore(other, (tx) => ownerCount(tx, other))).toBe(1);
    // Convite pendente de outra loja não muda a contagem da loja testada.
    await t.ownerDb.insert(teamInvite).values({ ...invite("fora@example.com", future), storeId: other });
    // 3 membros + 2 convites no prazo.
    expect(await withStore(storeId, (tx) => seatsUsed(tx, storeId))).toBe(5);
    // Convite que vence depois de gravado deixa de contar (data alterada no banco).
    await t.ownerDb.update(teamInvite).set({ expiresAt: past }).where(eq(teamInvite.emailHash, sha256("a@example.com")));
    expect(await withStore(storeId, (tx) => seatsUsed(tx, storeId))).toBe(4);
  });
});

describe("revokeTokensCreatedBy", () => {
  async function tokenOf(storeId: string, createdBy: string | null, name: string): Promise<string> {
    const [row] = await t.ownerDb
      .insert(mcpToken)
      .values({ storeId, name, role: "owner", tokenHash: sha256(randomUUID()), last4: "abcd", createdBy })
      .returning({ id: mcpToken.id });
    return row!.id;
  }
  async function pendingOf(storeId: string, tokenId: string) {
    const [row] = await t.ownerDb
      .insert(approvalRequest)
      .values({
        storeId,
        tokenId,
        action: "products.update",
        inputSealed: "selado",
        inputSha256: sha256(randomUUID()),
        summary: {},
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: approvalRequest.id });
    return row!.id;
  }

  test("revoga só os tokens do usuário na loja e cancela os pedidos pendentes deles", async () => {
    const { storeId } = await seedStore("Revoga");
    const { storeId: other } = await seedStore("Revoga B");
    const [u, v] = [await newUser("u"), await newUser("v")];
    const mine1 = await tokenOf(storeId, u, "meu 1");
    const mine2 = await tokenOf(storeId, u, "meu 2");
    const theirs = await tokenOf(storeId, v, "do outro");
    const noOwner = await tokenOf(storeId, null, "sem criador");
    const otherStore = await tokenOf(other, u, "outra loja");
    const pMine = await pendingOf(storeId, mine1);
    const pTheirs = await pendingOf(storeId, theirs);
    const pOther = await pendingOf(other, otherStore);

    // Transação da loja A com o storeId da loja B: 0 (filtro explícito, não só o RLS) e nada é revogado.
    expect(await withStore(storeId, (tx) => revokeTokensCreatedBy(tx, other, u))).toBe(0);
    expect((await t.ownerDb.select({ r: mcpToken.revokedAt }).from(mcpToken).where(eq(mcpToken.id, otherStore)))[0]!.r).toBeNull();

    const n = await withStore(storeId, (tx) => revokeTokensCreatedBy(tx, storeId, u));
    expect(n).toBe(2);

    const tokens = await t.ownerDb.select({ id: mcpToken.id, revokedAt: mcpToken.revokedAt }).from(mcpToken);
    const revoked = (id: string) => tokens.find((x) => x.id === id)!.revokedAt !== null;
    expect(revoked(mine1)).toBe(true);
    expect(revoked(mine2)).toBe(true);
    expect(revoked(theirs)).toBe(false);
    expect(revoked(noOwner)).toBe(false);
    expect(revoked(otherStore)).toBe(false);

    const reqs = await t.ownerDb.select().from(approvalRequest);
    const req = (id: string) => reqs.find((x) => x.id === id)!;
    expect(req(pMine).status).toBe("canceled");
    expect(req(pMine).inputSealed).toBeNull();
    expect(req(pMine).decidedAt).not.toBeNull();
    expect(req(pTheirs).status).toBe("pending");
    expect(req(pOther).status).toBe("pending");

    // Segunda chamada: nada novo a revogar.
    expect(await withStore(storeId, (tx) => revokeTokensCreatedBy(tx, storeId, u))).toBe(0);
  });
});
