// Tabela `team_invite` (convites da equipe): isolamento por loja (RLS) e restrições do banco (um convite pendente por
// e-mail na loja, e-mail só enquanto pendente, papel sem `owner`). Só o sha256 do e-mail e do token é guardado.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { withStore } from "@/lib/db/client";
import { emailLog, teamInvite } from "@/lib/db/schema";
import { sha256 } from "@/lib/crypto";
import { createTestDb, seedStore, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const emailHash = (email: string) => sha256(email.trim().toLowerCase());
const HOUR_MS = 3_600_000;

function invite(storeId: string, over: Partial<typeof teamInvite.$inferInsert> = {}): typeof teamInvite.$inferInsert {
  const email = over.email === undefined ? `convidado-${randomBytes(4).toString("hex")}@example.com` : over.email;
  return {
    storeId,
    email,
    emailHash: emailHash(email ?? "ninguem@example.com"),
    role: "support",
    tokenHash: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 72 * HOUR_MS),
    ...over,
  };
}

/** SQLSTATE e constraint do erro do Postgres (o drizzle o embrulha em `cause`). */
async function pgError(run: () => PromiseLike<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run();
  } catch (e) {
    const c = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint_name?: string };
    return { code: c.code, constraint: c.constraint_name };
  }
  throw new Error("esperava um erro do Postgres");
}

describe("team_invite", () => {
  test("RLS: convite de outra loja não aparece", async () => {
    const a = await seedStore();
    const b = await seedStore();
    await withStore(b.storeId, (tx) => tx.insert(teamInvite).values(invite(b.storeId)));
    expect(await withStore(a.storeId, (tx) => tx.select().from(teamInvite))).toHaveLength(0);
    expect(await withStore(b.storeId, (tx) => tx.select().from(teamInvite))).toHaveLength(1);
  });

  test("segundo convite pendente para o mesmo e-mail na loja recusado (único)", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const email = `dupla-${randomBytes(4).toString("hex")}@example.com`;
    const [first] = await t.ownerDb.insert(teamInvite).values(invite(a.storeId, { email })).returning({ id: teamInvite.id });
    const err = await pgError(() => t.ownerDb.insert(teamInvite).values(invite(a.storeId, { email: ` ${email.toUpperCase()} ` })));
    expect(err).toEqual({ code: "23505", constraint: "team_invite_pending_email_uniq" });
    // Outra loja pode convidar o mesmo e-mail; e, encerrado o primeiro, a mesma loja também.
    await t.ownerDb.insert(teamInvite).values(invite(b.storeId, { email }));
    await t.ownerDb.update(teamInvite).set({ status: "revoked", email: null, endedAt: new Date() }).where(eq(teamInvite.id, first!.id));
    await t.ownerDb.insert(teamInvite).values(invite(a.storeId, { email }));
  });

  test("pendente sem e-mail recusado; aceito com e-mail recusado", async () => {
    const a = await seedStore();
    const pendingNoEmail = await pgError(() => t.ownerDb.insert(teamInvite).values(invite(a.storeId, { email: null })));
    expect(pendingNoEmail).toEqual({ code: "23514", constraint: "team_invite_email_status_check" });
    const acceptedWithEmail = await pgError(() =>
      t.ownerDb.insert(teamInvite).values(invite(a.storeId, { status: "accepted", acceptedAt: new Date(), endedAt: new Date() })),
    );
    expect(acceptedWithEmail).toEqual({ code: "23514", constraint: "team_invite_email_status_check" });
    // Os estados finais sem e-mail são aceitos.
    for (const status of ["accepted", "revoked", "expired"]) {
      await t.ownerDb.insert(teamInvite).values(invite(a.storeId, { email: null, status, endedAt: new Date() }));
    }
  });

  test("encerrado sem ended_at recusado; pendente com ended_at recusado", async () => {
    const a = await seedStore();
    for (const status of ["accepted", "revoked", "expired"]) {
      const err = await pgError(() => t.ownerDb.insert(teamInvite).values(invite(a.storeId, { email: null, status })));
      expect(err, status).toEqual({ code: "23514", constraint: "team_invite_ended_check" });
    }
    const pending = await pgError(() => t.ownerDb.insert(teamInvite).values(invite(a.storeId, { endedAt: new Date() })));
    expect(pending).toEqual({ code: "23514", constraint: "team_invite_ended_check" });
  });

  test("send_error com mais de 500 caracteres recusado; até 500 aceito", async () => {
    const a = await seedStore();
    const err = await pgError(() => t.ownerDb.insert(teamInvite).values(invite(a.storeId, { sendStatus: "failed", sendError: "x".repeat(501) })));
    expect(err).toEqual({ code: "23514", constraint: "team_invite_send_error_check" });
    await t.ownerDb.insert(teamInvite).values(invite(a.storeId, { sendStatus: "failed", sendError: "x".repeat(500) }));
  });

  test("email_log aceita kind team_invite", async () => {
    const a = await seedStore();
    const [row] = await t.ownerDb
      .insert(emailLog)
      .values({ storeId: a.storeId, toHash: emailHash("convidado@example.com"), kind: "team_invite", status: "sent" })
      .returning({ kind: emailLog.kind });
    expect(row!.kind).toBe("team_invite");
  });

  test("role owner recusado pelo check", async () => {
    const a = await seedStore();
    const err = await pgError(() => t.ownerDb.insert(teamInvite).values(invite(a.storeId, { role: "owner" })));
    expect(err).toEqual({ code: "23514", constraint: "team_invite_role_check" });
    for (const role of ["admin", "support", "traffic"]) {
      await t.ownerDb.insert(teamInvite).values(invite(a.storeId, { role }));
    }
  });
});
