import { describe, expect, test } from "bun:test";
import { e2eRoutesEnabled, handleE2e } from "@/lib/e2e-seed";

describe("rota só do smoke E2E", () => {
  test("ligada só com ASAAS_BASE_URL em loopback (Asaas falso do smoke)", () => {
    expect(e2eRoutesEnabled(undefined)).toBe(false);
    expect(e2eRoutesEnabled("https://api.asaas.com/v3")).toBe(false);
    expect(e2eRoutesEnabled("http://127.0.0.1:4010")).toBe(true);
  });

  test("desligada -> 404 antes de olhar a sessão; ligada sem dono -> 401", async () => {
    const req = () => new Request("http://x/api/test-only/action", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    let asked = false;
    const off = await handleE2e(req(), "action", { enabled: false, actor: async () => ((asked = true), null) });
    expect(off.status).toBe(404);
    expect(asked).toBe(false);
    expect((await handleE2e(req(), "action", { enabled: true, actor: async () => null })).status).toBe(401);
    const support = async () => ({ storeId: "s", actor: { kind: "user" as const, userId: "u", role: "support" as const } });
    expect((await handleE2e(req(), "action", { enabled: true, actor: support })).status).toBe(401);
  });
});
