// Tabela `team_invite` (convites da equipe): isolamento por loja (RLS) e restrições do banco (um convite pendente por
// e-mail na loja, e-mail só enquanto pendente, papel sem `owner`). Só o sha256 do e-mail e do token é guardado.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ActionError, runAction, type Actor } from "@/lib/actions/core";
import { listTeam } from "@/lib/auth/account";
import { withStore } from "@/lib/db/client";
import { auditLog, emailLog, integration, membership, rateLimit, teamInvite, users } from "@/lib/db/schema";
import { sha256 } from "@/lib/crypto";
import { saveSmtp, setMailTransportForTests, type SentMail } from "@/lib/delivery/mailer";
import { inviteMember, inviteStatus, resendInvite, revokeInvite, sweepInvites } from "@/lib/team/invites";
import { TEAM, inviteTokenHash } from "@/lib/team/rules";
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

// ---- Convidar, reenviar, revogar (team.invite, team.resendInvite, team.revokeInvite, team.inviteStatus) ---------------

describe("convites por e-mail", () => {
  let outbox: SentMail[] = [];
  let sendError: Error | null = null;
  const fakeSmtp = () =>
    setMailTransportForTests(() => ({
      async verify() {
        return true;
      },
      async sendMail(m) {
        if (sendError) throw sendError;
        outbox.push(m);
        return {};
      },
      close() {},
    }));
  beforeAll(fakeSmtp);
  afterEach(() => {
    outbox = [];
    sendError = null;
    fakeSmtp();
  });
  afterAll(() => setMailTransportForTests());

  const SMTP = { host: "smtp.exemplo.com", port: 587, secure: false, user: "loja@exemplo.com", password: "senha-smtp-de-teste", from: "contato@loja.com" };
  type UserActor = Extract<Actor, { kind: "user" }>;
  const MINUTE_MS = 60_000;
  let n = 0;

  async function newUser(storeId: string, role: "owner" | "admin" | "support" | "traffic"): Promise<{ userId: string; email: string; actor: UserActor }> {
    const email = `membro${++n}-${randomBytes(3).toString("hex")}@example.com`;
    const [u] = await t.ownerDb.insert(users).values({ email, name: `Pessoa ${n}`, passwordHash: "x" }).returning({ id: users.id });
    await t.ownerDb.insert(membership).values({ userId: u!.id, storeId, role });
    return { userId: u!.id, email, actor: { kind: "user", userId: u!.id, role } };
  }

  /** Loja com um dono e, salvo `smtp: false`, o SMTP (falso) conectado. */
  async function shop(o: { smtp?: boolean } = {}) {
    const { storeId } = await seedStore("Maná Kids");
    const owner = await newUser(storeId, "owner");
    const call = { storeId, actor: owner.actor, origin: "panel" as const };
    if (o.smtp !== false) await runAction(saveSmtp, call, SMTP);
    return { storeId, owner, call };
  }

  const newEmail = () => `convidado${++n}-${randomBytes(3).toString("hex")}@example.com`;
  const rowsOf = (storeId: string) => t.ownerDb.select().from(teamInvite).where(eq(teamInvite.storeId, storeId));
  const rowOf = async (id: string) => (await t.ownerDb.select().from(teamInvite).where(eq(teamInvite.id, id)))[0]!;
  const failure = async (p: Promise<unknown>): Promise<ActionError> => {
    const e = await p.then(() => null, (x: unknown) => x);
    if (!(e instanceof ActionError)) throw new Error("esperava um ActionError");
    return e;
  };
  /** Token do link do último e-mail enviado (só em memória do teste). */
  const tokenOf = (m: SentMail): string => /\/admin\/convite\/([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
  /** As três ações por id de convite, para conferir a mesma recusa em todas. */
  const byId = (c: Parameters<typeof runAction>[1], inviteId: string): Array<() => Promise<unknown>> => [
    () => runAction(resendInvite, c, { inviteId }),
    () => runAction(revokeInvite, c, { inviteId }),
    () => runAction(inviteStatus, c, { inviteId }),
  ];
  /**
   * Fixa o contador diário da loja no máximo na janela de agora e na seguinte (janela fixa de 24 h alinhada ao UTC, como
   * `windowStart` em ratelimit.ts): o resultado é o mesmo de qualquer lado da meia-noite. Grava direto na tabela: passar uma
   * data futura a `checkRateLimit` dispararia a limpeza aleatória, que apaga a janela de hoje.
   */
  async function fillDailyLimit(storeId: string): Promise<void> {
    const key = `team:invite:${storeId}`;
    const windowMs = 86_400_000;
    const current = Math.floor(Date.now() / windowMs) * windowMs;
    for (const start of [current, current + windowMs]) {
      await t.ownerDb
        .insert(rateLimit)
        .values({ key, windowStart: new Date(start), count: TEAM.invitesPerDay })
        .onConflictDoUpdate({ target: [rateLimit.key, rateLimit.windowStart], set: { count: TEAM.invitesPerDay } });
    }
  }
  const ago = (ms: number) => new Date(Date.now() - ms);

  test("o convite chega com o link e o token do link bate com o token_hash", async () => {
    const { storeId, call } = await shop();
    const email = newEmail();
    const out = await runAction(inviteMember, call, { email: `  ${email.toUpperCase()} `, role: "support" });
    expect(Object.keys(out)).toEqual(["inviteId"]);

    expect(outbox).toHaveLength(1);
    const mail = outbox[0]!;
    expect(mail.to).toBe(email);
    expect(mail.subject).toMatch(/^Pessoa \d+ convidou você para a equipe da Maná Kids$/);
    expect(mail.text).toContain("como Atendimento");
    const token = tokenOf(mail);
    expect(token.startsWith("inv" + "_")).toBe(true);
    expect(mail.html).toContain(`/admin/convite/${token}`);

    const [row] = await rowsOf(storeId);
    expect(row).toMatchObject({ id: out.inviteId, status: "pending", role: "support", email, emailHash: sha256(email), tokenHash: inviteTokenHash(token), sendStatus: "sent", sendError: null, sendCount: 1 });
    expect(row!.lastSentAt).not.toBeNull();
    expect(row!.endedAt).toBeNull();
    const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(TEAM.inviteDays - 0.01);
    expect(days).toBeLessThanOrEqual(TEAM.inviteDays);
  });

  test("a saída, o audit_log e o log não contêm o e-mail nem o token", async () => {
    const { storeId, call } = await shop();
    const email = newEmail();
    const out: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(((s: string) => void out.push(String(s))) as never);
    let result: unknown;
    try {
      result = await runAction(inviteMember, call, { email, role: "traffic" });
      // Uma recusa também passa pela auditoria de falha e pelo log.
      await failure(runAction(inviteMember, call, { email, role: "traffic" }));
    } finally {
      write.mockRestore();
    }
    const token = tokenOf(outbox[0]!);
    const audit = await t.ownerDb.select().from(auditLog).where(and(eq(auditLog.storeId, storeId), eq(auditLog.action, "team.invite")));
    expect(audit).toHaveLength(2);
    const ok = audit.find((a) => a.ok)!;
    expect(ok.input).toEqual({ role: "traffic", emailHash: sha256(email), result: { inviteId: (result as { inviteId: string }).inviteId } });
    const everything = JSON.stringify([result, audit]) + out.join("");
    for (const secret of [email, email.split("@")[0]!, token]) expect(everything).not.toContain(secret);
    const local = (await t.ownerDb.select().from(emailLog).where(eq(emailLog.storeId, storeId))).map((r) => JSON.stringify(r)).join("");
    for (const secret of [email, token]) expect(local).not.toContain(secret);
  });

  test("email_log com team_invite e to_hash (sem o e-mail)", async () => {
    const { storeId, call } = await shop();
    const email = newEmail();
    await runAction(inviteMember, call, { email, role: "admin" });
    const logs = await t.ownerDb.select().from(emailLog).where(eq(emailLog.storeId, storeId));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: "team_invite", status: "sent", toHash: sha256(email), error: null, provider: "smtp" });
  });

  test("sem e-mail conectado: invalid_input com o caminho do e-mail; nada gravado nem enviado", async () => {
    const { storeId, call } = await shop({ smtp: false });
    const e = await failure(runAction(inviteMember, call, { email: newEmail(), role: "support" }));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toBe("Para convidar alguém, conecte o e-mail da loja em Conexões");
    expect(e.details).toEqual([expect.objectContaining({ path: ["email"], message: e.message })]);
    expect(await rowsOf(storeId)).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  test("já é membro: conflict (sem diferenciar maiúsculas); convite pendente: conflict", async () => {
    const { storeId, call, owner } = await shop();
    const m = await newUser(storeId, "support");
    const member = await failure(runAction(inviteMember, call, { email: ` ${m.email.toUpperCase()} `, role: "admin" }));
    expect([member.code, member.message]).toEqual(["conflict", "Essa pessoa já faz parte da equipe"]);
    const self = await failure(runAction(inviteMember, call, { email: owner.email, role: "admin" }));
    expect(self.code).toBe("conflict");

    const email = newEmail();
    await runAction(inviteMember, call, { email, role: "support" });
    const dup = await failure(runAction(inviteMember, call, { email: email.toUpperCase(), role: "traffic" }));
    expect([dup.code, dup.message]).toEqual(["conflict", "Já existe um convite para esse e-mail. Use Reenviar"]);
    expect(await rowsOf(storeId)).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  test("21º convite pendente recusado (conflict com o limite)", async () => {
    const { storeId, call } = await shop();
    await t.ownerDb.insert(teamInvite).values(Array.from({ length: TEAM.maxPending }, () => invite(storeId)));
    const e = await failure(runAction(inviteMember, call, { email: newEmail(), role: "support" }));
    expect(e.code).toBe("conflict");
    expect(e.message).toContain(String(TEAM.maxPending));
    expect(outbox).toHaveLength(0);
  });

  test("51º assento recusado: membros mais convites pendentes", async () => {
    const { storeId, call } = await shop();
    // 1 dono + 30 membros + 19 pendentes = 50 assentos (abaixo do limite de 20 pendentes).
    for (let i = 0; i < 30; i++) await newUser(storeId, "support");
    await t.ownerDb.insert(teamInvite).values(Array.from({ length: 19 }, () => invite(storeId)));
    const e = await failure(runAction(inviteMember, call, { email: newEmail(), role: "support" }));
    expect(e.code).toBe("conflict");
    expect(e.message).toContain(String(TEAM.maxSeats));
    expect(outbox).toHaveLength(0);
    // Um assento a menos (convite revogado) e o convite passa.
    const [one] = await rowsOf(storeId);
    await t.ownerDb.update(teamInvite).set({ status: "revoked", email: null, endedAt: new Date() }).where(eq(teamInvite.id, one!.id));
    await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    expect(outbox).toHaveLength(1);
  });

  test("31º e-mail de convite do dia recusado (rate_limited), sem gravar nem enviar", async () => {
    const { storeId, call } = await shop();
    await fillDailyLimit(storeId);
    const e = await failure(runAction(inviteMember, call, { email: newEmail(), role: "support" }));
    expect(e.code).toBe("rate_limited");
    expect(await rowsOf(storeId)).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  test("SMTP fora: send_status failed, inviteStatus devolve o motivo (sem o e-mail) e Reenviar depois de 2 min envia", async () => {
    const { storeId, call } = await shop();
    const email = newEmail();
    sendError = new Error(`550 5.1.1 <${email}>: usuário desconhecido`);
    const out: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(((s: string) => void out.push(String(s))) as never);
    let inviteId: string;
    try {
      ({ inviteId } = await runAction(inviteMember, call, { email, role: "support" }));
    } finally {
      write.mockRestore();
    }
    expect(out.join("")).not.toContain(email);
    expect(outbox).toHaveLength(0);

    const failed = await rowOf(inviteId);
    expect(failed).toMatchObject({ status: "pending", sendStatus: "failed", sendCount: 1 });
    expect(failed.sendError).toBeTruthy();
    expect(failed.sendError!.length).toBeLessThanOrEqual(500);
    expect(failed.sendError).not.toContain(email);
    expect(await runAction(inviteStatus, call, { inviteId })).toEqual({ sendStatus: "failed", sendError: failed.sendError });
    const logs = await t.ownerDb.select().from(emailLog).where(eq(emailLog.storeId, storeId));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: "team_invite", status: "failed", toHash: sha256(email) });
    expect(logs[0]!.error).not.toContain(email);

    // Dentro dos 2 minutos: recusado. Depois deles (data alterada no banco): envia.
    sendError = null;
    expect((await failure(runAction(resendInvite, call, { inviteId }))).code).toBe("rate_limited");
    await t.ownerDb.update(teamInvite).set({ lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    await runAction(resendInvite, call, { inviteId });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(email);
    expect(await rowOf(inviteId)).toMatchObject({ sendStatus: "sent", sendError: null, sendCount: 2 });
    expect(await runAction(inviteStatus, call, { inviteId })).toEqual({ sendStatus: "sent", sendError: null });
  });

  test("reenviar antes de 2 min dá rate_limited e não troca o link", async () => {
    const { call } = await shop();
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    const before = await rowOf(inviteId);
    const e = await failure(runAction(resendInvite, call, { inviteId }));
    expect(e.code).toBe("rate_limited");
    expect(outbox).toHaveLength(1);
    expect((await rowOf(inviteId)).tokenHash).toBe(before.tokenHash);
  });

  test("reenviar mata o link antigo: o hash antigo some e o novo vem no e-mail novo", async () => {
    const { call } = await shop();
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    const oldToken = tokenOf(outbox[0]!);
    await t.ownerDb.update(teamInvite).set({ lastSentAt: ago(3 * MINUTE_MS), expiresAt: new Date(Date.now() + 60 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    await runAction(resendInvite, call, { inviteId });
    expect(outbox).toHaveLength(2);
    const newToken = tokenOf(outbox[1]!);
    expect(newToken).not.toBe(oldToken);
    const rows = await t.ownerDb.select().from(teamInvite).where(eq(teamInvite.tokenHash, inviteTokenHash(oldToken)));
    expect(rows).toHaveLength(0);
    const row = await rowOf(inviteId);
    expect(row.tokenHash).toBe(inviteTokenHash(newToken));
    // A validade volta a 7 dias a partir do reenvio.
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan((TEAM.inviteDays - 1) * 86_400_000);
    expect(row.sendCount).toBe(2);
  });

  test("reenvio também conta no limite diário: com o contador cheio, rate_limited", async () => {
    const { storeId, call } = await shop();
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    await t.ownerDb.update(teamInvite).set({ lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    const before = await rowOf(inviteId);
    await fillDailyLimit(storeId);
    expect((await failure(runAction(resendInvite, call, { inviteId }))).code).toBe("rate_limited");
    expect(outbox).toHaveLength(1);
    expect(await rowOf(inviteId)).toMatchObject({ tokenHash: before.tokenHash, sendCount: 1 });
  });

  test("reenviar sem e-mail conectado: invalid_input, sem trocar o link", async () => {
    const { storeId, call } = await shop();
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    await t.ownerDb.update(teamInvite).set({ lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    const before = await rowOf(inviteId);
    await t.ownerDb.delete(integration).where(and(eq(integration.storeId, storeId), eq(integration.kind, "smtp")));
    const e = await failure(runAction(resendInvite, call, { inviteId }));
    expect(e.code).toBe("invalid_input");
    expect(e.details).toEqual([expect.objectContaining({ path: ["email"], message: e.message })]);
    expect((await rowOf(inviteId)).tokenHash).toBe(before.tokenHash);
    expect(outbox).toHaveLength(1);
  });

  test("dois reenvios em paralelo: um passa e o outro dá rate_limited (o envio é reservado sob o lock)", async () => {
    const { call } = await shop();
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    await t.ownerDb.update(teamInvite).set({ lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    const results = await Promise.allSettled([runAction(resendInvite, call, { inviteId }), runAction(resendInvite, call, { inviteId })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as ActionError).code).toBe("rate_limited");
    expect(outbox).toHaveLength(2);
    expect(await rowOf(inviteId)).toMatchObject({ sendCount: 2, sendStatus: "sent" });
  });

  test("reenvio zera o resultado do envio anterior até o novo e-mail sair", async () => {
    const { call } = await shop();
    sendError = new Error("recusado");
    const quiet = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    let inviteId: string;
    try {
      ({ inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" }));
    } finally {
      quiet.mockRestore();
    }
    expect((await rowOf(inviteId)).sendStatus).toBe("failed");
    await t.ownerDb.update(teamInvite).set({ lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    sendError = null;
    await runAction(resendInvite, call, { inviteId });
    expect(await rowOf(inviteId)).toMatchObject({ sendStatus: "sent", sendError: null });
  });

  test("texto livre do provedor (parte local do e-mail) não chega a send_error, ao log nem ao email_log", async () => {
    const { storeId, call } = await shop();
    const local = `joao.silva${++n}x${randomBytes(2).toString("hex")}`;
    const email = `${local}@example.com`;
    sendError = new Error(`Mailbox "${local}" does not exist`);
    const out: string[] = [];
    const write = spyOn(process.stdout, "write").mockImplementation(((s: string) => void out.push(String(s))) as never);
    try {
      await runAction(inviteMember, call, { email, role: "support" });
    } finally {
      write.mockRestore();
    }
    const [row] = await rowsOf(storeId);
    expect(row).toMatchObject({ sendStatus: "failed", sendError: "Não foi possível enviar o e-mail", sendCount: 1 });
    const logs = await t.ownerDb.select().from(emailLog).where(eq(emailLog.storeId, storeId));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.error).toBe("Não foi possível enviar o e-mail");
    for (const text of [row!.sendError!, JSON.stringify(logs), out.join("")]) {
      expect(text).not.toContain(local);
      expect(text).not.toContain("does not exist");
    }
    expect(out.join("")).toContain("falha no envio do e-mail");
  });

  test("reenvio: no máximo 5 envios por convite", async () => {
    const { call } = await shop();
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    await t.ownerDb.update(teamInvite).set({ sendCount: TEAM.maxSends - 1, lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    await runAction(resendInvite, call, { inviteId });
    expect((await rowOf(inviteId)).sendCount).toBe(TEAM.maxSends);
    await t.ownerDb.update(teamInvite).set({ lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    expect((await failure(runAction(resendInvite, call, { inviteId }))).code).toBe("rate_limited");
    expect(outbox).toHaveLength(2);
  });

  test("reenviar convite vencido: conflict; o convite passa a expired sem e-mail e libera um novo convite", async () => {
    const { storeId, call } = await shop();
    const email = newEmail();
    const { inviteId } = await runAction(inviteMember, call, { email, role: "support" });
    await t.ownerDb.update(teamInvite).set({ expiresAt: ago(MINUTE_MS), lastSentAt: ago(3 * MINUTE_MS) }).where(eq(teamInvite.id, inviteId));
    const e = await failure(runAction(resendInvite, call, { inviteId }));
    expect([e.code, e.message]).toEqual(["conflict", "Este convite venceu. Convide de novo"]);
    const row = await rowOf(inviteId);
    expect(row).toMatchObject({ status: "expired", email: null });
    expect(row.endedAt).not.toBeNull();
    expect(outbox).toHaveLength(1);
    // O mesmo e-mail pode ser convidado de novo.
    await runAction(inviteMember, call, { email, role: "traffic" });
    expect((await rowsOf(storeId)).filter((r) => r.status === "pending")).toHaveLength(1);
  });

  test("convite vencido não segura o e-mail nem ocupa vaga ao convidar de novo", async () => {
    const { storeId, call } = await shop();
    const email = newEmail();
    await t.ownerDb.insert(teamInvite).values(invite(storeId, { email, expiresAt: ago(MINUTE_MS) }));
    await runAction(inviteMember, call, { email, role: "support" });
    const rows = await rowsOf(storeId);
    expect(rows.map((r) => r.status).sort()).toEqual(["expired", "pending"]);
    expect(rows.find((r) => r.status === "expired")!.email).toBeNull();
  });

  test("revogar apaga o e-mail e encerra o convite; não dá para reenviar nem revogar de novo", async () => {
    const { call } = await shop();
    const email = newEmail();
    const { inviteId } = await runAction(inviteMember, call, { email, role: "support" });
    expect(await runAction(revokeInvite, call, { inviteId })).toEqual({ inviteId });
    const row = await rowOf(inviteId);
    expect(row).toMatchObject({ status: "revoked", email: null, emailHash: sha256(email) });
    expect(row.endedAt).not.toBeNull();
    expect((await failure(runAction(resendInvite, call, { inviteId }))).code).toBe("conflict");
    expect((await failure(runAction(revokeInvite, call, { inviteId }))).code).toBe("conflict");
    expect((await failure(runAction(revokeInvite, call, { inviteId: crypto.randomUUID() }))).code).toBe("not_found");
  });

  test("convite de outra loja: not_found", async () => {
    const a = await shop();
    const b = await shop();
    const { inviteId } = await runAction(inviteMember, a.call, { email: newEmail(), role: "support" });
    for (const p of byId(b.call, inviteId)) expect((await failure(p())).code).toBe("not_found");
  });

  test("role owner dá invalid_input (P1)", async () => {
    const { storeId, call } = await shop();
    const e = await failure(runAction(inviteMember, call, { email: newEmail(), role: "owner" }));
    expect(e.code).toBe("invalid_input");
    expect(await rowsOf(storeId)).toHaveLength(0);
  });

  test("papel admin chamando: forbidden em todas as ações", async () => {
    const { storeId, call } = await shop();
    const admin = await newUser(storeId, "admin");
    const asAdmin = { ...call, actor: admin.actor };
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    expect((await failure(runAction(inviteMember, asAdmin, { email: newEmail(), role: "support" }))).code).toBe("forbidden");
    for (const p of byId(asAdmin, inviteId)) expect((await failure(p())).code).toBe("forbidden");
    expect((await rowOf(inviteId)).status).toBe("pending");
  });

  test("dono já rebaixado (o ator ainda diz owner): forbidden em convidar, reenviar e revogar", async () => {
    const { storeId, call, owner } = await shop();
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    await newUser(storeId, "owner");
    // Rebaixado por fora (a sessão foi lida antes): o papel relido sob o lock é que vale.
    await t.ownerDb.update(membership).set({ role: "admin" }).where(and(eq(membership.storeId, storeId), eq(membership.userId, owner.userId)));
    expect((await failure(runAction(inviteMember, call, { email: newEmail(), role: "support" }))).code).toBe("forbidden");
    expect((await failure(runAction(resendInvite, call, { inviteId }))).code).toBe("forbidden");
    expect((await failure(runAction(revokeInvite, call, { inviteId }))).code).toBe("forbidden");
    expect(await rowsOf(storeId)).toHaveLength(1);
    expect((await rowOf(inviteId)).status).toBe("pending");
  });

  test("token MCP (mesmo com papel owner) chamando: forbidden", async () => {
    const { storeId, call } = await shop();
    const tokenCall = { storeId, actor: { kind: "token", tokenId: crypto.randomUUID(), role: "owner" } as Actor, origin: "mcp" as const };
    const { inviteId } = await runAction(inviteMember, call, { email: newEmail(), role: "support" });
    expect((await failure(runAction(inviteMember, tokenCall, { email: newEmail(), role: "support" }))).code).toBe("forbidden");
    for (const p of byId(tokenCall, inviteId)) expect((await failure(p())).code).toBe("forbidden");
    expect(outbox).toHaveLength(1);
  });

  test("team.list devolve membros e só os convites pendentes; os vencidos viram expired sem e-mail", async () => {
    const { storeId, call, owner } = await shop();
    const live = newEmail();
    const stale = newEmail();
    const gone = newEmail();
    await runAction(inviteMember, call, { email: live, role: "admin" });
    await t.ownerDb.insert(teamInvite).values(invite(storeId, { email: stale, expiresAt: ago(MINUTE_MS) }));
    const { inviteId: revoked } = await runAction(inviteMember, call, { email: gone, role: "traffic" });
    await runAction(revokeInvite, call, { inviteId: revoked });

    const out = await runAction(listTeam, call, {});
    expect(out.members.map((m) => m.userId)).toEqual([owner.userId]);
    expect(out.invites).toHaveLength(1);
    expect(out.invites[0]).toEqual({
      id: expect.any(String),
      email: live,
      role: "admin",
      expiresAt: expect.any(Date),
      sendStatus: "sent",
      sendError: null,
      lastSentAt: expect.any(Date),
    });
    const [expired] = await t.ownerDb.select().from(teamInvite).where(and(eq(teamInvite.storeId, storeId), eq(teamInvite.emailHash, sha256(stale))));
    expect(expired).toMatchObject({ status: "expired", email: null });
  });

  test("sweepInvites: pendente vencido vira expired sem e-mail; encerrado há 31 dias some e há 29 dias fica", async () => {
    const { storeId } = await shop();
    const DAY = 24 * 60 * MINUTE_MS;
    const now = new Date();
    const stale = newEmail();
    await t.ownerDb.insert(teamInvite).values(invite(storeId, { email: stale, expiresAt: ago(MINUTE_MS) }));
    const [old] = await t.ownerDb
      .insert(teamInvite)
      .values(invite(storeId, { email: null, status: "revoked", endedAt: new Date(now.getTime() - 31 * DAY) }))
      .returning({ id: teamInvite.id });
    const [recent] = await t.ownerDb
      .insert(teamInvite)
      .values(invite(storeId, { email: null, status: "revoked", endedAt: new Date(now.getTime() - 29 * DAY) }))
      .returning({ id: teamInvite.id });

    expect(await sweepInvites(storeId, now)).toEqual({ expired: 1, removed: 1 });

    const rows = await rowsOf(storeId);
    expect(rows.some((r) => r.id === old!.id)).toBe(false);
    expect(rows.some((r) => r.id === recent!.id)).toBe(true);
    const expired = rows.find((r) => r.emailHash === sha256(stale));
    expect(expired).toMatchObject({ status: "expired", email: null });
    expect(expired!.endedAt).toBeInstanceOf(Date);
  });
});
