// Catálogo de ferramentas MCP (src/lib/mcp/tools.ts): toda ação classificada (exposta, sensível, pública/sistema,
// negada a token ou excluída com motivo), lista por papel, nomes, esquemas de entrada e projeções por lista branca
// (nenhum dado pessoal do comprador sai pelo MCP).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { ActionError, runAction, TOKEN_DENIED } from "@/lib/actions/core";
import { hasPermission, ROLE_PERMISSIONS, type Permission, type Role } from "@/lib/actions/permissions";
import { listActions } from "@/lib/actions/registry";
import { ownerDb } from "@/lib/db/client";
import { auditLog, orders } from "@/lib/db/schema";
import { callMcpTool, MCP_EXCLUDED, mcpTools, type McpTool } from "@/lib/mcp/tools";
import { getOrderDetail } from "@/lib/orders/panel";
import { createTestDb, type TestDb } from "./db";
import { panelCall, seedOrder, seedPanelStore, type PanelStore } from "./panel-helpers";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
const tool = (role: Role, name: string): McpTool => {
  const found = mcpTools(role).find((x) => x.name === name);
  if (!found) throw new Error(`ferramenta ausente para ${role}: ${name}`);
  return found;
};
const call = (storeId: string, role: Role = "owner") => ({ storeId, tokenId: randomUUID(), role });
const codeOf = (e: unknown) => (e instanceof ActionError ? e.code : String(e));

describe("classificação", () => {
  test("todo módulo de src/ com defineAction( está importado em all.ts", () => {
    const root = join(import.meta.dir, "..");
    const src = join(root, "src");
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => readFileSync(join(src, f), "utf8").includes("defineAction("));
    const all = readFileSync(join(src, "lib/actions/all.ts"), "utf8");
    const imported = new Set([...all.matchAll(/^import "@\/([^"]+)";$/gm)].map((m) => m[1]));
    const missing = files.map((f) => relative(src, join(src, f)).replace(/\.tsx?$/, "")).filter((m) => !imported.has(m));
    expect(missing).toEqual([]);
    expect(files.length).toBeGreaterThan(10);
  });

  test("toda ação registrada está classificada", () => {
    const exposed = new Set(mcpTools("owner").map((x) => x.action));
    const missing = listActions()
      .filter(
        (a) =>
          !a.sensitive &&
          a.permission !== "public" &&
          a.permission !== "system" &&
          !TOKEN_DENIED.includes(a.permission) &&
          !(a.name in MCP_EXCLUDED) &&
          !exposed.has(a.name),
      )
      .map((a) => a.name);
    expect(missing).toEqual([]);
  });

  test("toda exclusão aponta para uma ação registrada e tem motivo", () => {
    const names = new Set(listActions().map((a) => a.name));
    for (const [name, reason] of Object.entries(MCP_EXCLUDED)) {
      expect(names.has(name)).toBe(true);
      expect(reason.length).toBeGreaterThan(5);
    }
    expect(Object.keys(MCP_EXCLUDED)).toEqual(
      expect.arrayContaining(["orders.export", "products.create", "connections.testSmtp", "connections.testResend", "connections.testTelegram"]),
    );
  });

  test("nenhuma ação sensível, excluída, pública, de sistema ou negada a token aparece em nenhum papel", () => {
    const byName = new Map(listActions().map((a) => [a.name, a]));
    for (const role of ROLES) {
      for (const x of mcpTools(role)) {
        const a = byName.get(x.action)!;
        expect(a.sensitive).toBe(false);
        expect(x.action in MCP_EXCLUDED).toBe(false);
        expect(a.permission === "public" || a.permission === "system").toBe(false);
        expect(TOKEN_DENIED.includes(a.permission as Permission)).toBe(false);
        expect(hasPermission(role, x.permission)).toBe(true);
        expect(x.permission).toBe(a.permission as Permission);
      }
    }
    const owner = mcpTools("owner").map((x) => x.action);
    for (const name of ["orders.export", "products.create", "connections.testSmtp", "connections.removeTelegram", "orders.refund", "team.list"]) {
      expect(owner).not.toContain(name);
    }
  });

  test("reader vê só catálogo, métricas e o relatório de vendas pagas", () => {
    expect(
      mcpTools("reader")
        .map((x) => x.name)
        .sort(),
    ).toEqual(["metrics_breakdown", "metrics_summary", "offers_get", "offers_list", "orders_paidReport", "products_list"]);
  });

  test("traffic não lista pedidos nem ações de connections.write", () => {
    const names = mcpTools("traffic").map((x) => x.name);
    expect(names).not.toContain("orders_list");
    expect(names).not.toContain("orders_get");
    expect(mcpTools("traffic").some((x) => x.permission === "connections.write")).toBe(false);
  });
});

describe("nomes e esquemas", () => {
  test("nomes casam ^[a-zA-Z0-9_-]{1,64}$, são únicos e vêm do nome da ação", () => {
    for (const role of ROLES) {
      const names = mcpTools(role).map((x) => x.name);
      expect(new Set(names).size).toBe(names.length);
      for (const x of mcpTools(role)) {
        expect(x.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
        expect(x.name).toBe(x.action.replaceAll(".", "_"));
        expect(x.description.length).toBeGreaterThan(0);
        expect(x.inputSchema).toMatchObject({ type: "object" });
      }
    }
  });

  test("orders_list não tem q no inputSchema nem na descrição, e input() descarta q", () => {
    const list = tool("owner", "orders_list");
    const props = (list.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty("q");
    expect(props).toHaveProperty("status");
    expect(list.description).not.toMatch(/busca/);
    expect(list.input!({ q: "maria@gmail.com", page: 2 })).toEqual({ page: 2 });
  });

  test("campo com default não é obrigatório e data aparece como texto ISO", () => {
    const list = tool("owner", "orders_list").inputSchema as { required?: string[] };
    expect(list.required ?? []).not.toContain("page");
    const summary = tool("owner", "metrics_summary").inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(summary.properties.from).toMatchObject({ type: "string", format: "date-time" });
    expect(summary.required).toEqual(["from", "to"]);
  });
});

describe("callMcpTool", () => {
  let s: PanelStore;
  let order: Awaited<ReturnType<typeof seedOrder>>;
  const PII = {
    name: "Zuleica Quintanilha",
    email: "zuleica.quintanilha@exemplo.com",
    phone: "21998123044",
    cpf: "52998224725",
    ip: "203.0.113.77",
    ua: "AgenteSecreto/9.9",
    fbc: "fbc-valor-secreto",
    fbp: "fbp-valor-secreto",
    fbclid: "fbclid-valor-secreto",
  };

  beforeAll(async () => {
    s = await seedPanelStore();
    order = await seedOrder(s, { name: PII.name, email: PII.email, cpf: PII.cpf, utmSource: "fb", utmCampaign: "c1", ref: "amigo" });
    await ownerDb
      .update(orders)
      .set({
        clientIp: PII.ip,
        userAgent: PII.ua,
        fbc: PII.fbc,
        fbp: PII.fbp,
        firstTouch: { utm_source: "fb", fbclid: PII.fbclid, ref: "amigo" },
        lastTouch: { utm_source: "fb", utm_campaign: "c1", fbclid: PII.fbclid },
      })
      .where(eq(orders.id, order.id));
  });

  const leaks = (out: unknown) => {
    const text = JSON.stringify(out);
    return Object.values(PII).filter((v) => text.includes(v));
  };

  test("grava auditoria com origin mcp e actor.kind token", async () => {
    const c = call(s.storeId);
    const out = await callMcpTool(tool("owner", "orders_resend"), c, { orderId: order.id });
    expect(out).toMatchObject({ orderId: order.id });
    const rows = await t.ownerDb.select().from(auditLog).where(eq(auditLog.action, "orders.resend"));
    const row = rows.find((r) => (r.actor as { tokenId?: string }).tokenId === c.tokenId);
    expect(row).toMatchObject({ origin: "mcp", ok: true, actor: { kind: "token", tokenId: c.tokenId, role: "owner" } });
  });

  test("o papel do token vale: reader chamando orders_list é forbidden", async () => {
    expect(await callMcpTool(tool("owner", "orders_list"), call(s.storeId, "reader"), {}).then(() => "ok", codeOf)).toBe("forbidden");
  });

  test("ferramenta montada à mão para ação fora do catálogo é forbidden", async () => {
    const fake: McpTool = { ...tool("owner", "orders_list"), name: "orders_export", action: "orders.export", permission: "orders.export" };
    expect(await callMcpTool(fake, call(s.storeId), {}).then(() => "ok", codeOf)).toBe("forbidden");
  });

  test("orders_get: lista branca com comprador mascarado, CPF estrito e sem IP, user agent, fbc, fbp nem fbclid", async () => {
    const out = (await callMcpTool(tool("owner", "orders_get"), call(s.storeId), { id: order.id })) as Record<string, unknown>;
    expect(leaks(out)).toEqual([]);
    expect(out.buyer).toEqual({ name: "Z***", email: "z***@exemplo.com", phone: "(**) *****-3044", cpfMasked: "***.***.***-25" });
    expect(Object.keys(out).sort()).toEqual(
      [
        "attribution",
        "buyer",
        "code",
        "createdAt",
        "expiresAt",
        "hasBump",
        "id",
        "items",
        "manualAmountCents",
        "method",
        "offer",
        "paidAt",
        "payments",
        "refund",
        "status",
        "subtotalCents",
        "timeline",
        "totalCents",
      ].sort(),
    );
    expect(out.attribution).toEqual({ firstTouch: { utm_source: "fb" }, lastTouch: { utm_source: "fb", utm_campaign: "c1" }, ref: "amigo" });
    const timeline = out.timeline as Record<string, unknown>[];
    expect(timeline.length).toBeGreaterThan(0);
    for (const e of timeline) expect(Object.keys(e).sort()).toEqual(["at", "kind", "label"]);
  });

  test("orders_get pelo painel continua com a máscara do painel", async () => {
    const d = await runAction(getOrderDetail, panelCall(s.storeId), { id: order.id });
    expect(d.buyer.cpfMasked).toBe("***.982.247-**");
  });

  test("orders_list: q é ignorado e cada pedido sai com nome e e-mail mascarados", async () => {
    const out = (await callMcpTool(tool("owner", "orders_list"), call(s.storeId), { q: "nao-existe-ninguem" })) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(out.total).toBeGreaterThan(0);
    expect(leaks(out)).toEqual([]);
    const mine = out.items.find((i) => i.id === order.id)!;
    expect(mine).toMatchObject({ buyerName: "Z***", email: "z***@exemplo.com", offerName: "Maná bíblico", status: "paid" });
  });

  test("metrics_summary: origem e indicação com cara de dado pessoal viram (oculto)", async () => {
    const m = await seedPanelStore("Métricas");
    await seedOrder(m, { utmSource: "maria.silva@gmail.com", ref: "21987654321" });
    await seedOrder(m, { utmSource: "Maria Silva" });
    await seedOrder(m, { utmSource: "fb", ref: "amigo" });
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const out = (await callMcpTool(tool("reader", "metrics_summary"), call(m.storeId, "reader"), range)) as {
      paid: number;
      bySource: { source: string; paid: number; revenueCents: number }[];
      byRef: { ref: string; paid: number; revenueCents: number }[];
    };
    const text = JSON.stringify(out);
    expect(text).not.toContain("maria");
    expect(text).not.toContain("Maria");
    expect(text).not.toContain("21987654321");
    expect(out.paid).toBe(3);
    expect(out.bySource).toEqual([
      { source: "(oculto)", paid: 2, revenueCents: 1980 },
      { source: "fb", paid: 1, revenueCents: 990 },
    ]);
    expect(out.byRef).toEqual([
      { ref: "(oculto)", paid: 1, revenueCents: 990 },
      { ref: "amigo", paid: 1, revenueCents: 990 },
    ]);
  });
});
