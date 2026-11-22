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
