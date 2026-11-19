import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { db, ownerDb, requireOwnerUrl, setDbForTests, type Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { product, store } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { sha256Bytes } from "@/lib/crypto";
import { storage } from "@/lib/storage";

const LOCK_KEY = 7_303_001;

function withDatabase(url: string, user: string | undefined, password: string | undefined, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

export interface TestDb {
  db: Db;
  ownerDb: Db;
  url: string;
  drop(): Promise<void>;
}

/**
 * Cria `test_<random>` no Postgres do compose, migra e aponta `db`/`ownerDb` para ele.
 * Cada arquivo de teste chama no beforeAll e `drop()` no afterAll.
 */
export async function createTestDb(): Promise<TestDb> {
  const name = `test_${randomBytes(6).toString("hex")}`;
  const appPassword = env.APP_DB_PASSWORD ?? "app";
  const owner = requireOwnerUrl();
  const adminUrl = withDatabase(owner, undefined, undefined, "postgres");
  const ownerUrl = withDatabase(owner, undefined, undefined, name);
  const appUrl = withDatabase(owner, "app", appPassword, name);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
    // O papel `app` é global ao servidor: serializa a migração entre arquivos/processos.
    await admin`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      await migrate(ownerUrl, appPassword);
    } finally {
      await admin`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  } catch (e) {
    await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => undefined);
    await admin.end();
    throw e;
  }
  await setDbForTests({ appUrl, ownerUrl });
  let dropped = false;
  return {
    db,
    ownerDb,
    url: ownerUrl,
    async drop() {
      if (dropped) return;
      dropped = true;
      await setDbForTests();
      try {
        await admin.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.end();
      }
    },
  };
}

/** Cria uma loja (papel dono, a tabela store não tem RLS). */
export async function seedStore(name = "Loja"): Promise<{ storeId: string }> {
  const [row] = await ownerDb
    .insert(store)
    .values({ name, slug: `loja-${randomUUID()}` })
    .returning({ id: store.id });
  return { storeId: row!.id };
}

/**
 * Produto direto no banco (papel dono), SEM passar pelo PDF no Worker nem pelo armazenamento: cada `products.create`
 * abre um Worker e carrega o pdf-lib (~200–300 ms; vários segundos com a máquina carregada). Para testes que só precisam
 * de um produto para a oferta. O upload/validação do PDF tem testes próprios (catalog, product-upload).
 */
export async function seedProduct(storeId: string, name = "Produto"): Promise<{ id: string }> {
  const [row] = await ownerDb
    .insert(product)
    .values({ storeId, name, fileKey: `products/${storeId}/${randomUUID()}.pdf`, fileName: `${name}.pdf`, fileSize: 1000 })
    .returning({ id: product.id });
  return { id: row!.id };
}

/**
 * Produto com o PDF de verdade no armazenamento (para entrega e carimbo), gravado como `products.create` grava, mas sem
 * a validação do PDF no Worker (custo de Worker + pdf-lib a cada produto). A validação tem testes próprios.
 */
export async function seedPdfProduct(storeId: string, name: string, fileName: string, file: Uint8Array): Promise<{ id: string }> {
  const id = randomUUID();
  const fileKey = `products/${storeId}/${id}.pdf`;
  await storage.put(fileKey, file);
  await ownerDb.insert(product).values({ id, storeId, name, fileKey, fileName, fileSize: file.length, fileSha256: sha256Bytes(file) });
  return { id };
}

/**
 * Orçamento explícito (no lugar dos 5 s padrão do bun) para testes com custo real e medido, que não cabe com folga em
 * 5 s quando a máquina está carregada. Medido (junit, máquina compartilhada com load ~10): esses testes levam 1,4–4,8 s;
 * o custo vem de trabalho que o teste precisa fazer: Worker de PDF com pdf-lib (~200–280 ms por arquivo, carimbo da
 * entrega), scrypt da senha (~220 ms por login/usuário), teste da conexão SMTP no Mailpit, dezenas de transações em
 * sequência (laços de 10–20 compras/downloads) e propriedades com fast-check. Custos evitáveis foram removidos (produto
 * semeado sem validar o PDF no Worker; runRefundJobs só reivindica refund_order). Detalhes: task-14-report.md.
 */
export const HEAVY_TEST_MS = 20_000;
