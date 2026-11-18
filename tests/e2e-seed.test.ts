import { describe, expect, test } from "bun:test";
import { e2eRoutesEnabled, handleE2e } from "@/lib/e2e-seed";

describe("rota só do smoke E2E", () => {
  test("ligada só com E2E_SEED_ROUTES=1 (que o env recusa fora de loopback); ASAAS_BASE_URL não liga", () => {
    expect(e2eRoutesEnabled({ E2E_SEED_ROUTES: undefined, ASAAS_BASE_URL: "http://127.0.0.1:4010" })).toBe(false);
    expect(e2eRoutesEnabled({ E2E_SEED_ROUTES: "0", ASAAS_BASE_URL: undefined })).toBe(false);
    expect(e2eRoutesEnabled({ E2E_SEED_ROUTES: "1", ASAAS_BASE_URL: undefined })).toBe(true);
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
