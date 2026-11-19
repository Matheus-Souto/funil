// Higiene de testes: proíbe skip/only/todo, retries e esperas fixas em tests/ e e2e/.
// Varre só arquivos *.test.ts, *.spec.ts e *.test.sh (não helpers nem fakes).
// Exceção: playwright.config.ts precisa ter `retries: 0` explícito.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface Rule {
  re: RegExp;
  label: string;
  shellOnly?: boolean;
}
const FORBIDDEN: readonly Rule[] = [
  { re: /\.(skip|only|todo|fixme)(\.each|If)?\s*[(`]/, label: "skip/only/todo/fixme" },
  { re: /\bx(it|describe|test)\s*(\.each)?\s*[(`]/, label: "xit/xdescribe/xtest" },
  { re: /retry/i, label: "retry" },
  { re: /waitForTimeout/, label: "waitForTimeout" },
  { re: /setTimeout\(/, label: "setTimeout(" },
  { re: /Bun\.sleep/, label: "Bun.sleep" },
  { re: /sleep\(/, label: "sleep(" },
  { re: /(^|[\s;&|(`])sleep(\s|$)/, label: "sleep (shell)", shellOnly: true },
];
const RETRIES = /retries\s*:\s*([^\s,};]+)/;
const SCANNED = /\.(test\.ts|spec\.ts|test\.sh)$/;

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SCANNED.test(name)) out.push(p);
  }
}

function retriesViolation(line: string): boolean {
  const m = RETRIES.exec(line);
  if (!m) return false;
  return m[1] !== "0";
}

/** Devolve violações no formato "arquivo:linha: motivo". Vazio = limpo. */
export function scan(root: string): string[] {
  const problems: string[] = [];
  const files: string[] = [];
  walk(join(root, "tests"), files);
  walk(join(root, "e2e"), files);

  for (const file of files) {
    const rel = relative(root, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const isShell = file.endsWith(".sh");
        const hit = FORBIDDEN.find((r) => (!r.shellOnly || isShell) && r.re.test(line));
        if (hit) problems.push(`${rel}:${i + 1}: ${hit.label}`);
        if (retriesViolation(line)) problems.push(`${rel}:${i + 1}: retries com valor maior que 0`);
      });
  }

  const cfg = join(root, "playwright.config.ts");
  if (!existsSync(cfg)) {
    problems.push("playwright.config.ts:1: arquivo ausente (precisa de `retries: 0` explícito)");
  } else {
    const lines = readFileSync(cfg, "utf8").split("\n");
    const bad = lines.findIndex(retriesViolation);
    if (bad >= 0) problems.push(`playwright.config.ts:${bad + 1}: retries com valor maior que 0`);
    else if (!lines.some((l) => /retries\s*:\s*0(?![\w.])/.test(l)))
      problems.push("playwright.config.ts:1: falta `retries: 0` explícito");
  }
  return problems;
}

if (import.meta.main) {
  const problems = scan(process.cwd());
  if (problems.length > 0) {
    console.error("Higiene de testes falhou:\n" + problems.map((p) => `  ${p}`).join("\n"));
    process.exit(1);
  }
  console.log("higiene de testes: ok");
}
