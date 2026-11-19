import { defineConfig } from "@playwright/test";

// O app de produção é subido por scripts/verify.sh; aqui só se aponta para ele.
export default defineConfig({
  testDir: "./e2e",
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: process.env.PW_OUTPUT_DIR ?? "./.verify/playwright",
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3000",
    viewport: { width: 375, height: 812 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
