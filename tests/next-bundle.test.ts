// Build do app (Next) sem o caminho antigo do cartão: depois de `bun run build`, nenhum arquivo em .next/server (código,
// manifestos e source maps, que carregam o fonte original) tem a rota antiga, a função de cobrança, o corpo da cobrança
// com cartão nem os campos de cartão do checkout antigo. A cobrança só existe no serviço isolado (dist/card).
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Marcadores do caminho antigo. Sobrevivem à minificação: textos (caminho da rota, `autocomplete`), chave de objeto (o
 * corpo da cobrança: `creditCardHolderInfo` só existe nele) e nome exportado (os mapas de exportação do bundler guardam
 * o nome como texto; os source maps guardam o fonte inteiro).
 */
export const OLD_CARD_MARKERS = ["api/checkout/card", "payWithCard", "creditCardHolderInfo", "cc-csc"] as const;

/** Cada arquivo (recursivo) que contém algum marcador, com os marcadores achados. */
export function findCardMarkers(dir: string, markers: readonly string[] = OLD_CARD_MARKERS): { file: string; markers: string[] }[] {
  const out: { file: string; markers: string[] }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const text = readFileSync(p, "latin1");
        const hit = markers.filter((m) => text.includes(m));
        if (hit.length > 0) out.push({ file: relative(dir, p), markers: hit });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe("findCardMarkers (o próprio detector)", () => {
  test("acha cada marcador em qualquer profundidade, inclusive em source map; não acusa arquivo limpo", () => {
    const dir = mkdtempSync(join(tmpdir(), "funil-next-scan-"));
    mkdirSync(join(dir, "app", "api", "x"), { recursive: true });
    writeFileSync(join(dir, "app-paths-manifest.json"), JSON.stringify({ "/api/checkout/card/route": "app/api/checkout/card/route.js" }));
    writeFileSync(join(dir, "app", "api", "x", "chunk.js"), 'e.s(["payWithCard",()=>a]);const b={customer:c,creditCardHolderInfo:{name:d}}');
    writeFileSync(join(dir, "app", "page.js.map"), JSON.stringify({ sourcesContent: ['<input autoComplete="cc-csc" />'] }));
    writeFileSync(join(dir, "limpo.js"), 'fetch("/api/card");const creditCard=1;const cc="cc-number"');
    expect(findCardMarkers(dir)).toEqual([
      { file: "app-paths-manifest.json", markers: ["api/checkout/card"] },
      { file: join("app", "api", "x", "chunk.js"), markers: ["payWithCard", "creditCardHolderInfo"] },
      { file: join("app", "page.js.map"), markers: ["cc-csc"] },
    ]);
  });
});

describe("bun run build: .next/server sem o caminho antigo do cartão", () => {
  let build: { status: number | null; out: string };
  beforeAll(() => {
    // Sem o NODE_ENV=test do bun test: o Next exige production (padrão do `next build`).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV")) as NodeJS.ProcessEnv;
    const r = spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, env, encoding: "utf8" });
    build = { status: r.status, out: `${r.stdout}${r.stderr}`.slice(-4000) };
  }, 600_000);

  test("o build passa e não tem a rota antiga, payWithCard, o corpo da cobrança nem os campos do cartão", () => {
    expect(build).toMatchObject({ status: 0 });
    expect(findCardMarkers(join(ROOT, ".next", "server"))).toEqual([]);
  });
});
