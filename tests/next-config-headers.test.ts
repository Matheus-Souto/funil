// Cabeçalhos do next.config.ts: o Next aplica todas as regras que casam com a rota, e na mesma chave a última vence. A
// regra do PDF original (`sandbox`) tem de vir depois da regra geral de /admin; se a ordem mudar, o PDF enviado pela loja
// volta a poder rodar na origem do painel.
import { describe, expect, test } from "bun:test";
import config from "../next.config";

type Rule = { source: string; headers: Array<{ key: string; value: string }> };

describe("next.config.ts headers()", () => {
  test("a regra do PDF original vem depois da de /admin e leva frame-ancestors 'none'; sandbox", async () => {
    const rules = (await config.headers!()) as Rule[];
    const admin = rules.findIndex((r) => r.source === "/admin/:path*");
    const pdf = rules.findIndex((r) => r.source === "/admin/api/products/:id/file");
    expect(admin).toBeGreaterThanOrEqual(0);
    expect(pdf).toBeGreaterThan(admin);
    const csp = (r: Rule) => r.headers.find((h) => h.key === "Content-Security-Policy")?.value;
    expect(csp(rules[admin]!)).toBe("frame-ancestors 'none'");
    expect(csp(rules[pdf]!)).toBe("frame-ancestors 'none'; sandbox");
    expect(rules[admin]!.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    // Nenhuma regra depois da do PDF casa com ele e troca a CSP.
    for (const r of rules.slice(pdf + 1)) expect(r.source.startsWith("/admin")).toBe(false);
  });
});

/** Casa um caminho com o `source` do Next (só os formatos usados aqui: `:param` e `:param*`). */
const matches = (source: string, path: string) =>
  new RegExp(`^${source.replace(/\/:\w+\*/g, "(?:/.*)?").replace(/:\w+/g, "[^/]+")}$`).test(path);

describe("página do convite da equipe", () => {
  test("/admin/convite/<token>: no-referrer e no-store (o token vai no caminho), sem perder a proteção contra frame", async () => {
    const rules = (await config.headers!()) as Rule[];
    // O Next aplica todas as regras que casam; na mesma chave, a última vence.
    const merged = new Map<string, string>();
    for (const r of rules.filter((x) => matches(x.source, "/admin/convite/abc"))) for (const h of r.headers) merged.set(h.key, h.value);
    expect(merged.get("Referrer-Policy")).toBe("no-referrer");
    expect(merged.get("Cache-Control")).toBe("no-store");
    expect(merged.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(merged.get("X-Frame-Options")).toBe("DENY");
    // Só a página do convite: o resto do painel não ganha esses cabeçalhos.
    const login = new Map<string, string>();
    for (const r of rules.filter((x) => matches(x.source, "/admin/login"))) for (const h of r.headers) login.set(h.key, h.value);
    expect(login.has("Referrer-Policy")).toBe(false);
  });
});
