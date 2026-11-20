import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  countRecentEvents,
  ipRateKey,
  checkCardFingerprint,
  checkRateLimit,
  hadRecentEvent,
  recordEvent,
  resetCardFingerprintsForTests,
} from "@/lib/payments/ratelimit";
import { verifyTurnstile } from "@/lib/payments/turnstile";
import { createTestDb, type TestDb } from "./db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const at = (iso: string) => new Date(iso);

describe("checkRateLimit (Postgres)", () => {
  test("conta por janela fixa: passa até o limite, recusa depois e libera na janela seguinte", async () => {
    const key = "card:ip:198.51.100.1";
    const now = at("2026-11-18T10:05:00Z");
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit(key, 3, 3600, now));
    expect(results).toEqual([true, true, true, false]);
    expect(await checkRateLimit(key, 3, 3600, at("2026-11-18T10:59:59Z"))).toBe(false);
    expect(await checkRateLimit(key, 3, 3600, at("2026-11-18T11:00:00Z"))).toBe(true);
  });

  test("incremento atômico: 20 chamadas simultâneas, exatamente o limite passa", async () => {
    const key = "card:email:abc";
    const now = at("2026-11-18T12:00:00Z");
    const results = await Promise.all(Array.from({ length: 20 }, () => checkRateLimit(key, 5, 3600, now)));
    expect(results.filter(Boolean)).toHaveLength(5);
    const rows = await t.ownerDb.execute(sql`select key, count from rate_limit where key = ${key}`);
    expect(rows).toHaveLength(1);
    expect(Number((rows[0] as { count: number }).count)).toBe(20);
  });

  test("a tabela rate_limit é acessível ao papel app fora de uma loja (sem RLS)", async () => {
    expect(await checkRateLimit("card:ip:203.0.113.9", 1, 60, new Date())).toBe(true);
  });

  test("hadRecentEvent: janela deslizante de 1 h em fatias de 1 min", async () => {
    const key = "card:decline:ip:192.0.2.7";
    expect(await hadRecentEvent(key, 3600, at("2026-11-18T09:00:00Z"))).toBe(false);
    await recordEvent(key, at("2026-11-18T09:00:30Z"));
    expect(await hadRecentEvent(key, 3600, at("2026-11-18T09:30:00Z"))).toBe(true);
    expect(await hadRecentEvent(key, 3600, at("2026-11-18T09:59:00Z"))).toBe(true);
    expect(await hadRecentEvent(key, 3600, at("2026-11-18T10:01:00Z"))).toBe(false);
  });
});

describe("ipRateKey", () => {
  test("IPv4 inalterado; IPv6 canonicalizado e agrupado por /64", () => {
    expect(ipRateKey("203.0.113.9")).toBe("203.0.113.9");
    const k = "2001:db8:1:2::/64";
    for (const ip of ["2001:db8:1:2::1", "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2:aaaa:bbbb:cccc:dddd", "[2001:db8:1:2::9]"]) {
      expect(ipRateKey(ip)).toBe(k);
    }
    expect(ipRateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipRateKey("::1")).toBe("0:0:0:0::/64");
    expect(ipRateKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(ipRateKey("2001:db8:1:3::1")).not.toBe(k);
  });
});

describe("countRecentEvents", () => {
  test("soma os eventos da janela deslizante", async () => {
    const key = "card:decline:store:test";
    const t0 = at("2026-11-18T08:00:00Z");
    for (let i = 0; i < 3; i++) await recordEvent(key, t0);
    await recordEvent(key, at("2026-11-18T08:10:00Z"));
    expect(await countRecentEvents(key, 15 * 60, at("2026-11-18T08:14:00Z"))).toBe(4);
    expect(await countRecentEvents(key, 15 * 60, at("2026-11-18T08:16:00Z"))).toBe(1);
  });
});

describe("checkCardFingerprint (só memória)", () => {
  test("3 por hora por cartão; expira; cartões diferentes não se misturam; nada vai ao banco", async () => {
    resetCardFingerprintsForTests();
    const now = at("2026-11-18T10:00:00Z").getTime();
    const pan = "4000000000000010";
    expect([1, 2, 3, 4].map(() => checkCardFingerprint(pan, 3, 3600, now))).toEqual([true, true, true, false]);
    expect(checkCardFingerprint("4000 0000 0000 0028", 3, 3600, now)).toBe(true);
    // mesmo número com separadores conta como o mesmo cartão
    expect(checkCardFingerprint("4000 0000 0000 0010", 3, 3600, now)).toBe(false);
    expect(checkCardFingerprint(pan, 3, 3600, now + 3600_000)).toBe(true);
    const dump = JSON.stringify(await t.ownerDb.execute(sql`select * from rate_limit`));
    expect(dump).not.toContain("4000000000000010");
    expect(dump).not.toContain("0010");
  });

  test("a chave do HMAC é aleatória por processo, sem o SECRET (o serviço de cartão não o tem)", () => {
    const src = readFileSync(new URL("../src/lib/payments/ratelimit.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/requireSecret|SECRET/);
    expect(src).toMatch(/const FINGERPRINT_KEY = randomBytes\(32\);/);
  });
});

describe("verifyTurnstile", () => {
  test("sem TURNSTILE_SECRET passa sem chamar a rede", async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return Response.json({ success: false });
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile(undefined, "1.2.3.4", { secret: undefined, fetch: f })).toBe(true);
    expect(called).toBe(0);
  });

  test("com segredo: sem token falha; envia secret, response e remoteip; usa success", async () => {
    const seen: { url: string; body: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: String(init.body) });
      const token = new URLSearchParams(String(init.body)).get("response");
      return Response.json({ success: token === "bom" });
    }) as unknown as typeof fetch;
    const deps = { secret: "segredo-x", fetch: f };
    expect(await verifyTurnstile(undefined, "1.2.3.4", deps)).toBe(false);
    expect(seen).toHaveLength(0);
    expect(await verifyTurnstile("ruim", "1.2.3.4", deps)).toBe(false);
    expect(await verifyTurnstile("bom", "1.2.3.4", deps)).toBe(true);
    expect(seen[1]!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const p = new URLSearchParams(seen[1]!.body);
    expect(p.get("secret")).toBe("segredo-x");
    expect(p.get("remoteip")).toBe("1.2.3.4");
  });

  test("falha de rede ou resposta inválida conta como não verificado", async () => {
    const boom = (async () => {
      throw new Error("rede");
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile("x", "1.2.3.4", { secret: "s", fetch: boom })).toBe(false);
    const html = (async () => new Response("<html>", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyTurnstile("x", "1.2.3.4", { secret: "s", fetch: html })).toBe(false);
  });
});
