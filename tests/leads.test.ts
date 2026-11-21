// Tabela `checkout_lead` (abandono antes de comprar): isolamento por loja (RLS), restrições do banco e as ações públicas
// de captura (`checkout.saveLead`) e de "Não salvar" (`checkout.forgetLead`).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { auditLog, checkoutLead, offer, rateLimit, store } from "@/lib/db/schema";
import { orderCode } from "@/lib/format";
import { LEAD_LIMITS, LEAD_TTL_DAYS, checkoutForgetLead, checkoutSaveLead } from "@/lib/leads/capture";
import { PAGE_SIZE, createSweepLeadsHandler, deleteLead, forgetLeadEmail, listLeads, markLeadContacted, sweepLeadsJob } from "@/lib/leads/panel";
import { leadCode } from "@/lib/notify/telegram";
import { createTestDb, seedStore, type TestDb } from "./db";
import { panelCall, seedOrder, seedPanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

// O log de falha pública (código da ação) é capturado em todo o arquivo: saída limpa e conferência de privacidade.
let stdout: ReturnType<typeof spyOn>;
let out = "";
beforeEach(() => {
  out = "";
  stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => ((out += String(chunk)), true)) as never);
});
afterEach(() => stdout.mockRestore());

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const DAY_MS = 86_400_000;

/** SQLSTATE e constraint do erro do Postgres (o drizzle o embrulha em `cause`). */
async function pgError(run: () => PromiseLike<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await run();
  } catch (e) {
    const err = ((e as { cause?: unknown }).cause ?? e) as { code?: string; constraint_name?: string };
    return { code: err.code, constraint: err.constraint_name };
  }
  return {};
}
const CHECK = "23514";
const UNIQUE = "23505";

async function seedOffer(storeId: string): Promise<string> {
  const [o] = await t.ownerDb
    .insert(offer)
    .values({ storeId, slug: `oferta-${randomUUID()}`, name: "Oferta", priceCents: 990, methods: ["pix"], pixMode: "manual" })
    .returning({ id: offer.id });
  return o!.id;
}

function leadRow(storeId: string, offerId: string, over: Partial<typeof checkoutLead.$inferInsert> = {}): typeof checkoutLead.$inferInsert {
  const email = `contato-${randomUUID()}@example.com`;
  return { storeId, offerId, keyHash: sha(randomUUID()), email, emailHash: sha(email), expiresAt: new Date(Date.now() + 30 * DAY_MS), ...over };
}

describe("checkout_lead", () => {
  test("RLS: contato de outra loja não aparece", async () => {
    const a = await seedStore("Loja A");
    const b = await seedStore("Loja B");
    const offerB = await seedOffer(b.storeId);
    await withStore(b.storeId, (tx) => tx.insert(checkoutLead).values(leadRow(b.storeId, offerB)));

    expect(await withStore(a.storeId, (tx) => tx.select().from(checkoutLead))).toHaveLength(0);
    expect(await withStore(b.storeId, (tx) => tx.select().from(checkoutLead))).toHaveLength(1);
    // gravar com o store_id de outra loja também é recusado
    await expect(withStore(a.storeId, (tx) => tx.insert(checkoutLead).values(leadRow(b.storeId, offerB)))).rejects.toThrow();
  });

  test("check: converted sem e-mail ok, open sem e-mail recusado", async () => {
    const { storeId } = await seedStore("Loja checks");
    const offerId = await seedOffer(storeId);
    const base = leadRow(storeId, offerId);

    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...base, email: null, status: "open" }))).toEqual({ code: CHECK, constraint: "checkout_lead_email_check" });
    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...base, email: null, status: "contacted" }))).toEqual({ code: CHECK, constraint: "checkout_lead_email_check" });
    await t.ownerDb.insert(checkoutLead).values({ ...base, email: null, status: "converted" });
    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...leadRow(storeId, offerId), status: "perdido" }))).toEqual({ code: CHECK, constraint: "checkout_lead_status_check" });
  });

  test("check: converted com e-mail ou celular é recusado pelo banco", async () => {
    const { storeId } = await seedStore("Loja convertido");
    const offerId = await seedOffer(storeId);
    const base = leadRow(storeId, offerId);
    const converted = { code: CHECK, constraint: "checkout_lead_converted_check" };

    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...base, status: "converted" }))).toEqual(converted);
    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values({ ...base, email: null, phone: "11987654321", status: "converted" }))).toEqual(converted);
    // aberto com celular é normal; virar convertido sem limpar os dois é recusado, limpando passa
    const [row] = await t.ownerDb.insert(checkoutLead).values({ ...base, phone: "11987654321" }).returning({ id: checkoutLead.id });
    expect(await pgError(() => t.ownerDb.update(checkoutLead).set({ status: "converted" }).where(eq(checkoutLead.id, row!.id)))).toEqual(converted);
    await t.ownerDb.update(checkoutLead).set({ status: "converted", email: null, phone: null }).where(eq(checkoutLead.id, row!.id));
  });

  test("a chave é única por loja, e apagar a oferta apaga o contato", async () => {
    const a = await seedStore("Loja chave A");
    const b = await seedStore("Loja chave B");
    const offerA = await seedOffer(a.storeId);
    const offerB = await seedOffer(b.storeId);
    const keyHash = sha(randomUUID());
    await t.ownerDb.insert(checkoutLead).values(leadRow(a.storeId, offerA, { keyHash }));
    expect(await pgError(() => t.ownerDb.insert(checkoutLead).values(leadRow(a.storeId, offerA, { keyHash })))).toEqual({ code: UNIQUE, constraint: "checkout_lead_store_key_uniq" });
    await t.ownerDb.insert(checkoutLead).values(leadRow(b.storeId, offerB, { keyHash }));

    await t.ownerDb.delete(offer).where(eq(offer.id, offerA));
    const left = await t.ownerDb.select({ n: sql<number>`count(*)::int` }).from(checkoutLead).where(eq(checkoutLead.storeId, a.storeId));
    expect(left[0]!.n).toBe(0);
  });
});

describe("store: captura de contato", () => {
  test("check da loja: lead_capture sem privacy_email recusado", async () => {
    const { storeId } = await seedStore("Loja captura");
    const [padrao] = await t.ownerDb.select({ on: store.leadCapture, mail: store.privacyEmail }).from(store).where(eq(store.id, storeId));
    expect(padrao).toEqual({ on: false, mail: null });

    expect(await pgError(() => t.ownerDb.update(store).set({ leadCapture: true }).where(eq(store.id, storeId)))).toEqual({ code: CHECK, constraint: "store_lead_capture_check" });
    await t.ownerDb.update(store).set({ leadCapture: true, privacyEmail: "privacidade@example.com" }).where(eq(store.id, storeId));
    // com a captura ligada, não dá para apagar o e-mail de privacidade
    expect(await pgError(() => t.ownerDb.update(store).set({ privacyEmail: null }).where(eq(store.id, storeId)))).toEqual({ code: CHECK, constraint: "store_lead_capture_check" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Ações públicas

const pub = (storeId: string) => ({ storeId, actor: { kind: "public" } as const, origin: "public" as const });
let ipSeq = 0;
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const mail = () => `comprador-${randomUUID()}@example.com`;
const PHONE = "(11) 98765-4321";
const PHONE_DIGITS = "11987654321";

/** Loja com oferta ativa; captura ligada (com e-mail de privacidade) por padrão. */
async function seedCapture(on = true): Promise<{ storeId: string; slug: string; offerId: string }> {
  const { storeId } = await seedStore("Loja captura");
  if (on) await t.ownerDb.update(store).set({ leadCapture: true, privacyEmail: "privacidade@example.com" }).where(eq(store.id, storeId));
  const slug = `oferta-${randomUUID()}`;
  const [o] = await t.ownerDb.insert(offer).values({ storeId, slug, name: "Oferta", priceCents: 990, methods: ["pix"], pixMode: "manual" }).returning({ id: offer.id });
  return { storeId, slug, offerId: o!.id };
}

const rowsOf = (storeId: string) => withStore(storeId, (tx) => tx.select().from(checkoutLead).where(eq(checkoutLead.storeId, storeId)));
const rowByKey = async (storeId: string, leadKey: string) => (await rowsOf(storeId)).find((r) => r.keyHash === sha(leadKey));
const save = (s: { storeId: string; slug: string }, input: Record<string, unknown>) =>
  runAction(checkoutSaveLead, pub(s.storeId), { slug: s.slug, leadKey: randomUUID(), clientIp: nextIp(), ...input });
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof ActionError ? e.code : "erro inesperado"),
  );

describe("constantes", () => {
  test("retenção de 30 dias e os limites combinados", () => {
    expect(LEAD_TTL_DAYS).toBe(30);
    expect(LEAD_LIMITS).toEqual({ newPerIpPerHour: 10, newPerStorePerHour: 500, writesPerKeyPerHour: 20 });
  });
});

describe("checkout.saveLead", () => {
  test("captura desligada: conflict e nenhuma linha", async () => {
    const s = await seedCapture(false);
    expect(await code(save(s, { email: mail() }))).toBe("conflict");
    expect(await rowsOf(s.storeId)).toHaveLength(0);
  });

  test("entrada sem e-mail nem celular, ou com e-mail inválido: invalid_input", async () => {
    const s = await seedCapture();
    expect(await code(save(s, {}))).toBe("invalid_input");
    expect(await code(save(s, { email: "isto-nao-e-email" }))).toBe("invalid_input");
    expect(await code(save(s, { email: mail(), phone: "123" }))).toBe("invalid_input");
    expect(await code(save(s, { email: mail(), leadKey: "nao-e-uuid" }))).toBe("invalid_input");
    expect(await rowsOf(s.storeId)).toHaveLength(0);
  });

  test("oferta inexistente: not_found", async () => {
    const s = await seedCapture();
    expect(await code(save({ ...s, slug: "nao-existe" }, { email: mail() }))).toBe("not_found");
    expect(await rowsOf(s.storeId)).toHaveLength(0);
  });

  test("e-mail válido grava; segundo saveLead da mesma chave com celular atualiza a mesma linha", async () => {
    const s = await seedCapture();
    const leadKey = randomUUID();
    const email = mail();
    const before = Date.now();
    const first = await save(s, { leadKey, email: ` ${email.toUpperCase()} ` });
    expect(first.created).toBe(true);
    const row = (await rowByKey(s.storeId, leadKey))!;
    expect(first.leadId).toBe(row.id);
    expect(row).toMatchObject({ offerId: s.offerId, email, emailHash: sha(email), keyHash: sha(leadKey), phone: null, status: "open", orderId: null, notifiedAt: null });
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(30 * DAY_MS - 1000);
    expect(ttl).toBeLessThanOrEqual(30 * DAY_MS + 60_000);

    const second = await save(s, { leadKey, phone: PHONE });
    expect(second).toEqual({ created: false, leadId: row.id });
    const rows = await rowsOf(s.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row.id, email, phone: PHONE_DIGITS, expiresAt: row.expiresAt });

    // e-mail corrigido na mesma chave: a mesma linha, com o hash novo
    const novo = mail();
    expect((await save(s, { leadKey, email: novo })).created).toBe(false);
    expect((await rowsOf(s.storeId))[0]).toMatchObject({ id: row.id, email: novo, emailHash: sha(novo), phone: PHONE_DIGITS });
  });

  test("celular sem linha existente: nada gravado", async () => {
    const s = await seedCapture();
    expect(await save(s, { phone: PHONE })).toEqual({ created: false, leadId: null });
    expect(await rowsOf(s.storeId)).toHaveLength(0);
  });

  test("outra chave com o mesmo e-mail cria outra linha; chave de outra loja não toca a linha", async () => {
    const a = await seedCapture();
    const b = await seedCapture();
    const email = mail();
    const keyA = randomUUID();
    await save(a, { leadKey: keyA, email });
    await save(a, { leadKey: randomUUID(), email });
    expect(await rowsOf(a.storeId)).toHaveLength(2);

    // a mesma chave na loja B é outra linha (RLS); celular com a chave de A na loja B não encontra nada
    expect(await save(b, { leadKey: keyA, phone: PHONE })).toEqual({ created: false, leadId: null });
    const outro = mail();
    expect((await save(b, { leadKey: keyA, email: outro })).created).toBe(true);
    expect((await rowByKey(a.storeId, keyA))).toMatchObject({ email, phone: null });
    expect((await rowByKey(b.storeId, keyA))).toMatchObject({ email: outro });
  });

  test("linha convertida não muda", async () => {
    const s = await seedCapture();
    const leadKey = randomUUID();
    await t.ownerDb.insert(checkoutLead).values(leadRow(s.storeId, s.offerId, { keyHash: sha(leadKey), email: null, status: "converted" }));
    const out = await save(s, { leadKey, email: mail(), phone: PHONE });
    expect(out.created).toBe(false);
    expect((await rowByKey(s.storeId, leadKey))).toMatchObject({ status: "converted", email: null, phone: null });
  });
});

describe("checkout.forgetLead", () => {
  test("apaga só a linha da chave; chave desconhecida: ok", async () => {
    const s = await seedCapture();
    const outra = await seedCapture();
    const keyA = randomUUID();
    const keyB = randomUUID();
    await save(s, { leadKey: keyA, email: mail() });
    await save(s, { leadKey: keyB, email: mail() });
    await save(outra, { leadKey: keyA, email: mail() });

    await runAction(checkoutForgetLead, pub(s.storeId), { leadKey: keyA });
    expect(await rowByKey(s.storeId, keyA)).toBeUndefined();
    expect(await rowByKey(s.storeId, keyB)).toBeDefined();
    // a chave igual na outra loja continua lá
    expect(await rowByKey(outra.storeId, keyA)).toBeDefined();

    expect(await runAction(checkoutForgetLead, pub(s.storeId), { leadKey: randomUUID() })).toEqual({ ok: true });
    expect(await rowsOf(s.storeId)).toHaveLength(1);
  });

  test("funciona com a captura desligada depois (apagar o que foi guardado) e não apaga convertido", async () => {
    const s = await seedCapture();
    const keyA = randomUUID();
    const keyB = randomUUID();
    await save(s, { leadKey: keyA, email: mail() });
    await t.ownerDb.insert(checkoutLead).values(leadRow(s.storeId, s.offerId, { keyHash: sha(keyB), email: null, status: "converted" }));
    await t.ownerDb.update(store).set({ leadCapture: false }).where(eq(store.id, s.storeId));

    await runAction(checkoutForgetLead, pub(s.storeId), { leadKey: keyA });
    await runAction(checkoutForgetLead, pub(s.storeId), { leadKey: keyB });
    expect(await rowByKey(s.storeId, keyA)).toBeUndefined();
    expect(await rowByKey(s.storeId, keyB)).toMatchObject({ status: "converted" });
  });

  test("entrada inválida: invalid_input", async () => {
    const s = await seedCapture();
    expect(await code(runAction(checkoutForgetLead, pub(s.storeId), { leadKey: "x" }))).toBe("invalid_input");
  });
});

describe("limites da captura", () => {
  test("11º contato novo do mesmo IP na hora: rate_limited e nenhuma linha; atualizar linha existente não conta", async () => {
    const s = await seedCapture();
    const ip = nextIp();
    const first = randomUUID();
    for (let i = 0; i < LEAD_LIMITS.newPerIpPerHour; i++) {
      await save(s, { clientIp: ip, leadKey: i === 0 ? first : randomUUID(), email: mail() });
    }
    expect(await rowsOf(s.storeId)).toHaveLength(10);
    expect(await code(save(s, { clientIp: ip, email: mail() }))).toBe("rate_limited");
    expect(await rowsOf(s.storeId)).toHaveLength(10);
    // gravar de novo numa linha que já existe não é contato novo
    expect(await code(save(s, { clientIp: ip, leadKey: first, phone: PHONE }))).toBe("ok");
    // outro IP segue livre; IP desconhecido não limita por IP
    expect(await code(save(s, { clientIp: nextIp(), email: mail() }))).toBe("ok");
    expect(await code(save(s, { clientIp: "unknown", email: mail() }))).toBe("ok");
    expect(await code(save(s, { clientIp: "unknown", email: mail() }))).toBe("ok");
  });

  test("tentativa recusada (captura desligada) não consome o limite de contatos novos", async () => {
    const s = await seedCapture(false);
    const ip = nextIp();
    for (let i = 0; i < 12; i++) expect(await code(save(s, { clientIp: ip, email: mail() }))).toBe("conflict");
    await t.ownerDb.update(store).set({ leadCapture: true, privacyEmail: "privacidade@example.com" }).where(eq(store.id, s.storeId));
    for (let i = 0; i < LEAD_LIMITS.newPerIpPerHour; i++) expect(await code(save(s, { clientIp: ip, email: mail() }))).toBe("ok");
  });

  test("captura desligada ou oferta inexistente: nenhuma linha em rate_limit (a chave só conta depois de conferir as duas)", async () => {
    const off = await seedCapture(false);
    const on = await seedCapture();
    const keysOf = async (storeId: string) =>
      (await t.ownerDb.select({ key: rateLimit.key }).from(rateLimit).where(sql`${rateLimit.key} like ${"leads:%" + storeId + "%"}`)).map((r) => r.key);
    for (let i = 0; i < 3; i++) expect(await code(save(off, { email: mail() }))).toBe("conflict");
    expect(await code(save(off, { phone: PHONE }))).toBe("conflict");
    expect(await code(save({ ...on, slug: "nao-existe" }, { email: mail() }))).toBe("not_found");
    expect(await keysOf(off.storeId)).toEqual([]);
    expect(await keysOf(on.storeId)).toEqual([]);
  });

  test("rajada simultânea do mesmo IP: só 10 contatos novos passam", async () => {
    const s = await seedCapture();
    const ip = nextIp();
    const codes = await Promise.all(Array.from({ length: 15 }, () => code(save(s, { clientIp: ip, email: mail() }))));
    expect(codes.filter((c) => c === "ok")).toHaveLength(LEAD_LIMITS.newPerIpPerHour);
    expect(codes.filter((c) => c === "rate_limited")).toHaveLength(15 - LEAD_LIMITS.newPerIpPerHour);
    expect(await rowsOf(s.storeId)).toHaveLength(LEAD_LIMITS.newPerIpPerHour);
  });

  test("21ª gravação da mesma chave na hora: rate_limited", async () => {
    const s = await seedCapture();
    const leadKey = randomUUID();
    const ip = nextIp();
    await save(s, { leadKey, clientIp: ip, email: mail() });
    for (let i = 1; i < LEAD_LIMITS.writesPerKeyPerHour; i++) await save(s, { leadKey, clientIp: ip, phone: PHONE });
    expect(await code(save(s, { leadKey, clientIp: ip, phone: PHONE }))).toBe("rate_limited");
    // outra chave não é afetada
    expect(await code(save(s, { clientIp: ip, email: mail() }))).toBe("ok");
  });

  test("teto de contatos novos da loja na hora: rate_limited; outra loja não é afetada", async () => {
    const s = await seedCapture();
    const outra = await seedCapture();
    const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await t.ownerDb.insert(rateLimit).values({ key: `leads:new:store:${s.storeId}`, windowStart, count: LEAD_LIMITS.newPerStorePerHour });
    expect(await code(save(s, { email: mail() }))).toBe("rate_limited");
    expect(await rowsOf(s.storeId)).toHaveLength(0);
    expect(await code(save(outra, { email: mail() }))).toBe("ok");
  });

  test("as chaves do limite nunca levam e-mail, celular nem a chave do visitante em claro", async () => {
    const s = await seedCapture();
    const leadKey = randomUUID();
    const email = mail();
    await save(s, { leadKey, email, phone: PHONE });
    const keys = (await t.ownerDb.select({ key: rateLimit.key }).from(rateLimit).where(sql`${rateLimit.key} like ${"leads:%" + s.storeId + "%"}`)).map((r) => r.key);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const k of keys) {
      expect(k).not.toContain(leadKey);
      expect(k).not.toContain(email);
      expect(k).not.toContain(PHONE_DIGITS);
    }
    expect(keys).toContain(`leads:key:${s.storeId}:${sha(leadKey)}`);
  });
});

describe("privacidade: log e auditoria", () => {
  test("nenhum audit_log nem log com o e-mail, o celular ou a chave", async () => {
    const s = await seedCapture();
    const off = await seedCapture(false);
    const leadKey = randomUUID();
    const email = mail();
    const ip = nextIp();
    await save(s, { leadKey, email, clientIp: ip });
    await save(s, { leadKey, phone: PHONE, clientIp: ip });
    await save(off, { leadKey, email, phone: PHONE }).catch(() => undefined); // conflict: falha pública vai ao log
    await save(s, { leadKey: "nao-e-uuid", email, phone: PHONE }).catch(() => undefined);
    for (let i = 0; i < LEAD_LIMITS.writesPerKeyPerHour; i++) await save(s, { leadKey, phone: PHONE, clientIp: ip }).catch(() => undefined);
    await runAction(checkoutForgetLead, pub(s.storeId), { leadKey });

    const audit = JSON.stringify(await withStore(s.storeId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.storeId, s.storeId)))));
    for (const text of [out, audit, JSON.stringify(await withStore(off.storeId, (tx) => tx.select().from(auditLog)))]) {
      for (const secret of [email, PHONE_DIGITS, "98765", leadKey]) expect(text).not.toContain(secret);
    }
    expect(out).toContain("ação pública falhou");
    expect(JSON.parse(audit)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Ações do painel e varredura

const insertLead = async (s: { storeId: string; offerId: string }, over: Partial<typeof checkoutLead.$inferInsert> = {}) => {
  const [r] = await t.ownerDb.insert(checkoutLead).values(leadRow(s.storeId, s.offerId, over)).returning();
  return r!;
};
const auditOf = (storeId: string) => t.ownerDb.select().from(auditLog).where(eq(auditLog.storeId, storeId));
const leftIds = async (storeId: string) => new Set((await t.ownerDb.select({ id: checkoutLead.id }).from(checkoutLead).where(eq(checkoutLead.storeId, storeId))).map((r) => r.id));

describe("leads.list", () => {
  test("suporte vê e-mail e celular; tráfego → forbidden", async () => {
    const s = await seedCapture();
    const row = await insertLead(s, { phone: PHONE_DIGITS });
    const out = await runAction(listLeads, panelCall(s.storeId, "support"), {});
    expect(out).toMatchObject({ total: 1, page: 1, pageSize: PAGE_SIZE });
    expect(out.items).toEqual([
      { id: row.id, code: leadCode(row.id), createdAt: row.createdAt, status: "open", offerName: "Oferta", email: row.email, phone: PHONE_DIGITS, orderId: null, orderCode: null },
    ]);
    expect(await code(runAction(listLeads, panelCall(s.storeId, "traffic"), {}))).toBe("forbidden");
    expect(await code(runAction(markLeadContacted, panelCall(s.storeId, "traffic"), { id: row.id }))).toBe("forbidden");
    expect(await code(runAction(deleteLead, panelCall(s.storeId, "traffic"), { id: row.id }))).toBe("forbidden");
    expect(await code(runAction(forgetLeadEmail, panelCall(s.storeId, "traffic"), { email: row.email! }))).toBe("forbidden");
    expect((await rowsOf(s.storeId)).length).toBe(1);
  });

  test("50 por página, mais novos primeiro, filtro por status e isolamento por loja", async () => {
    const s = await seedCapture();
    const outra = await seedCapture();
    await insertLead(outra);
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < PAGE_SIZE + 3; i++) await insertLead(s, { createdAt: new Date(base + i * 1000), status: i === 0 ? "contacted" : "open" });
    const p1 = await runAction(listLeads, panelCall(s.storeId), {});
    expect([p1.total, p1.items.length]).toEqual([PAGE_SIZE + 3, PAGE_SIZE]);
    const stamps = p1.items.map((i) => i.createdAt.getTime());
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    const p2 = await runAction(listLeads, panelCall(s.storeId), { page: 2 });
    expect(p2.items).toHaveLength(3);
    expect(p2.items.at(-1)!.status).toBe("contacted");
    const contacted = await runAction(listLeads, panelCall(s.storeId), { status: "contacted" });
    expect([contacted.total, contacted.items.length]).toEqual([1, 1]);
  });

  test("convertido mostra o código do pedido (como o painel) e nenhum contato", async () => {
    const p = await seedPanelStore();
    const order = await seedOrder(p, {});
    const row = await insertLead(p, { email: null, phone: null, status: "converted", orderId: order.id });
    const out = await runAction(listLeads, panelCall(p.storeId), { status: "converted" });
    expect(out.items).toEqual([
      { id: row.id, code: leadCode(row.id), createdAt: row.createdAt, status: "converted", offerName: "Maná bíblico", email: null, phone: null, orderId: order.id, orderCode: orderCode(order.publicId) },
    ]);
  });

  test("busca: código do contato (qualquer caixa) ou e-mail exato, sem busca parcial", async () => {
    const s = await seedCapture();
    const a = await insertLead(s);
    const b = await insertLead(s);
    const byCode = await runAction(listLeads, panelCall(s.storeId), { q: ` ${leadCode(a.id).toLowerCase()} ` });
    expect(byCode.items.map((i) => i.id)).toEqual([a.id]);
    const byMail = await runAction(listLeads, panelCall(s.storeId), { q: ` ${b.email!.toUpperCase()} ` });
    expect(byMail.items.map((i) => i.id)).toEqual([b.id]);
    const partial = await runAction(listLeads, panelCall(s.storeId), { q: b.email!.slice(0, 12) });
    expect(partial.total).toBe(0);
    // outro formato de 6 caracteres não casa como código
    expect((await runAction(listLeads, panelCall(s.storeId), { q: "zzzzzz" })).total).toBe(0);
    // código de contato de outra loja não aparece
    const outra = await seedCapture();
    expect((await runAction(listLeads, panelCall(outra.storeId), { q: leadCode(a.id) })).total).toBe(0);
  });

  test("busca por e-mail respeita o filtro de status", async () => {
    const s = await seedCapture();
    const a = await insertLead(s, { status: "contacted" });
    expect((await runAction(listLeads, panelCall(s.storeId), { q: a.email!, status: "open" })).total).toBe(0);
    expect((await runAction(listLeads, panelCall(s.storeId), { q: a.email!, status: "contacted" })).total).toBe(1);
  });
});

describe("leads.markContacted, leads.delete e leads.forgetEmail", () => {
  test("markContacted: open vira contacted, repetir é ok, convertido → conflict, inexistente → not_found", async () => {
    const s = await seedCapture();
    const a = await insertLead(s);
    expect(await runAction(markLeadContacted, panelCall(s.storeId, "support"), { id: a.id })).toEqual({ id: a.id, status: "contacted" });
    expect((await rowsOf(s.storeId))[0]).toMatchObject({ status: "contacted", email: a.email });
    expect(await runAction(markLeadContacted, panelCall(s.storeId), { id: a.id })).toEqual({ id: a.id, status: "contacted" });
    const conv = await insertLead(s, { email: null, status: "converted" });
    expect(await code(runAction(markLeadContacted, panelCall(s.storeId), { id: conv.id }))).toBe("conflict");
    expect(await code(runAction(markLeadContacted, panelCall(s.storeId), { id: randomUUID() }))).toBe("not_found");
    const outra = await seedCapture();
    expect(await code(runAction(markLeadContacted, panelCall(outra.storeId), { id: a.id }))).toBe("not_found");
  });

  test("delete apaga só o contato pedido; de outra loja ou inexistente → not_found", async () => {
    const s = await seedCapture();
    const outra = await seedCapture();
    const a = await insertLead(s);
    const b = await insertLead(s);
    const alheio = await insertLead(outra);
    expect(await code(runAction(deleteLead, panelCall(s.storeId), { id: alheio.id }))).toBe("not_found");
    expect(await code(runAction(deleteLead, panelCall(s.storeId), { id: randomUUID() }))).toBe("not_found");
    expect(await runAction(deleteLead, panelCall(s.storeId), { id: a.id })).toEqual({ id: a.id });
    expect(await leftIds(s.storeId)).toEqual(new Set([b.id]));
    expect(await leftIds(outra.storeId)).toEqual(new Set([alheio.id]));
  });

  test("forgetEmail apaga só os contatos da loja com aquele e-mail", async () => {
    const s = await seedCapture();
    const outra = await seedCapture();
    const email = mail();
    const mine1 = await insertLead(s, { email, emailHash: sha(email) });
    const mine2 = await insertLead(s, { email, emailHash: sha(email), status: "contacted" });
    const conv = await insertLead(s, { email: null, phone: null, emailHash: sha(email), status: "converted" });
    const outroEmail = await insertLead(s);
    const alheio = await insertLead(outra, { email, emailHash: sha(email) });

    const out = await runAction(forgetLeadEmail, panelCall(s.storeId), { email: ` ${email.toUpperCase()} ` });
    expect(out).toEqual({ deleted: 3 });
    expect(await leftIds(s.storeId)).toEqual(new Set([outroEmail.id]));
    expect(await leftIds(outra.storeId)).toEqual(new Set([alheio.id]));
    expect([mine1.id, mine2.id, conv.id]).toHaveLength(3);
    // sem contato com o e-mail: zero, sem erro
    expect(await runAction(forgetLeadEmail, panelCall(s.storeId), { email: mail() })).toEqual({ deleted: 0 });
    expect(await code(runAction(forgetLeadEmail, panelCall(s.storeId), { email: "  " }))).toBe("invalid_input");
  });

  test("auditoria sem e-mail nem celular: só leadId, e emailHash", async () => {
    const s = await seedCapture();
    const email = mail();
    const a = await insertLead(s, { email, emailHash: sha(email), phone: PHONE_DIGITS });
    const b = await insertLead(s);
    const c = await insertLead(s, { email, emailHash: sha(email), phone: PHONE_DIGITS });
    await runAction(markLeadContacted, panelCall(s.storeId), { id: a.id });
    await runAction(deleteLead, panelCall(s.storeId), { id: b.id });
    await runAction(forgetLeadEmail, panelCall(s.storeId), { email });
    await runAction(listLeads, panelCall(s.storeId), { q: email });
    await code(runAction(markLeadContacted, panelCall(s.storeId), { id: c.id })); // já apagado: not_found auditado

    const rows = await auditOf(s.storeId);
    const byAction = (n: string) => rows.filter((r) => r.action === n);
    expect(byAction("leads.markContacted").find((r) => r.ok)!.input).toEqual({ leadId: a.id });
    expect(byAction("leads.delete").map((r) => r.input)).toEqual([{ leadId: b.id }]);
    expect(byAction("leads.forgetEmail").map((r) => r.input)).toEqual([{ emailHash: sha(email) }]);
    // leads.list é leitura: não audita (como orders.list)
    expect(byAction("leads.list")).toHaveLength(0);
    const text = JSON.stringify(rows);
    for (const secret of [email, PHONE_DIGITS, "98765"]) expect(text).not.toContain(secret);
    expect(out).not.toContain(email);
    expect(out).not.toContain(PHONE_DIGITS);
  });
});

describe("sweep_leads", () => {
  test("apaga só os vencidos, de todas as lojas", async () => {
    const a = await seedCapture();
    const b = await seedCapture();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    const a1 = await insertLead(a, { expiresAt: past });
    const a2 = await insertLead(a, { expiresAt: future });
    const a3 = await insertLead(a, { expiresAt: past, email: null, phone: null, status: "converted" });
    const b1 = await insertLead(b, { expiresAt: past, status: "contacted" });
    const b2 = await insertLead(b, { expiresAt: future });

    await sweepLeadsJob({} as never, new AbortController().signal);
    expect(await leftIds(a.storeId)).toEqual(new Set([a2.id]));
    expect(await leftIds(b.storeId)).toEqual(new Set([b2.id]));
    expect([a1.id, a3.id, b1.id]).toHaveLength(3);
    // idempotente
    await sweepLeadsJob({} as never, new AbortController().signal);
    expect(await leftIds(a.storeId)).toEqual(new Set([a2.id]));
  });

  test("falha numa loja não impede as outras e o job falha no fim", async () => {
    const a = await seedCapture();
    const b = await seedCapture();
    const past = new Date(Date.now() - 60_000);
    const a1 = await insertLead(a, { expiresAt: past });
    const b1 = await insertLead(b, { expiresAt: past });
    const quebra = createSweepLeadsHandler(async (storeId) => {
      if (storeId === a.storeId) throw new Error("falha simulada");
    });
    await expect(quebra({} as never, new AbortController().signal)).rejects.toThrow(/sweep_leads falhou em 1 loja/);
    expect(await leftIds(a.storeId)).toEqual(new Set([a1.id]));
    expect((await leftIds(b.storeId)).has(b1.id)).toBe(false);
  });

  test("o tipo sweep_leads está registrado no worker", async () => {
    const { getHandlers } = await import("@/lib/jobs/handlers");
    expect(getHandlers().sweep_leads).toBe(sweepLeadsJob);
  });
});
