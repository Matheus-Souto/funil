import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../../scripts/check-test-hygiene";

// Os padrões proibidos são montados em pedaços para que este arquivo não acuse a si mesmo.
const SKIP = `test${".skip"}(`;
const ONLY = `it${".only"}(`;
const TODO = `test${".todo"}(`;
const SLEEP = `await Bun${".sleep"}(10)`;
const WAIT = `await page.wait${"ForTimeout"}(50)`;
const TIMER = `set${"Timeout"}(() => {}, 5)`;

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const GOOD_CONFIG = "export default { retries: 0 };\n";

test("aceita arquivo limpo", () => {
  const dir = fixture({
    "tests/ok.test.ts": `test("ok", () => { expect(1).toBe(1); });\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(dir)).toEqual([]);
  rmSync(dir, { recursive: true });
});

test.each([
  ["skip", SKIP],
  ["only", ONLY],
  ["todo", TODO],
  ["sleep do Bun", SLEEP],
  ["espera fixa do Playwright", WAIT],
  ["setTimeout", TIMER],
])("acusa %s com arquivo:linha", (_nome, trecho) => {
  const dir = fixture({
    "e2e/bad.spec.ts": `import x from "y";\n${trecho}\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  const found = scan(dir);
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("e2e/bad.spec.ts:2");
  rmSync(dir, { recursive: true });
});

test("acusa retries maior que zero e aceita retries: 0 em teste", () => {
  const bad = fixture({
    "tests/a.test.ts": `const cfg = { retries${": 2"} };\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(bad)).toHaveLength(1);
  const good = fixture({
    "tests/a.test.ts": "const cfg = { retries: 0 };\n",
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(good)).toEqual([]);
  rmSync(bad, { recursive: true });
  rmSync(good, { recursive: true });
});

test("playwright.config.ts precisa de retries: 0 explícito", () => {
  const missing = fixture({ "playwright.config.ts": "export default {};\n" });
  expect(scan(missing)[0]).toContain("playwright.config.ts");
  const bad = fixture({ "playwright.config.ts": `export default { retries${": 1"} };\n` });
  expect(scan(bad).length).toBeGreaterThan(0);
  rmSync(missing, { recursive: true });
  rmSync(bad, { recursive: true });
});

test("não varre helpers nem fora de tests/ e e2e/", () => {
  const dir = fixture({
    "tests/helpers/util.ts": `${SLEEP}\n`,
    "src/lib/x.ts": `${TIMER}\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(dir)).toEqual([]);
  rmSync(dir, { recursive: true });
});

test.each([
  ["sleep com espaço", `sl${"eep"} 1`],
  ["sleep depois de ;", `echo a; sl${"eep"} 0.5`],
  ["sleep no início da linha com número", `  sl${"eep"} 2`],
])("*.test.sh acusa %s", (_nome, trecho) => {
  const dir = fixture({
    "tests/verify/x.test.sh": `#!/usr/bin/env bash\n${trecho}\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  const found = scan(dir);
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("tests/verify/x.test.sh:2");
  rmSync(dir, { recursive: true });
});

test("*.test.sh limpo é aceito e a palavra sleep em outra palavra não conta", () => {
  const dir = fixture({
    "tests/verify/x.test.sh": "echo asleep\nsleepy=1\n",
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(dir)).toEqual([]);
  rmSync(dir, { recursive: true });
});

test.each([
  ["xit", `x${"it"}("a", () => {});`],
  ["xdescribe", `x${"describe"}("a", () => {});`],
  ["xtest", `x${"test"}("a", () => {});`],
  ["test.fixme", `test${".fixme"}("a", () => {});`],
  ["skip.each", `test${".skip.each"}([1])("a", () => {});`],
  ["only.each", `it${".only.each"}([1])("a", () => {});`],
  ["describe.skip", `describe${".skip"}("a", () => {});`],
  ["skipIf", `test${".skipIf"}(true)("a", () => {});`],
])("acusa %s", (_nome, trecho) => {
  const dir = fixture({
    "tests/y.test.ts": `${trecho}\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(dir)).toHaveLength(1);
  rmSync(dir, { recursive: true });
});

test("aceita nomes parecidos: next, text, expect.extend", () => {
  const dir = fixture({
    "tests/z.test.ts": `const next = 1; const text = "x"; expect.extend({});\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(dir)).toEqual([]);
  rmSync(dir, { recursive: true });
});

test("varre também *.test.tsx e *.spec.tsx", () => {
  const dir = fixture({
    "tests/componente.test.tsx": `${TIMER}\n`,
    "e2e/tela.spec.tsx": `${SKIP}"x", () => {});\n`,
    "playwright.config.ts": GOOD_CONFIG,
  });
  expect(scan(dir).sort()).toEqual(["e2e/tela.spec.tsx:1: skip/only/todo/fixme", `tests/componente.test.tsx:1: set${"Timeout"}(`]);
  rmSync(dir, { recursive: true });
});
