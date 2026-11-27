// Início do teste pelo app (src/lib/apps/trials.ts): `apps.registerTrial` grava o registro de teste só com hashes do
// e-mail, é idempotente por (loja, conta) mesmo com chamadas simultâneas, enfileira um `StartTrial` e a retenção
// (`sweep_app_trials`) apaga ip/user agent em 7 dias e o teste sem pagamento em 180 dias.
// Nenhum literal com o formato do token: tudo montado em tempo de execução.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { runAction, type Actor } from "@/lib/actions/core";
import { registerTrial, sweepAppTrialsJob, trialEventId } from "@/lib/apps/trials";
import { sha256 } from "@/lib/crypto";
import { withStore } from "@/lib/db/client";
import { appCheckoutSession, appTrial, auditLog, job, mcpToken, orders } from "@/lib/db/schema";
import type { Job } from "@/lib/jobs";
import { MCP_EXCLUDED } from "@/lib/mcp/tools";
import { mintMcpToken } from "@/lib/mcp/tokens";
import { mailboxHash, recoveryEmailHash } from "@/lib/recovery/rules";
import { saveMeta, setMetaFetchForTests } from "@/lib/tracking/meta";
import { POST } from "@/app/api/integracao/v1/testes/route";
import { createTestDb, seedStore, type TestDb } from "./db";
import { createFakeMeta } from "./fakes/meta";
import { seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
const meta = createFakeMeta();
beforeAll(async () => {
  t = await createTestDb();
  setMetaFetchForTests(meta.fetch);
});
afterAll(async () => {
  setMetaFetchForTests();
  await t.drop();
});

const owner: Actor = { kind: "user", userId: randomUUID(), role: "owner" };
const api = (storeId: string) => ({ storeId, actor: { kind: "token", tokenId: randomUUID(), role: "integration" } as Actor, origin: "api" as const });

/** Loja com o Meta conectado (o `StartTrial` só vai para a fila com a conexão). */
async function metaStore(name = "PeticionaAqui") {
  const { storeId } = await seedStore(name);
  await runAction(saveMeta, { storeId, actor: owner, origin: "panel" }, { pixelId: "1234567890123", accessToken: meta.token });
  return storeId;
}

const trialsOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(appTrial));
const startTrialJobs = (storeId: string) =>
  t.ownerDb
    .select()
    .from(job)
    .where(and(eq(job.type, "meta_event"), eq(job.storeId, storeId), sql`${job.payload}->>'event' = 'StartTrial'`));

describe("apps.registerTrial", () => {
  test("grava o teste com email_hash e mailbox_hash (sem o e-mail em claro), origem, fbc do fbclid, ip e user agent", async () => {
    const storeId = await metaStore();
    const email = "Ana.Souza+teste@Gmail.com";
    const before = Date.now();
    const r = await runAction(registerTrial, api(storeId), {
      conta: "tenant-42",
      email,
      nome: "Ana Souza",
      telefone: "11987654321",
      origem: { utm_source: "facebook", utm_campaign: "lancamento", fbclid: "IwAR123", ref: "parceiro", fbp: "fb.1.1700000000000.999" },
      ip: "203.0.113.9",
      user_agent: "Mozilla/5.0 app",
    });
    expect(r.criado).toBe(true);
    const rows = await trialsOf(storeId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(r.id);
    expect(row).toMatchObject({
      account: "tenant-42",
      emailHash: recoveryEmailHash(email),
      mailboxHash: mailboxHash(email),
      firstTouch: { utm_source: "facebook", utm_campaign: "lancamento", fbclid: "IwAR123" },
      ref: "parceiro",
      fbp: "fb.1.1700000000000.999",
      clientIp: "203.0.113.9",
      userAgent: "Mozilla/5.0 app",
      eventId: trialEventId(r.id),
    });
    expect(trialEventId(r.id)).toBe(`trial:${r.id}`);
    expect(row.fbc).toMatch(/^fb\.1\.\d+\.IwAR123$/);
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Nenhuma coluna guarda o e-mail (nem a caixa), o nome ou o telefone em claro.
    const dump = JSON.stringify(row).toLowerCase();
    for (const needle of ["ana.souza", "gmail.com", "ana souza", "987654321"]) expect([needle, dump.includes(needle)]).toEqual([needle, false]);
    // Auditoria só com o hash da conta e do e-mail.
    const [audit] = await withStore(storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "apps.registerTrial")));
    expect(audit!.input).toEqual({ conta_hash: sha256("tenant-42"), emailHash: recoveryEmailHash(email) });
    expect(JSON.stringify(audit).includes("tenant-42")).toBe(false);
    // O job do Meta leva só o id do teste.
    const jobs = await startTrialJobs(storeId);
    expect(jobs.map((j) => j.payload)).toEqual([{ event: "StartTrial", trialId: r.id }]);
  });

  test("event_id do app é usado; fbc enviado prevalece sobre o fbclid", async () => {
    const storeId = await metaStore();
    const r = await runAction(registerTrial, api(storeId), {
      conta: "c-evt",
      email: "b@exemplo.com",
      event_id: "app-evento-0123456789",
      origem: { fbclid: "IwAR9", fbc: "fb.1.1700000000000.dado" },
    });
    const [row] = await trialsOf(storeId);
    expect(row).toMatchObject({ id: r.id, eventId: "app-evento-0123456789", fbc: "fb.1.1700000000000.dado" });
  });

  test("segunda chamada com a mesma conta → criado: false, mesmo id, um só job StartTrial", async () => {
    const storeId = await metaStore();
    const a = await runAction(registerTrial, api(storeId), { conta: "c-1", email: "c@exemplo.com" });
    const b = await runAction(registerTrial, api(storeId), { conta: "c-1", email: "outro@exemplo.com" });
    expect(a.criado).toBe(true);
    expect(b).toEqual({ id: a.id, criado: false });
    expect(await trialsOf(storeId)).toHaveLength(1);
    expect(await startTrialJobs(storeId)).toHaveLength(1);
  });

  test("duas chamadas simultâneas com a mesma conta → um registro, um job", async () => {
    const storeId = await metaStore();
    const results = await Promise.all([0, 1, 2, 3].map(() => runAction(registerTrial, api(storeId), { conta: "c-paralela", email: "d@exemplo.com" })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.criado)).toHaveLength(1);
    expect(await trialsOf(storeId)).toHaveLength(1);
    expect(await startTrialJobs(storeId)).toHaveLength(1);
  });

  test("mesma conta em outra loja é outro teste", async () => {
    const a = await metaStore("Loja A");
    const b = await metaStore("Loja B");
    const ra = await runAction(registerTrial, api(a), { conta: "c-x", email: "e@exemplo.com" });
    const rb = await runAction(registerTrial, api(b), { conta: "c-x", email: "e@exemplo.com" });
    expect(rb.criado).toBe(true);
    expect(rb.id).not.toBe(ra.id);
  });

  test("sem o Meta conectado: grava o teste, sem job e sem guardar ip nem user agent", async () => {
    const { storeId } = await seedStore("Sem Meta");
    await runAction(registerTrial, api(storeId), { conta: "c-sem", email: "f@exemplo.com", ip: "203.0.113.1", user_agent: "UA" });
    const [row] = await trialsOf(storeId);
    expect(row).toMatchObject({ clientIp: null, userAgent: null });
    expect(await startTrialJobs(storeId)).toHaveLength(0);
  });

  test("entrada inválida → invalid_input: iniciado_em no futuro ou com mais de 7 dias, conta vazia ou longa, e-mail, event_id", async () => {
    const storeId = await metaStore();
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const cases: Record<string, unknown> = {
      futuro: { conta: "c", email: "g@exemplo.com", iniciado_em: iso(3_600_000) },
      antigo: { conta: "c", email: "g@exemplo.com", iniciado_em: iso(-8 * 86_400_000) },
      "não é data": { conta: "c", email: "g@exemplo.com", iniciado_em: "ontem" },
      "conta vazia": { conta: "", email: "g@exemplo.com" },
      "conta longa": { conta: "x".repeat(65), email: "g@exemplo.com" },
      "e-mail": { conta: "c", email: "não-é-email" },
      "event_id": { conta: "c", email: "g@exemplo.com", event_id: "curto" },
      "nome curto": { conta: "c", email: "g@exemplo.com", nome: "A" },
      "ip longo": { conta: "c", email: "g@exemplo.com", ip: "1".repeat(65) },
      "utm longa": { conta: "c", email: "g@exemplo.com", origem: { utm_source: "x".repeat(501) } },
    };
    for (const [label, input] of Object.entries(cases)) {
      const code = await runAction(registerTrial, api(storeId), input).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      expect([label, code]).toEqual([label, "invalid_input"]);
    }
    expect(await trialsOf(storeId)).toHaveLength(0);
    // Dentro da janela: aceito e gravado com a data informada.
    const when = new Date(Date.now() - 2 * 86_400_000);
    await runAction(registerTrial, api(storeId), { conta: "c-data", email: "g@exemplo.com", iniciado_em: when.toISOString() });
    expect((await trialsOf(storeId))[0]!.startedAt.toISOString()).toBe(when.toISOString());
  });

  test("só a chave integration: painel (mesmo dono) e token MCP → forbidden; fora do MCP", async () => {
    const storeId = await metaStore();
    await expect(runAction(registerTrial, { storeId, actor: owner, origin: "panel" }, { conta: "c", email: "h@exemplo.com" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      runAction(registerTrial, { storeId, actor: { kind: "token", tokenId: randomUUID(), role: "owner" }, origin: "mcp" }, { conta: "c", email: "h@exemplo.com" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(MCP_EXCLUDED["apps.registerTrial"]).toBeDefined();
  });
});

describe("POST /api/integracao/v1/testes", () => {
  test("201 { id } no primeiro, 200 { id } no repetido; 422 com o campo na entrada inválida", async () => {
    const storeId = await metaStore();
    const { token, hash, last4 } = mintMcpToken(storeId);
    await t.ownerDb.insert(mcpToken).values({ storeId, name: "App", role: "integration", tokenHash: hash, last4 });
    const call = (body: unknown) =>
      POST(new Request("http://localhost:3000/api/integracao/v1/testes", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    const first = await call({ conta: "c-rota", email: "i@exemplo.com" });
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    const again = await call({ conta: "c-rota", email: "i@exemplo.com" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id });
    const bad = await call({ conta: "c-rota" });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ erro: { codigo: "invalid_input", detalhes: [{ campo: "email" }] } });
  });
});

describe("sweep_app_trials", () => {
  const noJob = { id: randomUUID(), storeId: null, type: "sweep_app_trials", payload: {} } as unknown as Job;
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  async function seedTrial(storeId: string, account: string, createdAt: Date) {
    const [row] = await t.ownerDb
      .insert(appTrial)
      .values({
        storeId,
        account,
        emailHash: sha256(account),
        mailboxHash: sha256(account),
        firstTouch: { utm_campaign: "c" },
        fbc: "fb.1.1.x",
        clientIp: "203.0.113.5",
        userAgent: "UA",
        eventId: `trial:${randomUUID()}`,
        startedAt: createdAt,
        createdAt,
      })
      .returning();
    return row!;
  }
  /** Pedido da conta (sessão de pagamento + pedido com `app_account`) no estado pedido. */
  async function seedAppOrder(s: Awaited<ReturnType<typeof seedPanelStore>>, account: string, status: "paid" | "pending" | "refunded") {
    const o = await seedOrder(s, { status });
    const [session] = await t.ownerDb
      .insert(appCheckoutSession)
      .values({ storeId: s.storeId, offerId: s.offerId, account, buyerName: "Teste", buyerEmail: "t@exemplo.com", expiresAt: new Date(), orderId: o.id })
      .returning({ id: appCheckoutSession.id });
    await t.ownerDb.update(orders).set({ appAccount: account, appSessionId: session!.id }).where(eq(orders.id, o.id));
  }

  test("8 dias perde ip/user agent e mantém o resto; 181 dias sem pagamento some; com pedido pago (ou reembolsado) fica", async () => {
    const s = await seedPanelStore("Retenção");
    const recent = await seedTrial(s.storeId, "recente", daysAgo(2));
    const week = await seedTrial(s.storeId, "oito-dias", daysAgo(8));
    const old = await seedTrial(s.storeId, "velho", daysAgo(181));
    const oldPending = await seedTrial(s.storeId, "velho-pendente", daysAgo(181));
    const oldPaid = await seedTrial(s.storeId, "velho-pago", daysAgo(181));
    const oldRefunded = await seedTrial(s.storeId, "velho-reembolsado", daysAgo(181));
    await seedAppOrder(s, "velho-pendente", "pending");
    await seedAppOrder(s, "velho-pago", "paid");
    await seedAppOrder(s, "velho-reembolsado", "refunded");
    // Outra loja com a mesma conta paga não segura o teste desta.
    const other = await seedPanelStore("Outra");
    await seedAppOrder(other, "velho", "paid");

    await sweepAppTrialsJob(noJob, new AbortController().signal);

    const rows = new Map((await trialsOf(s.storeId)).map((r) => [r.id, r]));
    expect(rows.get(recent.id)).toMatchObject({ clientIp: "203.0.113.5", userAgent: "UA" });
    expect(rows.get(week.id)).toMatchObject({ clientIp: null, userAgent: null, fbc: "fb.1.1.x", firstTouch: { utm_campaign: "c" }, emailHash: week.emailHash });
    expect(rows.has(old.id)).toBe(false);
    expect(rows.has(oldPending.id)).toBe(false);
    expect(rows.get(oldPaid.id)).toMatchObject({ clientIp: null, userAgent: null });
    expect(rows.has(oldRefunded.id)).toBe(true);
    // Repetir não muda nada (idempotente).
    await sweepAppTrialsJob(noJob, new AbortController().signal);
    expect((await trialsOf(s.storeId)).length).toBe(rows.size);
  });
});
