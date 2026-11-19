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
