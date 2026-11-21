// Tabela `checkout_lead` (abandono antes de comprar): isolamento por loja (RLS), restrições do banco e as ações públicas
// de captura (`checkout.saveLead`) e de "Não salvar" (`checkout.forgetLead`).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ActionError, runAction } from "@/lib/actions/core";
import { withStore } from "@/lib/db/client";
import { auditLog, checkoutLead, offer, rateLimit, store } from "@/lib/db/schema";
import { LEAD_LIMITS, LEAD_TTL_DAYS, checkoutForgetLead, checkoutSaveLead } from "@/lib/leads/capture";
import { createTestDb, seedStore, type TestDb } from "./db";

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
