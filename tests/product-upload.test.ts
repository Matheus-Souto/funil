import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleProductUpload } from "@/lib/catalog/upload-http";
import { listProducts } from "@/lib/catalog/products";
import { runAction, type Actor } from "@/lib/actions/core";
import { readBytesCapped } from "@/lib/http";
import type { PanelActor } from "@/lib/auth/session";
import config from "../next.config";
import { createTestDb, seedStore, type TestDb } from "./db";
import { CORRUPT_PDF, ENCRYPTED_PDF, VALID_PDF } from "./pdf-fixtures";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const MB = 1_048_576;
const LIMIT = 52_428_800;

const asPanel = (storeId: string, role: "owner" | "traffic" | "support" = "owner"): PanelActor => ({
  storeId,
  actor: { kind: "user", userId: "u1", role },
});
const actorOwner: Actor = { kind: "user", userId: "u1", role: "owner" };
const list = (storeId: string) => runAction(listProducts, { storeId, actor: actorOwner, origin: "panel" }, {});

function upload(body: BodyInit | null, panel: PanelActor, query = "name=Curso&fileName=curso.pdf", headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost/admin/api/products/upload?${query}`, {
    method: "POST",
    headers: { "content-type": "application/pdf", ...headers },
    body,
    // @ts-expect-error necessário para corpo em stream no runtime
    duplex: "half",
  });
  return handleProductUpload(req, { actor: async () => panel });
}

/** Corpo infinito de pedaços de 1 MB que conta quantos pedaços foram puxados e se foi cancelado. */
function endless() {
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        state.pulls++;
        c.enqueue(new Uint8Array(MB));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { state, body };
}

describe("rota de upload do PDF", () => {
  test("envia o PDF e cria o produto", async () => {
    const { storeId } = await seedStore();
    const res = await upload(VALID_PDF as BodyInit, asPanel(storeId));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; name: string; fileSize: number };
    expect(json).toMatchObject({ name: "Curso", fileSize: VALID_PDF.length });
    expect((await list(storeId)).map((p) => p.id)).toEqual([json.id]);
  });

  test("corpo em streaming acima de 50 MB é abortado sem ler além do limite (413)", async () => {
    const { storeId } = await seedStore();
    const { state, body } = endless();
    const res = await upload(body, asPanel(storeId));
    expect(res.status).toBe(413);
    expect(state.cancelled).toBe(true);
    // 50 MB = 50 pedaços de 1 MB; só pode ter puxado mais um pedaço antes de abortar.
    expect(state.pulls).toBeLessThanOrEqual(LIMIT / MB + 2);
    expect(await list(storeId)).toEqual([]);
  });

  test("Content-Length declarado acima do limite recusa sem ler o corpo", async () => {
    const { storeId } = await seedStore();
    const { state, body } = endless();
    const res = await upload(body, asPanel(storeId), undefined, { "content-length": String(LIMIT + 1) });
    expect(res.status).toBe(413);
    expect(state.pulls).toBe(0);
  });

  test("sem permissão products.write: 403 sem ler o corpo", async () => {
    const { storeId } = await seedStore();
    for (const role of ["traffic", "support"] as const) {
      const { state, body } = endless();
      const res = await upload(body, asPanel(storeId, role));
      expect(res.status).toBe(403);
      expect(state.pulls).toBe(0);
    }
    expect(await list(storeId)).toEqual([]);
  });

  test("exige Content-Type application/pdf (defesa de CSRF por formulário) e nome", async () => {
    const { storeId } = await seedStore();
    expect((await upload(VALID_PDF as BodyInit, asPanel(storeId), undefined, { "content-type": "text/plain" })).status).toBe(415);
    expect((await upload(VALID_PDF as BodyInit, asPanel(storeId), "fileName=a.pdf")).status).toBe(400);
  });

  test("PDF inválido, criptografado ou corrompido: 400 com mensagem clara, nada criado", async () => {
    const { storeId } = await seedStore();
    for (const bytes of [ENCRYPTED_PDF, CORRUPT_PDF, new Uint8Array(), Buffer.from("texto")]) {
      const res = await upload(bytes as BodyInit, asPanel(storeId));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/PDF/);
    }
    expect(await list(storeId)).toEqual([]);
  });

  test("readBytesCapped: devolve os bytes até o limite e null acima", async () => {
    const ok = new Request("http://x", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect([...(await readBytesCapped(ok, 3))!]).toEqual([1, 2, 3]);
    const over = new Request("http://x", { method: "POST", body: new Uint8Array([1, 2, 3, 4]) });
    expect(await readBytesCapped(over, 3)).toBeNull();
  });
});

test("o limite global de server actions volta ao padrão do Next (sem 70 MB)", () => {
  const limit = config.experimental?.serverActions?.bodySizeLimit;
  expect(limit === undefined || limit === "1mb").toBe(true);
});
