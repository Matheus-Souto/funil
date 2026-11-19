import { defineConfig } from "@playwright/test";

// Smoke de deploy (tests/smoke.sh): roda contra a pilha do compose.yaml (Caddy com HTTPS interno em localhost).
// Fora do `bun test` (bunfig.toml: pathIgnorePatterns) e fora do verify comum (só roda via tests/smoke.sh).
export default defineConfig({
  testDir: ".",
  testMatch: "flow.spec.ts",
  retries: 0,
  // O fluxo gera, envia e carimba um PDF de ~46 MB: mais que os 30 s padrão por teste.
  timeout: 240_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: process.env.SMOKE_OUT ? `${process.env.SMOKE_OUT}/playwright` : "../../.verify/smoke/playwright",
  use: {
    baseURL: process.env.BASE_URL,
    // Certificado da CA interna do Caddy (DOMAIN=localhost): o navegador do teste não confia nela.
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
