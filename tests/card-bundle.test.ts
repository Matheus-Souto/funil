// Empacotamento do serviço de cartão (`bun run card:build` -> dist/card, fora do git) e fumaça do servidor empacotado
// rodando em Node: sobe `node dist/card/server.js` numa porta efêmera (CARD_PORT=0), com o banco de teste no papel
// `card` e o Asaas falso atrás de um servidor HTTP local (ASAAS_BASE_URL), e paga um pedido de ponta a ponta.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Window } from "happy-dom";
import { and, eq } from "drizzle-orm";
import { integration, orders } from "@/lib/db/schema";
import { requireSecret } from "@/lib/env";
import { createIntegrationSecrets } from "@/lib/integrations";
import { setAsaasFetchForTests } from "@/lib/payments/asaas/client";
import { issueCardTicket } from "@/lib/payments/card-ticket";
import { cardDevEnv } from "../scripts/card-dev";
import { HEAVY_TEST_MS, createTestDb, type TestDb } from "./db";
import { createFakeAsaas, newCardOrder, seedAsaasStore } from "./asaas-helpers";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "card");
const read = (f: string) => readFileSync(join(OUT, f), "utf8");

let build: { status: number | null; out: string };
beforeAll(() => {
  const r = spawnSync(process.execPath, ["run", "card:build"], { cwd: ROOT, encoding: "utf8" });
  build = { status: r.status, out: `${r.stdout}${r.stderr}` };
}, HEAVY_TEST_MS);

describe("bun run card:build", () => {
  test("gera server.js, form.js e form.css em dist/card (ignorado pelo git)", () => {
    expect(build).toMatchObject({ status: 0 });
    for (const f of ["server.js", "form.js", "form.css"]) expect(read(f).length).toBeGreaterThan(0);
    expect(read("form.css")).toBe(readFileSync(join(ROOT, "src", "card-service", "form", "form.css"), "utf8"));
    const ignored = spawnSync("git", ["check-ignore", "-q", "dist/card/server.js"], { cwd: ROOT });
    expect(ignored.status).toBe(0);
  });

  test("server.js não leva nodemailer, pdf-lib, next nem react", () => {
    const server = read("server.js");
    for (const banned of ["nodemailer", "pdf-lib", "next/", "react"]) expect([banned, server.includes(banned)]).toEqual([banned, false]);
  });

  test("form.js: o único fetch é o relativo /api/card; nenhuma outra URL (nem o Turnstile); sem storage nem console", () => {
    const form = read("form.js");
    const fetches = [...form.matchAll(/fetch\(([^,)]*)/g)].map((m) => m[1]);
    expect(fetches).toEqual(['"/api/card"']);
    const urls = [...form.matchAll(/[a-z]+:\/\/[^"'`\s)]*/gi)].map((m) => m[0]);
    expect(urls.sort()).toEqual(
      // namespace do SVG (createElementNS), não é requisição
      ["http://www.w3.org/2000/svg"],
    );
    for (const banned of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "console.", "eval(", "new Function", '"*"', "XMLHttpRequest", "sendBeacon"]) {
      expect([banned, form.includes(banned)]).toEqual([banned, false]);
    }
    // iOS 15.0 (Safari 15): nada que só chegou depois (AbortSignal.timeout 16, randomUUID/structuredClone/at/
    // Object.hasOwn/findLast/AbortSignal.reason 15.4, lookbehind 16.4). randomUUID só atrás da checagem de existência.
    for (const recent of ["AbortSignal.timeout", "structuredClone", ".at(", "Object.hasOwn", ".findLast", ".toSorted", ".reason", "(?<=", "(?<!"]) {
      expect([recent, form.includes(recent)]).toEqual([recent, false]);
    }
    expect(form.match(/randomUUID/g)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(form).not.toMatch(/\.setAttribute\(\s*["']style["']/);
    expect(form).not.toMatch(/\.innerHTML\s*=/);
  });
});

describe("form.js como script clássico (a página o carrega com <script src defer>, sem type=module)", () => {
  test("roda na página do iframe e monta o formulário, sem erro", async () => {
    const w = new Window({ url: "https://pagar.example/form/x", settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } as never });
    try {
      const errors: unknown[] = [];
      w.addEventListener("error", (e) => errors.push((e as unknown as { error: unknown }).error));
      w.document.head.innerHTML = `<script type="application/json" id="cfg">{"allowedOrigins":["https://loja.example"],"storeId":null}</script>`;
      w.document.body.innerHTML = `<main id="card-form"></main>`;
      const s = w.document.createElement("script");
      s.textContent = read("form.js");
      w.document.body.appendChild(s);
      expect(errors).toEqual([]);
      expect(w.document.getElementById("cardNumber")).not.toBeNull();
      expect(w.document.querySelectorAll("#card-form label").length).toBe(9);
    } finally {
      await w.happyDOM.close();
    }
  });
});

describe("card:dev", () => {
  test("o serviço recebe só a lista de permissão do .env, com o papel `card` no banco", () => {
    const env = cardDevEnv({
      PATH: "/bin",
      DATABASE_URL: "postgres://app:app@localhost:5433/funil",
      CARD_DB_PASSWORD: "senha-card",
      BASE_URL: "http://localhost:3000",
      CARD_ORIGIN: "http://localhost:3100",
      CARD_TICKET_KEY: "t".repeat(40),
      ASAAS_SEAL_KEY: "s".repeat(40),
      TURNSTILE_SITE_KEY: "",
      SECRET: "x".repeat(40),
      OWNER_DATABASE_URL: "postgres://owner:owner@localhost:5433/funil",
      APP_DB_PASSWORD: "app",
      SMTP_PASSWORD: "smtp",
      META_GRAPH_BASE_URL: "http://localhost:9",
      HOME: "/home/x",
    });
    expect(env).toEqual({
      SERVICE: "card",
      DATABASE_URL: "postgres://card:senha-card@localhost:5433/funil",
      PATH: "/bin",
      BASE_URL: "http://localhost:3000",
      CARD_ORIGIN: "http://localhost:3100",
      CARD_TICKET_KEY: "t".repeat(40),
      ASAAS_SEAL_KEY: "s".repeat(40),
    });
    expect(() => cardDevEnv({ DATABASE_URL: "postgres://app:app@localhost/x" })).toThrow("CARD_DB_PASSWORD");
  });
});

describe("servidor empacotado em Node", () => {
  const KEY = "chave-do-bilhete-do-bundle-".repeat(2);
  const SEAL = "selo-do-asaas-do-bundle-".repeat(2);
  const CARD_ORIGIN = "http://127.0.0.1:3100"; // o que o Origin do POST precisa dizer; o processo escuta na porta efêmera
  const PAN = "4444444444444444";
  let t: TestDb;
  let shop: { storeId: string; offerId: string };
  let fakeServer: Server;
  let proc: ChildProcess;
  let base: string;
  let output = "";

  beforeAll(async () => {
    t = await createTestDb();
    const fake = createFakeAsaas();
    shop = await seedAsaasStore(fake, 2700);
    setAsaasFetchForTests();
    // O serviço só abre a conexão selada com a ASAAS_SEAL_KEY (a1.), como depois da re-selagem do app.
    const sealed = createIntegrationSecrets({ secret: requireSecret(), asaasKey: SEAL }).seal("asaas", fake.apiKey);
    await t.ownerDb.update(integration).set({ secret: sealed }).where(and(eq(integration.storeId, shop.storeId), eq(integration.kind, "asaas")));

    // Asaas falso atrás de HTTP numa porta efêmera.
    fakeServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        fake
          .fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }))
          .then(async (r) => {
            res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
            res.end(Buffer.from(await r.arrayBuffer()));
          })
          .catch(() => res.destroy());
      });
    });
    await new Promise<void>((r) => fakeServer.listen(0, "127.0.0.1", () => r()));
    const fakeUrl = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}/v3`;

    // cwd vazio: nenhum .env; ambiente mínimo do serviço (sem SECRET, OWNER_DATABASE_URL nem APP_DB_PASSWORD).
    proc = spawn("node", [join(OUT, "server.js")], {
      cwd: mkdtempSync(join(tmpdir(), "card-node-")),
      env: {
        PATH: process.env.PATH ?? "",
        SERVICE: "card",
        BASE_URL: "http://localhost:3000",
        DATABASE_URL: t.cardUrl,
        CARD_ORIGIN,
        CARD_TICKET_KEY: KEY,
        ASAAS_SEAL_KEY: SEAL,
        ASAAS_BASE_URL: fakeUrl,
        CARD_PORT: "0",
      } as Record<string, string> as unknown as NodeJS.ProcessEnv, // sem NODE_ENV: como o serviço sobe
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stderr!.on("data", (c: Buffer) => (output += c.toString()));
    // Espera a linha de log "no ar" (com a porta escolhida pelo sistema); se o processo sair antes, falha.
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: proc.stdout! });
      lines.on("line", (line) => {
        output += `${line}\n`;
        try {
          const row = JSON.parse(line) as { msg?: string; data?: { port?: unknown } };
          if (row.msg === "serviço de cartão no ar" && typeof row.data?.port === "number") resolve(row.data.port);
        } catch {
          /* linha que não é JSON: só guarda */
        }
      });
      proc.on("exit", (code) => reject(new Error(`serviço saiu antes de subir (código ${code}): ${output}`)));
    });
    base = `http://127.0.0.1:${port}`;
  }, HEAVY_TEST_MS);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      await exited;
    }
    if (fakeServer) await new Promise<void>((r) => fakeServer.close(() => r()));
    await t?.drop();
  }, HEAVY_TEST_MS);

  const post = (body: unknown) =>
    fetch(`${base}/api/card`, { method: "POST", headers: { "content-type": "application/json", origin: CARD_ORIGIN }, body: JSON.stringify(body) });

  test("healthz, form.js, form.css e a página do iframe", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const js = await fetch(`${base}/form.js`);
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(read("form.js"));
    expect((await fetch(`${base}/form.css`)).status).toBe(200);
    const page = await fetch(`${base}/form/${shop.storeId}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors http://localhost:3000");
  });

  test("bilhete inválido: 403 com ticketExpired, sem chegar ao pagamento", async () => {
    const res = await post({ ticket: "nada", orderPublicId: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "ticket", ticketExpired: false });
  });

  test("POST /api/card com bilhete válido contra o Asaas falso: aprovado, pedido pago, cartão fora do log", async () => {
    const order = await newCardOrder(shop.storeId, shop.offerId, `node-${randomUUID()}@example.com`);
    const ticket = issueCardTicket({ storeId: shop.storeId, orderId: order.id, publicId: order.publicId }, KEY);
    const res = await post({
      storeId: shop.storeId,
      ticket,
      orderPublicId: order.publicId,
      idempotencyKey: randomUUID(),
      installments: 1,
      card: { holderName: "TITULAR NODE", number: PAN, expiryMonth: "08", expiryYear: "2034", ccv: "987" },
      holder: { cpf: "52998224725", postalCode: "01310100", addressNumber: "100" },
    });
    expect(await res.json()).toEqual({ status: "approved" });
    expect(res.status).toBe(200);
    expect((await t.ownerDb.select().from(orders).where(eq(orders.id, order.id)))[0]!.status).toBe("paid");
    expect(output).not.toContain(PAN);
    expect(output).not.toContain('"987"');
    expect(output).not.toContain("ccv");
    expect(output).not.toContain("TITULAR NODE");
  });
});
