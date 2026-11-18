import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ActionError, runAction, type Actor, type Origin } from "@/lib/actions/core";
import { listActions } from "@/lib/actions/registry";
import { createStorage, storage } from "@/lib/storage";
import { auditLog, product } from "@/lib/db/schema";
import { withStore } from "@/lib/db/client";
import { checkPdfBytes, createProduct, deleteProduct, listProducts, updateProduct } from "@/lib/catalog/products";
import { createOffer, getOffer, getPublicOffer, listOffers, updateOffer, updateOfferPrice } from "@/lib/catalog/offers";
import { env } from "@/lib/env";
import { createTestDb, seedStore, type TestDb } from "./db";
import { CORRUPT_PDF, ENCRYPTED_PDF, makePdf, VALID_PDF } from "./pdf-fixtures";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const owner: Actor = { kind: "user", userId: "u1", role: "owner" };
const traffic: Actor = { kind: "user", userId: "u2", role: "traffic" };
const support: Actor = { kind: "user", userId: "u3", role: "support" };
const pub: Actor = { kind: "public" };

const pdfBytes = () => VALID_PDF;

const call = <I, O>(a: Parameters<typeof runAction<I, O>>[0], storeId: string, actor: Actor, raw: unknown, origin: Origin = "panel") =>
  runAction(a, { storeId, actor, origin }, raw);
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as ActionError).code;

async function mkProduct(storeId: string, name = "Produto") {
  return call(createProduct, storeId, owner, { name, fileName: `${name}.pdf`, file: pdfBytes() });
}
const offerInput = (productId: string, over: Record<string, unknown> = {}) => ({
  slug: "oferta-1",
  name: "Oferta",
  productId,
  priceCents: 990,
  methods: ["pix", "card"],
  pixMode: "manual",
  ...over,
});

describe("storage", () => {
  test("put/get/delete e leitura de chave ausente", async () => {
    const s = createStorage(() => join(tmpdir(), "funil-storage-a"));
    await s.put("a/b/c.bin", new Uint8Array([1, 2, 3]));
    expect([...(await s.get("a/b/c.bin"))!]).toEqual([1, 2, 3]);
    await s.delete("a/b/c.bin");
    expect(await s.get("a/b/c.bin")).toBeNull();
  });

  test("recusa .., caminho absoluto e NUL", async () => {
    const s = createStorage(() => join(tmpdir(), "funil-storage-b"));
    for (const key of ["../x", "a/../../x", "/etc/passwd", "a\0b", "", "a//b", "a\\b"]) {
      await expect(s.put(key, new Uint8Array([1]))).rejects.toThrow("Chave de armazenamento inválida");
      await expect(s.get(key)).rejects.toThrow();
      await expect(s.delete(key)).rejects.toThrow();
    }
  });

  test("gravação atômica não deixa temporário e sobrescreve", async () => {
    const root = await mkdtemp(join(tmpdir(), "funil-storage-c-"));
    const s = createStorage(() => root);
    await s.put("k.pdf", new Uint8Array([1]));
    await s.put("k.pdf", new Uint8Array([2, 2]));
    expect([...(await s.get("k.pdf"))!]).toEqual([2, 2]);
    expect(await readdir(root)).toEqual(["k.pdf"]);
  });
});

describe("products", () => {
  test("bytes que não são PDF viram invalid_input e nada é criado", async () => {
    const { storeId } = await seedStore();
    const bad = { name: "X", fileName: "x.pdf", file: Buffer.from("não sou pdf") };
    expect(await code(call(createProduct, storeId, owner, bad))).toBe("invalid_input");
    expect(await call(listProducts, storeId, owner, {})).toEqual([]);
  });

  test("checkPdfBytes: assinatura, tamanho, estrutura, criptografia e páginas", async () => {
    expect(await checkPdfBytes(VALID_PDF)).toBeNull();
    expect(await checkPdfBytes(new Uint8Array())).toMatch(/PDF/);
    expect(await checkPdfBytes(Buffer.from("texto qualquer"))).toMatch(/PDF/);
    const over = Buffer.alloc(52_428_801, 65);
    over.write("%PDF-");
    expect(await checkPdfBytes(over)).toMatch(/50 MB/);
    expect(await checkPdfBytes(CORRUPT_PDF)).toMatch(/corrompido|inválido/i);
    expect(await checkPdfBytes(ENCRYPTED_PDF)).toMatch(/protegido|criptograf|senha/i);
    expect(await checkPdfBytes(await makePdf(500))).toBeNull();
    expect(await checkPdfBytes(await makePdf(501))).toMatch(/500/);
  });

  test("PDF criptografado, corrompido após %PDF- ou com páginas demais é invalid_input com mensagem clara e nada é criado", async () => {
    const { storeId } = await seedStore();
    for (const file of [ENCRYPTED_PDF, CORRUPT_PDF, await makePdf(501)]) {
      const err = (await call(createProduct, storeId, owner, { name: "X", fileName: "x.pdf", file }).catch((e) => e)) as ActionError;
      expect(err.code).toBe("invalid_input");
      expect(err.message).toMatch(/PDF/);
    }
    expect(await call(listProducts, storeId, owner, {})).toEqual([]);
    const dir = join(env.DATA_DIR, "files", "products", storeId);
    expect(await readdir(dir).catch(() => [] as string[])).toEqual([]);
  });

  test("cria, grava o arquivo no armazenamento e a auditoria não guarda os bytes", async () => {
    const { storeId } = await seedStore();
    const raw = await makePdf(3);
    const p = await call(createProduct, storeId, owner, { name: "Curso", fileName: "curso.pdf", file: raw });
    expect(p.fileSize).toBe(raw.length);
    expect(p).not.toHaveProperty("fileKey");
    const [row] = await withStore(storeId, (tx) => tx.select().from(product).where(eq(product.id, p.id)));
    expect(row!.fileKey).toBe(`products/${storeId}/${p.id}.pdf`);
    expect(Buffer.from((await storage.get(row!.fileKey))!).equals(Buffer.from(raw))).toBe(true);
    const audits = await withStore(storeId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, "products.create")));
    expect(audits.length).toBe(1);
    expect(audits[0]!.input).toEqual({ name: "Curso", fileName: "curso.pdf", fileSize: raw.length });
  });

  test("a ação aceita bytes, não base64 em texto (fileBase64 antigo é invalid_input)", async () => {
    const { storeId } = await seedStore();
    const old = { name: "X", fileName: "x.pdf", fileBase64: Buffer.from(VALID_PDF).toString("base64") };
    expect(await code(call(createProduct, storeId, owner, old))).toBe("invalid_input");
  });

  test("falha ao gravar o arquivo desfaz a transação (sem linha de produto)", async () => {
    const { storeId } = await seedStore();
    const spy = spyOn(storage, "put").mockRejectedValueOnce(new Error("disco cheio"));
    try {
      expect(await call(createProduct, storeId, owner, { name: "X", fileName: "x.pdf", file: pdfBytes() }).catch((e) => e.message)).toBe("disco cheio");
    } finally {
      spy.mockRestore();
    }
    expect(await call(listProducts, storeId, owner, {})).toEqual([]);
  });

  test("falha na auditoria depois do put não deixa arquivo órfão", async () => {
    const { storeId } = await seedStore();
    // NUL no ator faz o insert da auditoria (jsonb) falhar depois de run ter gravado o arquivo.
    const broken: Actor = { kind: "user", userId: "a\u0000b", role: "owner" };
    const err = await call(createProduct, storeId, broken, { name: "X", fileName: "x.pdf", file: pdfBytes() }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await call(listProducts, storeId, owner, {})).toEqual([]);
    const dir = join(env.DATA_DIR, "files", "products", storeId);
    expect(await readdir(dir).catch(() => [] as string[])).toEqual([]);
  });

  test("traffic e support não criam; support lê", async () => {
    const { storeId } = await seedStore();
    const input = { name: "X", fileName: "x.pdf", file: pdfBytes() };
    expect(await code(call(createProduct, storeId, traffic, input))).toBe("forbidden");
    expect(await code(call(createProduct, storeId, support, input))).toBe("forbidden");
    await mkProduct(storeId);
    expect((await call(listProducts, storeId, support, {})).length).toBe(1);
  });

  test("update muda nome; delete é sensível, soft, some da lista e recusa se há oferta ativa", async () => {
    const { storeId } = await seedStore();
    const p = await mkProduct(storeId);
    expect((await call(updateProduct, storeId, owner, { id: p.id, name: "Novo" })).name).toBe("Novo");
    expect(await code(call(deleteProduct, storeId, owner, { id: p.id }, "mcp"))).toBe("approval_required");
    const o = await call(createOffer, storeId, owner, offerInput(p.id));
    expect(await code(call(deleteProduct, storeId, owner, { id: p.id }))).toBe("conflict");
    await call(updateOffer, storeId, owner, { id: o.id, active: false });
    await call(deleteProduct, storeId, owner, { id: p.id });
    expect(await call(listProducts, storeId, owner, {})).toEqual([]);
    const [row] = await withStore(storeId, (tx) => tx.select().from(product).where(eq(product.id, p.id)));
    expect(row!.deletedAt).not.toBeNull();
    expect(await storage.get(row!.fileKey)).not.toBeNull();
    expect(await code(call(createOffer, storeId, owner, offerInput(p.id, { slug: "outra" })))).toBe("not_found");
  });

  test("produto de outra loja não é visível", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const p = await mkProduct(a.storeId);
    expect(await code(call(updateProduct, b.storeId, owner, { id: p.id, name: "x" }))).toBe("not_found");
    expect(await code(call(createOffer, b.storeId, owner, offerInput(p.id)))).toBe("not_found");
  });
});

describe("offers", () => {
  test("caso do dono: R$ 9,90 com bump de R$ 17,10 lido por getPublic", async () => {
    const { storeId } = await seedStore();
    const main = await mkProduct(storeId, "Principal");
    const full = await mkProduct(storeId, "Completo");
    const o = await call(createOffer, storeId, owner, {
      ...offerInput(main.id),
      bumpProductId: full.id,
      bumpPriceCents: 1710,
      bumpLabel: "Leve o completo",
      thankYouText: "Obrigado!",
    });
    const res = await call(getPublicOffer, storeId, pub, { slug: "oferta-1" }, "public");
    expect(res).toEqual({
      id: o.id,
      slug: "oferta-1",
      name: "Oferta",
      productName: "Principal",
      priceCents: 990,
      methods: ["pix", "card"],
      pixMode: "manual",
      maxInstallments: 1,
      bump: { productName: "Completo", priceCents: 1710, label: "Leve o completo" },
      thankYouText: "Obrigado!",
    });
    const json = JSON.stringify(res);
    for (const leak of ["fileKey", "file_key", "fileName", "storeId", "products/"]) expect(json).not.toContain(leak);
  });

  test("sem bump, bump é null", async () => {
    const { storeId } = await seedStore();
    const main = await mkProduct(storeId);
    await call(createOffer, storeId, owner, offerInput(main.id));
    expect((await call(getPublicOffer, storeId, pub, { slug: "oferta-1" }, "public")).bump).toBeNull();
  });

  test("getPublic de oferta inativa ou inexistente é not_found", async () => {
    const { storeId } = await seedStore();
    const main = await mkProduct(storeId);
    const o = await call(createOffer, storeId, owner, offerInput(main.id));
    await call(updateOffer, storeId, owner, { id: o.id, active: false });
    expect(await code(call(getPublicOffer, storeId, pub, { slug: "oferta-1" }, "public"))).toBe("not_found");
    expect(await code(call(getPublicOffer, storeId, pub, { slug: "nao-existe" }, "public"))).toBe("not_found");
  });

  test("getPublic não enxerga oferta de outra loja", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const p = await mkProduct(a.storeId);
    await call(createOffer, a.storeId, owner, offerInput(p.id));
    expect(await code(call(getPublicOffer, b.storeId, pub, { slug: "oferta-1" }, "public"))).toBe("not_found");
  });

  test("slug repetido na mesma loja é conflict; em outra loja, ok", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const pa = await mkProduct(a.storeId);
    const pb = await mkProduct(b.storeId);
    await call(createOffer, a.storeId, owner, offerInput(pa.id));
    expect(await code(call(createOffer, a.storeId, owner, offerInput(pa.id)))).toBe("conflict");
    expect((await call(createOffer, b.storeId, owner, offerInput(pb.id))).slug).toBe("oferta-1");
  });

  test("traffic e support não criam oferta; ambos leem", async () => {
    const { storeId } = await seedStore();
    const p = await mkProduct(storeId);
    expect(await code(call(createOffer, storeId, traffic, offerInput(p.id)))).toBe("forbidden");
    expect(await code(call(createOffer, storeId, support, offerInput(p.id)))).toBe("forbidden");
    const o = await call(createOffer, storeId, owner, offerInput(p.id));
    expect((await call(listOffers, storeId, traffic, {})).length).toBe(1);
    expect((await call(getOffer, storeId, support, { id: o.id })).id).toBe(o.id);
  });

  test("validações de entrada: slug, preço, métodos, parcelas, bump", async () => {
    const { storeId } = await seedStore();
    const p = await mkProduct(storeId);
    const q = await mkProduct(storeId, "Outro");
    const bad: Record<string, unknown>[] = [
      { slug: "AB" },
      { slug: "Maiuscula" },
      { slug: "com espaco" },
      { slug: "a".repeat(61) },
      { priceCents: 0 },
      { priceCents: 9.9 },
      { methods: [] },
      { methods: ["boleto"] },
      { pixMode: "x" },
      { maxInstallments: 0 },
      { maxInstallments: 13 },
      { bumpProductId: q.id },
      { bumpPriceCents: 100 },
      { bumpProductId: q.id, bumpPriceCents: 0 },
      { bumpProductId: p.id, bumpPriceCents: 100 },
    ];
    for (const over of bad) expect(await code(call(createOffer, storeId, owner, offerInput(p.id, over)))).toBe("invalid_input");
    const ok = await call(createOffer, storeId, owner, offerInput(p.id, { slug: "abc", maxInstallments: 12, methods: ["card"] }));
    expect(ok.maxInstallments).toBe(12);
  });

  test("bump com produto de outra loja é recusado", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const pa = await mkProduct(a.storeId);
    const pb = await mkProduct(b.storeId);
    expect(await code(call(createOffer, a.storeId, owner, offerInput(pa.id, { bumpProductId: pb.id, bumpPriceCents: 500 })))).toBe("not_found");
  });

  test("offers.update não aceita campos de preço e atualiza o resto", async () => {
    const { storeId } = await seedStore();
    const p = await mkProduct(storeId);
    const o = await call(createOffer, storeId, owner, offerInput(p.id));
    for (const f of [{ priceCents: 1 }, { bumpPriceCents: 1 }, { bumpProductId: p.id }]) {
      expect(await code(call(updateOffer, storeId, owner, { id: o.id, ...f }))).toBe("invalid_input");
    }
    const u = await call(updateOffer, storeId, owner, { id: o.id, name: "Novo nome", methods: ["pix"], maxInstallments: 3 });
    expect(u.name).toBe("Novo nome");
    expect(u.priceCents).toBe(990);
    expect(u.methods).toEqual(["pix"]);
    expect(await code(call(updateOffer, storeId, owner, { id: "00000000-0000-4000-8000-000000000000", name: "x" }))).toBe("not_found");
  });

  test("offers.updatePrice é sensível, muda preço e bump", async () => {
    const { storeId } = await seedStore();
    const p = await mkProduct(storeId);
    const q = await mkProduct(storeId, "Completo");
    const o = await call(createOffer, storeId, owner, offerInput(p.id));
    expect(listActions().find((a) => a.name === "offers.updatePrice")?.sensitive).toBe(true);
    expect(listActions().find((a) => a.name === "offers.update")?.sensitive).toBe(false);
    for (const origin of ["mcp", "ai"] as const) {
      expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id, priceCents: 1 }, origin))).toBe("approval_required");
    }
    expect((await call(getOffer, storeId, owner, { id: o.id })).priceCents).toBe(990);
    const u = await call(updateOfferPrice, storeId, owner, { id: o.id, priceCents: 1990, bump: { productId: q.id, priceCents: 1710 } });
    expect(u.priceCents).toBe(1990);
    expect(u.bumpPriceCents).toBe(1710);
    expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id, bump: { productId: p.id, priceCents: 5 } }))).toBe("invalid_input");
    expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id, priceCents: 0 }))).toBe("invalid_input");
    expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id }))).toBe("invalid_input");
    const removed = await call(updateOfferPrice, storeId, owner, { id: o.id, bump: null });
    expect(removed.bumpProductId).toBeNull();
    expect(removed.bumpPriceCents).toBeNull();
    expect(await code(call(updateOfferPrice, storeId, traffic, { id: o.id, priceCents: 5 }))).toBe("forbidden");
  });

  test("mudar o produto principal para o do bump é recusado", async () => {
    const { storeId } = await seedStore();
    const p = await mkProduct(storeId);
    const q = await mkProduct(storeId, "Completo");
    const o = await call(createOffer, storeId, owner, offerInput(p.id, { bumpProductId: q.id, bumpPriceCents: 100 }));
    expect(await code(call(updateOffer, storeId, owner, { id: o.id, productId: q.id }))).toBe("invalid_input");
  });
});
