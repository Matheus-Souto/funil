// Migração no início do container (deploy/entrypoint.sh): dois containers do app subindo juntos no mesmo banco (ex.:
// `docker compose up --scale` ou um restart sobreposto a um deploy) não podem aplicar a mesma migration duas vezes.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { requireOwnerUrl } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { env } from "@/lib/env";

const TESTS_LOCK = 7_303_001; // o mesmo de tests/db.ts: o papel `app` é global no servidor Postgres

const at = (url: string, database: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

test("duas migrações simultâneas no mesmo banco: ambas terminam e cada migration é aplicada uma vez", async () => {
  const owner = requireOwnerUrl();
  const name = `test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(at(owner, "postgres"), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  try {
    await admin`select pg_advisory_lock(${TESTS_LOCK})`;
    let results: string[];
    try {
      const pw = env.APP_DB_PASSWORD ?? "app";
      const settled = await Promise.allSettled([migrate(at(owner, name), pw), migrate(at(owner, name), pw)]);
      results = settled.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"));
    } finally {
      await admin`select pg_advisory_unlock(${TESTS_LOCK})`;
    }
    expect(results).toEqual(["ok", "ok"]);
    const journal = JSON.parse(readFileSync(join(import.meta.dir, "../drizzle/meta/_journal.json"), "utf8")) as { entries: unknown[] };
    const pg = postgres(at(owner, name), { max: 1, onnotice: () => {} });
    try {
      const applied = await pg`select hash from drizzle.__drizzle_migrations`;
      expect(applied.length).toBe(journal.entries.length);
    } finally {
      await pg.end();
    }
  } finally {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
});

test("rls.sql e permissões do card com lock_timeout curto: tabela presa por outra sessão faz a migração falhar rápido, sem fila de travas; depois aplica igual", async () => {
  const owner = requireOwnerUrl();
  const name = `test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(at(owner, "postgres"), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  const pw = env.APP_DB_PASSWORD ?? "app";
  const card = env.CARD_DB_PASSWORD ?? "card";
  const holder = postgres(at(owner, name), { max: 1, onnotice: () => {} });
  try {
    await admin`select pg_advisory_lock(${TESTS_LOCK})`;
    try {
      await migrate(at(owner, name), pw, card);
      // Outra sessão lendo `integration` dentro de uma transação aberta: o `drop policy` do rls.sql espera essa trava.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const ready = new Promise<void>((r) => (locked = r));
      const tx = holder.begin(async (sql) => {
        await sql`select 1 from integration limit 1`;
        locked();
        await held;
      });
      await ready;
      const started = Date.now();
      const blocked = await migrate(at(owner, name), pw, card, { lockTimeoutMs: 300 }).then(
        () => "ok",
        (e: unknown) => String(e),
      );
      const elapsed = Date.now() - started;
      release();
      await tx;
      expect(blocked).toMatch(/lock timeout/);
      expect(elapsed).toBeLessThan(5_000);
      // Sem a trava, a mesma migração passa (idempotente).
      await migrate(at(owner, name), pw, card, { lockTimeoutMs: 300 });
      await migrate(at(owner, name), pw, card);
    } finally {
      await admin`select pg_advisory_unlock(${TESTS_LOCK})`;
    }
  } finally {
    await holder.end();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
});
