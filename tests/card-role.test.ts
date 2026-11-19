// Papel `card` do Postgres: o serviço de cartão isolado roda `payWithCard` com ele. Duas partes:
//  1. o que o papel NÃO pode (usuários, sessões, produto, outras conexões, criar pedido, tabelas futuras);
//  2. os casos de `payWithCard` (à vista, parcelado, recusa, desconhecido + liquidação, limite e disjuntor) com o `db`
//     do app apontado para o papel, num describe parametrizado (`app` é o controle: o mesmo caso com o papel completo).
// O preparo (loja, oferta, pedido, conexão) roda com o papel `app`, antes de trocar o `db`; as conferências, com o dono.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import type { ActionError } from "@/lib/actions/core";
import { setDbForTests, withStore } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { auditLog, cardAttempt, customer, integration, job, orders, payment, rateLimit, storeAlert } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { payWithCard, type CardDeps, type CardPaymentInput } from "@/lib/payments/asaas/card";
import { resetCardFingerprintsForTests } from "@/lib/payments/ratelimit";
import { HEAVY_TEST_MS, createTestDb, seedStore, type TestDb } from "./db";
import { createFakeAsaas, newCardOrder, seedAsaasStore } from "./asaas-helpers";
import type { FakeAsaas } from "./fakes/asaas";

const TESTS_LOCK = 7_303_001; // o mesmo de tests/db.ts: os papéis `app` e `card` são globais no servidor Postgres

let t: TestDb;
let card: postgres.Sql;
beforeAll(async () => {
  t = await createTestDb();
  card = postgres(t.cardUrl, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  setAsaasFetchForTests();
  await card.end({ timeout: 5 });
  await t.drop();
});
afterEach(() => {
  resetCardFingerprintsForTests();
});

/** Roda `fn` como `card` numa transação com `app.store_id` fixado (como `withStore`). */
const asCardIn = <T>(storeId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  card.begin(async (tx) => {
    await tx`select set_config('app.store_id', ${storeId}, true)`;
    return fn(tx);
  }) as Promise<T>;

const PERMISSION_DENIED = /permission denied/;
const ORDER_GUARD = /papel card só marca como pago um pedido de cartão/;

/** Loja com Asaas e um pedido de cartão pendente (preparo com o papel `app`). */
async function pendingOrder() {
  const fake = createFakeAsaas();
  const shop = await seedAsaasStore(fake);
  const order = await newCardOrder(shop.storeId, shop.offerId, `c-${randomUUID()}@example.com`);
  setAsaasFetchForTests();
  return { shop, order };
}
const RLS_DENIED = /row-level security/;

describe("papel card: atributos e o que fica de fora", () => {
  test("faz login, não é superusuário, não ignora RLS e não cria papel nem banco", async () => {
    const [role] = await t.ownerDb.execute<Record<string, boolean>>(
      sql`select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname = 'card'`,
    );
    expect(role).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    expect((await card`select current_user as u`)[0]!.u).toBe("card");
  });

  test("select em users, session, membership, login_attempt, product e download_token: permission denied", async () => {
    for (const table of ["users", "session", "membership", "login_attempt", "product", "download_token"]) {
      await expect(card.unsafe(`select 1 from "${table}" limit 1`)).rejects.toThrow(PERMISSION_DENIED);
    }
  });

  test("conexões: só a asaas da loja aparece (smtp e meta não); sem loja fixada, nenhuma", async () => {
    const { storeId } = await seedStore("Conexões");
    await t.ownerDb.insert(integration).values([
      { storeId, kind: "asaas", config: { env: "sandbox" }, secret: "a1.selado" },
      { storeId, kind: "smtp", config: { host: "smtp.example.com" }, secret: "v1.senha-smtp" },
      { storeId, kind: "meta", config: {}, secret: "v1.token-meta" },
    ]);
    const kinds = await asCardIn(storeId, (tx) => tx`select kind from integration order by kind`);
    expect(kinds.map((r) => r.kind)).toEqual(["asaas"]);
    // Nem pedindo a smtp explicitamente.
    expect(await asCardIn(storeId, (tx) => tx`select secret from integration where kind = 'smtp'`)).toHaveLength(0);
    expect(await card`select kind from integration`).toHaveLength(0);
  });

  test("conexões: sem insert, update nem delete", async () => {
    const { storeId } = await seedStore("Conexões 2");
    await t.ownerDb.insert(integration).values({ storeId, kind: "asaas", config: {}, secret: "a1.selado" });
    await expect(asCardIn(storeId, (tx) => tx`insert into integration (store_id, kind) values (${storeId}, 'smtp')`)).rejects.toThrow(
      PERMISSION_DENIED,
    );
    await expect(asCardIn(storeId, (tx) => tx`update integration set secret = null where kind = 'asaas'`)).rejects.toThrow(PERMISSION_DENIED);
    await expect(asCardIn(storeId, (tx) => tx`delete from integration where kind = 'asaas'`)).rejects.toThrow(PERMISSION_DENIED);
  });

  test("pedidos: insert, delete e update de outras colunas dão permission denied", async () => {
    const { shop, order } = await pendingOrder();
    await expect(
      asCardIn(
        shop.storeId,
        (tx) =>
          tx`insert into orders (store_id, public_id, offer_id, customer_id, status, method, subtotal_cents, total_cents)
             values (${shop.storeId}, 'x', ${shop.offerId}, ${order.customerId}, 'paid', 'card_asaas', 1, 1)`,
      ),
    ).rejects.toThrow(PERMISSION_DENIED);
    await expect(asCardIn(shop.storeId, (tx) => tx`update orders set total_cents = 1 where id = ${order.id}`)).rejects.toThrow(PERMISSION_DENIED);
    await expect(asCardIn(shop.storeId, (tx) => tx`delete from orders where id = ${order.id}`)).rejects.toThrow(PERMISSION_DENIED);
  });

  test("pedidos: o card nunca tira um pedido de pago (paid -> expired, refunded, pending, declined, disputed)", async () => {
    const { shop, order } = await pendingOrder();
    await t.ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, order.id));
    for (const to of ["expired", "refunded", "pending", "declined", "disputed"]) {
      await expect(asCardIn(shop.storeId, (tx) => tx`update orders set status = ${to} where id = ${order.id}`)).rejects.toThrow(ORDER_GUARD);
    }
    // Nem "trocar" para o mesmo estado mexendo no paid_at.
    await expect(asCardIn(shop.storeId, (tx) => tx`update orders set paid_at = now() - interval '1 day' where id = ${order.id}`)).rejects.toThrow(
      ORDER_GUARD,
    );
    expect((await t.ownerDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");
    // O FOR UPDATE (trava do pedido já pago, como em payWithCard e applyAsaasPayment) continua valendo.
    const locked = await asCardIn(shop.storeId, (tx) => tx`select status from orders where id = ${order.id} for update`);
    expect(locked.map((r) => r.status)).toEqual(["paid"]);
  });

  test("pedidos: o card só marca como pago (de pendente ou expirado), com paid_at do momento", async () => {
    const { shop, order } = await pendingOrder();
    for (const to of ["expired", "declined", "refunded"]) {
      await expect(asCardIn(shop.storeId, (tx) => tx`update orders set status = ${to} where id = ${order.id}`)).rejects.toThrow(ORDER_GUARD);
    }
    await expect(
      asCardIn(shop.storeId, (tx) => tx`update orders set status = 'paid', paid_at = '2000-01-01' where id = ${order.id}`),
    ).rejects.toThrow(ORDER_GUARD);
    const { shop: other, order: expired } = await pendingOrder();
    await t.ownerDb.update(orders).set({ status: "expired" }).where(eq(orders.id, expired.id));
    await asCardIn(other.storeId, (tx) => tx`update orders set status = 'paid', paid_at = coalesce(paid_at, now()) where id = ${expired.id}`);
    await asCardIn(shop.storeId, (tx) => tx`update orders set status = 'paid', paid_at = coalesce(paid_at, now()) where id = ${order.id}`);
    const rows = await t.ownerDb.select().from(orders).where(sql`${orders.id} in (${order.id}, ${expired.id})`);
    expect(rows.map((r) => [r.status, r.paidAt !== null])).toEqual([
      ["paid", true],
      ["paid", true],
    ]);
  });

  test("pedidos: o card só toca pedido de cartão (pending -> paid em pix_asaas e pix_manual é recusado)", async () => {
    for (const method of ["pix_asaas", "pix_manual"]) {
      const { shop, order } = await pendingOrder();
      await t.ownerDb.update(orders).set({ method }).where(eq(orders.id, order.id));
      await expect(
        asCardIn(shop.storeId, (tx) => tx`update orders set status = 'paid', paid_at = coalesce(paid_at, now()) where id = ${order.id}`),
      ).rejects.toThrow(ORDER_GUARD);
      expect((await t.ownerDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("pending");
    }
  });

  test("orders_card_guard roda com search_path fixo (pg_catalog, pg_temp)", async () => {
    const [f] = await t.ownerDb.execute<{ cfg: string[] | null }>(sql`select proconfig as cfg from pg_proc where proname = 'orders_card_guard'`);
    expect(f!.cfg).toEqual(["search_path=pg_catalog, pg_temp"]);
  });

  test("pedidos: o papel app não passa pela trava do card (paid -> refunded)", async () => {
    const { shop, order } = await pendingOrder();
    await t.ownerDb.update(orders).set({ status: "paid", paidAt: new Date() }).where(eq(orders.id, order.id));
    await withStore(shop.storeId, (tx) => tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, order.id)));
    expect((await t.ownerDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("refunded");
  });

  test("loja: lê id, slug e domain (origens do iframe); o e-mail do vendedor não", async () => {
    const { storeId } = await seedStore("Origens");
    const [row] = await card`select id, slug, domain from store where id = ${storeId}`;
    expect(row!.id).toBe(storeId);
    await expect(card`select notify_email from store where id = ${storeId}`).rejects.toThrow(PERMISSION_DENIED);
    await expect(card`update store set domain = 'x.example.com' where id = ${storeId}`).rejects.toThrow(PERMISSION_DENIED);
  });

  test("fila: só enfileira entrega, Meta e aviso ao vendedor da loja fixada; reembolso não; não lê a fila", async () => {
    const a = await seedStore("Fila A");
    const b = await seedStore("Fila B");
    await asCardIn(a.storeId, (tx) => tx`insert into job (store_id, type, payload) values (${a.storeId}, 'notify_seller', '{}')`);
    await expect(
      asCardIn(a.storeId, (tx) => tx`insert into job (store_id, type, payload) values (${a.storeId}, 'refund_order', '{}')`),
    ).rejects.toThrow(RLS_DENIED);
    await expect(
      asCardIn(a.storeId, (tx) => tx`insert into job (store_id, type, payload) values (${b.storeId}, 'deliver_order', '{}')`),
    ).rejects.toThrow(RLS_DENIED);
    await expect(asCardIn(a.storeId, (tx) => tx`insert into job (store_id, type, payload) values (null, 'deliver_order', '{}')`)).rejects.toThrow(
      RLS_DENIED,
    );
    await expect(card`select id from job limit 1`).rejects.toThrow(PERMISSION_DENIED);
    const jobs = await t.ownerDb.select().from(job).where(eq(job.storeId, a.storeId));
    expect(jobs.map((j) => j.type)).toEqual(["notify_seller"]);
  });

  test("limites: só as chaves card: (não lê, não grava e não apaga os limites do app)", async () => {
    const key = `account:password:${randomUUID()}`;
    await t.ownerDb.insert(rateLimit).values({ key, windowStart: new Date(0), count: 3 });
    expect(await card`select key from rate_limit where key = ${key}`).toHaveLength(0);
    await card`delete from rate_limit`;
    await card`update rate_limit set count = 0`;
    const [row] = await t.ownerDb.select().from(rateLimit).where(eq(rateLimit.key, key));
    expect(row!.count).toBe(3);
    await expect(card`insert into rate_limit (key, window_start, count) values (${`checkout:view:${randomUUID()}`}, now(), 1)`).rejects.toThrow(
      RLS_DENIED,
    );
    await card`insert into rate_limit (key, window_start, count) values (${`card:email:${randomUUID()}`}, now(), 1)`;
  });

  test("tabela criada depois da migração não é legível; nenhum default privilege menciona o papel card", async () => {
    const name = `depois_${randomBytes(4).toString("hex")}`;
    await t.ownerDb.execute(sql.raw(`create table "${name}" (id int primary key)`));
    await expect(card.unsafe(`select 1 from "${name}"`)).rejects.toThrow(PERMISSION_DENIED);
    const acl = await t.ownerDb.execute<{ acl: string }>(sql`select defaclacl::text as acl from pg_default_acl`);
    expect(acl.filter((r) => /(^|[{,])card=/.test(r.acl))).toEqual([]);
  });

  test("lista final de permissões (tabela e coluna) é exatamente a documentada no rls.sql", async () => {
    expect(await cardGrants()).toEqual(EXPECTED_GRANTS);
  });

  test("políticas que citam o card são só as documentadas; a trava de pedidos existe e card_role_grants não é executável por todos", async () => {
    const policies = await t.ownerDb.execute<{ p: string }>(
      sql`select tablename || '.' || policyname || ' ' || permissive || ' ' || cmd as p from pg_policies where 'card' = any(roles) order by 1`,
    );
    expect(policies.map((r) => r.p)).toEqual([
      "integration.card_asaas_only RESTRICTIVE SELECT",
      "job.job_card_insert PERMISSIVE INSERT",
      "rate_limit.rate_limit_card PERMISSIVE ALL",
    ]);
    const [trg] = await t.ownerDb.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_trigger where tgrelid = 'orders'::regclass and tgname = 'orders_card_guard' and tgenabled = 'O'`,
    );
    expect(trg!.n).toBe(1);
    expect((await card`select has_function_privilege('card_role_grants()', 'execute') as x`)[0]!.x).toBe(false);
  });

  test("migrate de novo, com e sem a senha do card: idempotente, mesmas permissões, o papel segue entrando", async () => {
    const admin = postgres(new URL("/postgres", t.url).toString(), { max: 1, onnotice: () => {} });
    try {
      await admin`select pg_advisory_lock(${TESTS_LOCK})`;
      try {
        const appPw = env.APP_DB_PASSWORD ?? "app";
        await migrate(t.url, appPw);
        await migrate(t.url, appPw, env.CARD_DB_PASSWORD ?? "card");
        await migrate(t.url, appPw);
      } finally {
        await admin`select pg_advisory_unlock(${TESTS_LOCK})`;
      }
    } finally {
      await admin.end();
    }
    expect(await cardGrants()).toEqual(EXPECTED_GRANTS);
    const fresh = postgres(t.cardUrl, { max: 1, onnotice: () => {} });
    try {
      expect((await fresh`select current_user as u`)[0]!.u).toBe("card");
      await expect(fresh`select 1 from users limit 1`).rejects.toThrow(PERMISSION_DENIED);
    } finally {
      await fresh.end();
    }
  });
});

/** Permissões do papel `card` no schema public: "tabela: privilégio" e "tabela.coluna: privilégio", ordenadas. */
async function cardGrants(): Promise<string[]> {
  const rows = await t.ownerDb.execute<{ g: string }>(sql`
    select c.relname || ': ' || a.privilege_type as g
      from pg_class c cross join lateral aclexplode(c.relacl) a
     where c.relnamespace = 'public'::regnamespace and a.grantee = 'card'::regrole
    union all
    select c.relname || '.' || att.attname || ': ' || a.privilege_type
      from pg_attribute att
      join pg_class c on c.oid = att.attrelid
      cross join lateral aclexplode(att.attacl) a
     where c.relnamespace = 'public'::regnamespace and a.grantee = 'card'::regrole
    union all
    select 'schema public: ' || a.privilege_type
      from pg_namespace n cross join lateral aclexplode(n.nspacl) a
     where n.nspname = 'public' and a.grantee = 'card'::regrole`);
  return rows.map((r) => r.g).sort();
}

const EXPECTED_GRANTS = [
  "audit_log: INSERT",
  "card_attempt.asaas_payment_id: UPDATE",
  "card_attempt.error_message: UPDATE",
  "card_attempt.resolved_at: UPDATE",
  "card_attempt.status: UPDATE",
  "card_attempt: INSERT",
  "card_attempt: SELECT",
  "customer.asaas_account_key: UPDATE",
  "customer.asaas_customer_id: UPDATE",
  "customer: SELECT",
  "integration: SELECT",
  "job: INSERT",
  "offer: SELECT",
  "orders.paid_at: UPDATE",
  "orders.status: UPDATE",
  "orders: SELECT",
  "payment.status: UPDATE",
  "payment: INSERT",
  "payment: SELECT",
  "rate_limit: DELETE",
  "rate_limit: INSERT",
  "rate_limit: SELECT",
  "rate_limit: UPDATE",
  "schema public: USAGE",
  "store.domain: SELECT",
  "store.id: SELECT",
  "store.slug: SELECT",
  "store_alert: INSERT",
].sort();

// ---- payWithCard com o papel `card` (Passo 4) ----

const APPROVE = "4444444444444444"; // cartão de aprovação do sandbox (a conexão semeada é sandbox)
const DECLINE = "5184019740373151"; // recusa no Asaas falso
const tick = () => new Promise<void>((r) => setImmediate(r));
const fastDeps: CardDeps = { wait: tick };
let ipSeq = 0;
const nextIp = () => `203.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const email = () => `c-${randomUUID()}@example.com`;

/** Acrescenta o dígito verificador (Luhn) a `body`. */
function luhn(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

function input(orderPublicId: string, over: Partial<CardPaymentInput> & { number?: string } = {}): CardPaymentInput {
  const { number, ...rest } = over;
  return {
    orderPublicId,
    idempotencyKey: randomUUID(),
    installments: 1,
    card: { holderName: "TITULAR PAPEL CARD", number: number ?? APPROVE, expiryMonth: "08", expiryYear: "2034", ccv: "987" },
    holder: { cpf: "52998224725", postalCode: "01310-100", addressNumber: "100" },
    clientIp: nextIp(),
    ...rest,
  };
}

type Order = Awaited<ReturnType<typeof newCardOrder>>;
const paymentPosts = (fake: FakeAsaas, orderId: string) =>
  fake.calls.filter((c) => c.method === "POST" && c.path === "/payments" && (c.body as { externalReference?: string }).externalReference === orderId);
const orderRow = async (id: string) => (await t.ownerDb.select().from(orders).where(eq(orders.id, id)))[0]!;
const jobTypes = async (orderId: string) =>
  (await t.ownerDb.select().from(job).where(sql`${job.payload}->>'orderId' = ${orderId}`)).map((j) => j.type).sort();

describe.each(["app", "card"] as const)("payWithCard com o papel %s", (role) => {
  const fake = createFakeAsaas();
  let shop: { storeId: string; offerId: string };
  let guard: { storeId: string; offerId: string };
  let o: { cash: Order; parcel: Order; decline: Order; unknown: Order; analysis: Order; limited: Order[]; tripped: Order[]; after: Order };
  const limitedEmail = email();

  beforeAll(async () => {
    // Preparo com o papel `app` (como hoje): o papel `card` não cria loja, oferta, pedido nem conexão.
    shop = await seedAsaasStore(fake, 1000, { maxInstallments: 3 });
    guard = await seedAsaasStore(fake, 990);
    const mk = (s: { storeId: string; offerId: string }, mail = email()) => newCardOrder(s.storeId, s.offerId, mail);
    const many = async (n: number, f: () => Promise<Order>) => {
      const out: Order[] = [];
      for (let i = 0; i < n; i++) out.push(await f());
      return out;
    };
    o = {
      cash: await mk(shop),
      parcel: await mk(shop),
      decline: await mk(shop),
      unknown: await mk(shop),
      analysis: await mk(shop),
      limited: await many(6, () => mk(shop, limitedEmail)),
      tripped: await many(10, () => mk(guard)),
      after: await mk(guard),
    };
    // Daqui em diante o `db` do app (withStore, ratelimit, runAction) é o do papel testado.
    await setDbForTests({ appUrl: role === "card" ? t.cardUrl : t.appUrl, ownerUrl: t.url });
  }, HEAVY_TEST_MS);
  afterAll(async () => {
    await setDbForTests({ appUrl: t.appUrl, ownerUrl: t.url });
  });

  test("aprovado à vista: pedido pago, pagamento, tentativa, cliente no Asaas e jobs da confirmação", async () => {
    const r = await payWithCard({ storeId: shop.storeId }, input(o.cash.publicId), fastDeps);
    expect(r).toEqual({ status: "approved" });
    expect((await orderRow(o.cash.id)).status).toBe("paid");
    expect((await orderRow(o.cash.id)).paidAt).not.toBeNull();
    const pays = await t.ownerDb.select().from(payment).where(eq(payment.orderId, o.cash.id));
    expect(pays.map((p) => [p.status, p.amountCents])).toEqual([["CONFIRMED", 1000]]);
    const [a] = await t.ownerDb.select().from(cardAttempt).where(eq(cardAttempt.orderId, o.cash.id));
    expect([a!.status, a!.asaasPaymentId, a!.resolvedAt !== null]).toEqual(["approved", pays[0]!.providerId, true]);
    const [c] = await t.ownerDb.select().from(customer).where(eq(customer.id, o.cash.customerId));
    expect(c!.asaasCustomerId).toMatch(/^cus_/);
    expect(await jobTypes(o.cash.id)).toEqual(["deliver_order", "meta_event", "notify_seller"]);
  });

  test("aprovado parcelado: installmentCount + totalValue e pedido pago", async () => {
    const r = await payWithCard({ storeId: shop.storeId }, input(o.parcel.publicId, { installments: 3 }), fastDeps);
    expect(r).toEqual({ status: "approved" });
    const body = paymentPosts(fake, o.parcel.id)[0]!.body as Record<string, unknown>;
    expect([body.installmentCount, body.totalValue, body.value]).toEqual([3, 10, undefined]);
    expect((await orderRow(o.parcel.id)).status).toBe("paid");
    expect(await jobTypes(o.parcel.id)).toEqual(["deliver_order", "meta_event", "notify_seller"]);
  });

  test("recusa: tentativa recusada, pedido pendente e recusa registrada nos limites", async () => {
    const r = await payWithCard({ storeId: shop.storeId }, input(o.decline.publicId, { number: DECLINE }), fastDeps);
    expect(r.status).toBe("declined");
    expect((await orderRow(o.decline.id)).status).toBe("pending");
    const [a] = await t.ownerDb.select().from(cardAttempt).where(eq(cardAttempt.orderId, o.decline.id));
    expect(a!.status).toBe("declined");
    const declines = await t.ownerDb.select().from(rateLimit).where(eq(rateLimit.key, `card:decline:store:${shop.storeId}`));
    expect(declines).toHaveLength(1);
  });

  test("resultado desconhecido; 3 min depois a conferência no Asaas liquida o pedido sem cobrar de novo", async () => {
    fake.loseResponse("POST /payments");
    const t0 = new Date();
    try {
      expect((await payWithCard({ storeId: shop.storeId }, input(o.unknown.publicId), { ...fastDeps, now: () => t0 })).status).toBe("unknown");
    } finally {
      fake.clearFailures();
    }
    expect((await orderRow(o.unknown.id)).status).toBe("pending");
    const later = new Date(t0.getTime() + 3 * 60_000);
    expect(await payWithCard({ storeId: shop.storeId }, input(o.unknown.publicId), { ...fastDeps, now: () => later })).toEqual({
      status: "approved",
    });
    expect(paymentPosts(fake, o.unknown.id)).toHaveLength(1);
    expect((await orderRow(o.unknown.id)).status).toBe("paid");
    const pays = await t.ownerDb.select().from(payment).where(eq(payment.orderId, o.unknown.id));
    expect(pays.map((p) => p.status)).toEqual(["CONFIRMED"]);
    // Liquidado pelo caminho do webhook (runAction): auditoria gravada com o papel testado.
    const audit = await t.ownerDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.storeId, shop.storeId), eq(auditLog.action, "payments.applyAsaasPayment")));
    expect(audit.map((r) => r.ok)).toEqual([true]);
    expect(await jobTypes(o.unknown.id)).toEqual(["deliver_order", "meta_event", "notify_seller"]);
  });

  test("cobrança em análise na resposta; aprovada depois: a conferência atualiza o status do pagamento e libera o pedido", async () => {
    // O Asaas responde a cobrança ainda em análise (o falso aprova cartão na hora: a resposta é reescrita).
    setAsaasFetchForTests((async (url: string, init?: RequestInit) => {
      const res = await fake.fetch(url, init);
      if (init?.method !== "POST" || !String(url).endsWith("/payments")) return res;
      const body = (await res.json()) as { id: string; status: string };
      fake.setStatus(body.id, "AWAITING_RISK_ANALYSIS");
      return Response.json({ ...body, status: "AWAITING_RISK_ANALYSIS" }, { status: res.status });
    }) as unknown as typeof fetch);
    const t0 = new Date();
    try {
      expect((await payWithCard({ storeId: shop.storeId }, input(o.analysis.publicId), { ...fastDeps, now: () => t0 })).status).toBe("unknown");
    } finally {
      setAsaasFetchForTests(fake.fetch);
    }
    const [charged] = await t.ownerDb.select().from(payment).where(eq(payment.orderId, o.analysis.id));
    expect(charged!.status).toBe("AWAITING_RISK_ANALYSIS");
    fake.setStatus(charged!.providerId!, "CONFIRMED");
    const later = new Date(t0.getTime() + 3 * 60_000);
    expect(await payWithCard({ storeId: shop.storeId }, input(o.analysis.publicId), { ...fastDeps, now: () => later })).toEqual({
      status: "approved",
    });
    const pays = await t.ownerDb.select().from(payment).where(eq(payment.orderId, o.analysis.id));
    expect(pays.map((p) => [p.providerId, p.status])).toEqual([[charged!.providerId, "CONFIRMED"]]);
    expect((await orderRow(o.analysis.id)).status).toBe("paid");
    expect(paymentPosts(fake, o.analysis.id)).toHaveLength(1);
  });

  test("limite estourado: 6ª tentativa do mesmo e-mail na hora -> rate_limited, sem chamar o Asaas", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await payWithCard({ storeId: shop.storeId }, input(o.limited[i]!.publicId, { number: luhn(`4100000000${String(i).padStart(5, "0")}`) }), fastDeps);
      expect(r.status).toBe("approved");
    }
    const last = o.limited[5]!;
    const e = await payWithCard({ storeId: shop.storeId }, input(last.publicId, { number: luhn("410000000009999") }), fastDeps).catch((x: unknown) => x);
    expect((e as ActionError).code).toBe("rate_limited");
    expect(paymentPosts(fake, last.id)).toHaveLength(0);
  }, HEAVY_TEST_MS);

  test("disjuntor: 10 recusas na loja gravam o aviso e o e-mail ao vendedor; depois exige Turnstile", async () => {
    const t0 = new Date("2026-11-18T16:00:00Z");
    const deps: CardDeps = { ...fastDeps, turnstileConfigured: true, verifyTurnstile: async (tok) => tok === "ok", now: () => t0 };
    fake.fail("POST /payments", 400, "Transação não autorizada", "invalid_creditCard");
    try {
      for (const [i, order] of o.tripped.entries()) {
        const r = await payWithCard({ storeId: guard.storeId }, input(order.publicId, { number: luhn(`4410000000${String(i).padStart(5, "0")}`) }), deps);
        expect(r.status).toBe("declined");
      }
    } finally {
      fake.clearFailures();
    }
    const alerts = await t.ownerDb.select().from(storeAlert).where(eq(storeAlert.storeId, guard.storeId));
    expect(alerts.map((a) => a.kind)).toEqual(["disjuntor_cartao"]);
    const notices = await t.ownerDb.select().from(job).where(and(eq(job.storeId, guard.storeId), eq(job.type, "notify_seller")));
    expect(notices.map((j) => j.payload)).toEqual([{ reason: "disjuntor_cartao" }]);
    const breaker = await t.ownerDb.select().from(rateLimit).where(eq(rateLimit.key, `card:breaker:store:${guard.storeId}`));
    expect(breaker).toHaveLength(1);

    const later = new Date(t0.getTime() + 5 * 60_000);
    const e = (await payWithCard({ storeId: guard.storeId }, input(o.after.publicId), { ...deps, now: () => later }).catch((x: unknown) => x)) as ActionError;
    expect([e.code, e.details]).toEqual(["rate_limited", { captcha: true }]);
    const ok = await payWithCard({ storeId: guard.storeId }, input(o.after.publicId, { turnstileToken: "ok" }), { ...deps, now: () => later });
    expect(ok.status).toBe("approved");
    expect((await orderRow(o.after.id)).status).toBe("paid");
  }, HEAVY_TEST_MS);
});
