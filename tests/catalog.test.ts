import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ActionError, runAction, type Actor, type Origin } from "@/lib/actions/core";
import { listActions } from "@/lib/actions/registry";
import { createStorage, storage } from "@/lib/storage";
import { auditLog, offer, offerProduct, product } from "@/lib/db/schema";
import { withStore } from "@/lib/db/client";
import { checkPdfBytes, createProduct, deleteProduct, listProducts, updateProduct } from "@/lib/catalog/products";
import { createOffer, getOffer, getPublicOffer, listOffers, setOfferProducts, updateOffer, updateOfferPrice } from "@/lib/catalog/offers";
import { env } from "@/lib/env";
import { HEAVY_TEST_MS, createTestDb, seedProduct, seedStore, type TestDb } from "./db";
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
  productIds: [productId],
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
  }, HEAVY_TEST_MS);

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
  }, HEAVY_TEST_MS);

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
    expect(await code(call(createOffer, storeId, owner, offerInput(p.id, { slug: "outra" })))).toBe("invalid_input");
  });

  test("produto de outra loja não é visível", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const p = await mkProduct(a.storeId);
    expect(await code(call(updateProduct, b.storeId, owner, { id: p.id, name: "x" }))).toBe("not_found");
    expect(await code(call(createOffer, b.storeId, owner, offerInput(p.id)))).toBe("invalid_input");
  });
});

describe("offers", () => {
  test("caso do dono: R$ 9,90 com bump de R$ 17,10 lido por getPublic", async () => {
    const { storeId } = await seedStore();
    const main = await mkProduct(storeId, "Principal");
    const full = await mkProduct(storeId, "Completo");
    const o = await call(createOffer, storeId, owner, {
      ...offerInput(main.id),
      bump: { productIds: [full.id], priceCents: 1710, label: "Leve o completo" },
      thankYouText: "Obrigado!",
    });
    const res = await call(getPublicOffer, storeId, pub, { slug: "oferta-1" }, "public");
    expect(res).toEqual({
      id: o.id,
      slug: "oferta-1",
      name: "Oferta",
      products: [{ name: "Principal" }],
      priceCents: 990,
      methods: ["pix", "card"],
      pixMode: "manual",
      maxInstallments: 1,
      bump: { products: [{ name: "Completo" }], priceCents: 1710, label: "Leve o completo" },
      thankYouText: "Obrigado!",
      pixelId: null,
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
      { productIds: [] },
      { productIds: [p.id, p.id] },
      { productId: p.id },
      { bumpProductId: q.id, bumpPriceCents: 100 },
      { bump: { productIds: [q.id] } },
      { bump: { productIds: [], priceCents: 100 } },
      { bump: { productIds: [q.id], priceCents: 0 } },
      { bump: { productIds: [p.id], priceCents: 100 } },
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
    expect(await code(call(createOffer, a.storeId, owner, offerInput(pa.id, { bump: { productIds: [pb.id], priceCents: 500 } })))).toBe("invalid_input");
  });

  test("offers.update não aceita campos de preço e atualiza o resto", async () => {
    const { storeId } = await seedStore();
    const p = await mkProduct(storeId);
    const o = await call(createOffer, storeId, owner, offerInput(p.id));
    for (const f of [{ priceCents: 1 }, { bumpPriceCents: 1 }, { bumpProductId: p.id }, { productId: p.id }, { productIds: [p.id] }, { bumpLabel: "x" }]) {
      expect(await code(call(updateOffer, storeId, owner, { id: o.id, ...f }))).toBe("invalid_input");
    }
    const u = await call(updateOffer, storeId, owner, { id: o.id, name: "Novo nome", methods: ["pix"], maxInstallments: 3 });
    expect(u.name).toBe("Novo nome");
    expect(u.priceCents).toBe(990);
    expect(u.methods).toEqual(["pix"]);
    expect(await code(call(updateOffer, storeId, owner, { id: "00000000-0000-4000-8000-000000000000", name: "x" }))).toBe("not_found");
  });

  test("offers.updatePrice é sensível e muda só o preço (o bump vai por offers.setProducts)", async () => {
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
    const u = await call(updateOfferPrice, storeId, owner, { id: o.id, priceCents: 1990 });
    expect(u.priceCents).toBe(1990);
    expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id, priceCents: 1990, bump: { productId: q.id, priceCents: 1710 } }))).toBe("invalid_input");
    expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id, bump: null }))).toBe("invalid_input");
    expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id, priceCents: 0 }))).toBe("invalid_input");
    expect(await code(call(updateOfferPrice, storeId, owner, { id: o.id }))).toBe("invalid_input");
    expect(await code(call(updateOfferPrice, storeId, traffic, { id: o.id, priceCents: 5 }))).toBe("forbidden");
    expect(await code(call(updateOfferPrice, storeId, owner, { id: "00000000-0000-4000-8000-000000000000", priceCents: 5 }))).toBe("not_found");
  });
});

describe("oferta com N produtos (exemplos do Almanaque Kids)", () => {
  const KIDS = ["Almanaque Bíblico Kids", "Pack de jogos", "Datas especiais", "Cartões de versículos", "Diário de oração", "Escola dominical"];
  const mkMany = async (storeId: string, names: string[]) => Promise.all(names.map((n) => seedProduct(storeId, n)));
  const ids = (ps: { id: string }[]) => ps.map((p) => p.id);
  const rowsOf = (storeId: string, offerId: string) =>
    withStore(storeId, (tx) =>
      tx
        .select({ productId: offerProduct.productId, kind: offerProduct.kind, position: offerProduct.position })
        .from(offerProduct)
        .where(eq(offerProduct.offerId, offerId))
        .orderBy(offerProduct.kind, offerProduct.position),
    );
  const legacyOf = async (storeId: string, offerId: string) => {
    const [o] = await withStore(storeId, (tx) =>
      tx
        .select({ productId: offer.productId, bumpProductId: offer.bumpProductId, bumpPriceCents: offer.bumpPriceCents, bumpLabel: offer.bumpLabel })
        .from(offer)
        .where(eq(offer.id, offerId)),
    );
    return o!;
  };

  test("Completo: 6 principais por R$ 27,00, gravados em ordem; get, list e getPublic devolvem a lista", async () => {
    const { storeId } = await seedStore();
    const six = await mkMany(storeId, KIDS);
    const o = await call(createOffer, storeId, owner, { ...offerInput(six[0]!.id, { slug: "completo", name: "Completo", priceCents: 2700 }), productIds: ids(six) });
    expect(await rowsOf(storeId, o.id)).toEqual(six.map((p, i) => ({ productId: p.id, kind: "main", position: i })));
    // Colunas antigas (leitores ainda não migrados): o primeiro principal, sem bump.
    expect(await legacyOf(storeId, o.id)).toEqual({ productId: six[0]!.id, bumpProductId: null, bumpPriceCents: null, bumpLabel: null });
    const got = await call(getOffer, storeId, support, { id: o.id });
    expect(got.products.map((p) => p.name)).toEqual(KIDS);
    expect(got.products.every((p) => p.deletedAt === null)).toBe(true);
    expect(got.bump).toBeNull();
    const [listed] = await call(listOffers, storeId, traffic, {});
    expect(listed!.products.map((p) => p.id)).toEqual(ids(six));
    const pubOffer = await call(getPublicOffer, storeId, pub, { slug: "completo" }, "public");
    expect(pubOffer.products).toEqual(KIDS.map((name) => ({ name })));
    expect(pubOffer.priceCents).toBe(2700);
    expect(pubOffer.bump).toBeNull();
  });

  test("Almanaque: 1 principal por R$ 9,90 e bump de 5 produtos por R$ 17,10 com rótulo \"5 Kits Extras\"", async () => {
    const { storeId } = await seedStore();
    const [alm, ...kits] = await mkMany(storeId, KIDS);
    const o = await call(createOffer, storeId, owner, {
      ...offerInput(alm!.id, { slug: "almanaque", name: "Almanaque" }),
      bump: { productIds: ids(kits), priceCents: 1710, label: "5 Kits Extras" },
    });
    expect(await rowsOf(storeId, o.id)).toEqual([
      ...kits.map((p, i) => ({ productId: p.id, kind: "bump", position: i })),
      { productId: alm!.id, kind: "main", position: 0 },
    ]);
    expect(await legacyOf(storeId, o.id)).toEqual({ productId: alm!.id, bumpProductId: kits[0]!.id, bumpPriceCents: 1710, bumpLabel: "5 Kits Extras" });
    const got = await call(getOffer, storeId, owner, { id: o.id });
    expect(got.bump?.products.map((p) => p.name)).toEqual(KIDS.slice(1));
    expect(got.bump?.priceCents).toBe(1710);
    expect(got.bump?.label).toBe("5 Kits Extras");
    const res = await call(getPublicOffer, storeId, pub, { slug: "almanaque" }, "public");
    expect(res.products).toEqual([{ name: KIDS[0] }]);
    expect(res.bump).toEqual({ products: KIDS.slice(1).map((name) => ({ name })), priceCents: 1710, label: "5 Kits Extras" });
  });

  test("recusas: duplicado (no grupo e entre principal e bump), bump de 2 sem rótulo, 21 produtos, inexistente, apagado e de outra loja", async () => {
    const a = await seedStore();
    const b = await seedStore();
    const ps = await mkMany(a.storeId, Array.from({ length: 21 }, (_, i) => `P${i}`));
    const [p0, p1, p2] = ps;
    const foreign = await seedProduct(b.storeId, "Da outra loja");
    const gone = await seedProduct(a.storeId, "Apagado");
    await withStore(a.storeId, (tx) => tx.update(product).set({ deletedAt: new Date() }).where(eq(product.id, gone.id)));
    const base = offerInput(p0!.id);
    const bad: Record<string, unknown>[] = [
      { productIds: [p0!.id, p1!.id, p0!.id] },
      { bump: { productIds: [p1!.id, p1!.id], priceCents: 100, label: "Kits" } },
      { productIds: [p0!.id, p1!.id], bump: { productIds: [p2!.id, p1!.id], priceCents: 100, label: "Kits" } },
      { bump: { productIds: [p1!.id, p2!.id], priceCents: 100 } },
      { bump: { productIds: [p1!.id, p2!.id], priceCents: 100, label: "   " } },
      { productIds: ids(ps) },
      { productIds: [p0!.id], bump: { productIds: ids(ps.slice(1)).concat(foreign.id), priceCents: 100, label: "Kits" } },
      { productIds: [p0!.id, "00000000-0000-4000-8000-000000000000"] },
      { productIds: [p0!.id, gone.id] },
      { bump: { productIds: [gone.id], priceCents: 100 } },
      { productIds: [p0!.id, foreign.id] },
      { bump: { productIds: [foreign.id], priceCents: 100 } },
    ];
    for (const over of bad) {
      expect({ over, code: await code(call(createOffer, a.storeId, owner, { ...base, ...over })) }).toEqual({ over, code: "invalid_input" });
    }
    expect(await call(listOffers, a.storeId, owner, {})).toEqual([]);
    // Limites: 20 por grupo passam.
    const ok = await call(createOffer, a.storeId, owner, { ...base, productIds: ids(ps.slice(0, 20)) });
    expect((await rowsOf(a.storeId, ok.id)).length).toBe(20);
    // As mesmas regras valem para offers.setProducts, e a recusa não muda nada.
    for (const over of bad) {
      const input = { id: ok.id, productIds: base.productIds, bump: null, ...over };
      expect({ over, code: await code(call(setOfferProducts, a.storeId, owner, input)) }).toEqual({ over, code: "invalid_input" });
    }
    expect((await rowsOf(a.storeId, ok.id)).length).toBe(20);
  });

  test("offers.setProducts é sensível (MCP pede aprovação; support não pode), troca a lista e regrava as colunas antigas", async () => {
    const { storeId } = await seedStore();
    const [alm, ...kits] = await mkMany(storeId, KIDS);
    const o = await call(createOffer, storeId, owner, offerInput(alm!.id, { slug: "almanaque" }));
    expect(listActions().find((x) => x.name === "offers.setProducts")?.sensitive).toBe(true);
    const input = { id: o.id, productIds: [alm!.id], bump: { productIds: ids(kits), priceCents: 1710, label: "5 Kits Extras" } };
    expect(await code(call(setOfferProducts, storeId, owner, input, "mcp"))).toBe("approval_required");
    expect(await code(call(setOfferProducts, storeId, support, input))).toBe("forbidden");
    expect(await code(call(setOfferProducts, storeId, traffic, input))).toBe("forbidden");
    expect((await call(getOffer, storeId, owner, { id: o.id })).bump).toBeNull();

    const withBump = await call(setOfferProducts, storeId, owner, input);
    expect(withBump.bump?.products.map((p) => p.id)).toEqual(ids(kits));
    expect(await legacyOf(storeId, o.id)).toEqual({ productId: alm!.id, bumpProductId: kits[0]!.id, bumpPriceCents: 1710, bumpLabel: "5 Kits Extras" });

    // Reordena e troca: principal vira os 6 do Completo (ordem nova), sem bump.
    const order = [kits[2]!, alm!, kits[0]!, kits[4]!, kits[1]!, kits[3]!];
    const swapped = await call(setOfferProducts, storeId, owner, { id: o.id, productIds: ids(order), bump: null });
    expect(swapped.products.map((p) => p.id)).toEqual(ids(order));
    expect(swapped.bump).toBeNull();
    expect(await rowsOf(storeId, o.id)).toEqual(order.map((p, i) => ({ productId: p.id, kind: "main", position: i })));
    expect(await legacyOf(storeId, o.id)).toEqual({ productId: kits[2]!.id, bumpProductId: null, bumpPriceCents: null, bumpLabel: null });
    expect((await call(getPublicOffer, storeId, pub, { slug: "almanaque" }, "public")).products.map((p) => p.name)).toEqual(order.map((p) => KIDS[[alm, ...kits].indexOf(p)]));

    // Bump de 1 produto: o rótulo é opcional.
    const one = await call(setOfferProducts, storeId, owner, { id: o.id, productIds: [alm!.id], bump: { productIds: [kits[0]!.id], priceCents: 500 } });
    expect(one.bump).toEqual({ products: [{ id: kits[0]!.id, name: KIDS[1], deletedAt: null }], priceCents: 500, label: null });
    expect(await code(call(setOfferProducts, storeId, owner, { ...input, id: "00000000-0000-4000-8000-000000000000" }))).toBe("not_found");
  });

  test("getPublic: um principal apagado esconde a oferta; um produto do bump apagado esconde só o bump", async () => {
    const { storeId } = await seedStore();
    const six = await mkMany(storeId, KIDS);
    const extras = await mkMany(storeId, ["Kit 1", "Kit 2", "Kit 3", "Kit 4", "Kit 5"]);
    const completo = await call(createOffer, storeId, owner, { ...offerInput(six[0]!.id, { slug: "completo", priceCents: 2700 }), productIds: ids(six) });
    const almanaque = await call(createOffer, storeId, owner, {
      ...offerInput(six[0]!.id, { slug: "almanaque" }),
      bump: { productIds: ids(extras), priceCents: 1710, label: "5 Kits Extras" },
    });
    // products.delete enxerga o produto em qualquer posição de oferta ativa (não só no primeiro).
    expect(await code(call(deleteProduct, storeId, owner, { id: six[3]!.id }))).toBe("conflict");
    expect(await code(call(deleteProduct, storeId, owner, { id: extras[3]!.id }))).toBe("conflict");

    await call(updateOffer, storeId, owner, { id: completo.id, active: false });
    await call(updateOffer, storeId, owner, { id: almanaque.id, active: false });
    await call(deleteProduct, storeId, owner, { id: six[3]!.id });
    await call(deleteProduct, storeId, owner, { id: extras[3]!.id });
    await call(updateOffer, storeId, owner, { id: completo.id, active: true });
    await call(updateOffer, storeId, owner, { id: almanaque.id, active: true });

    expect(await code(call(getPublicOffer, storeId, pub, { slug: "completo" }, "public"))).toBe("not_found");
    const alm = await call(getPublicOffer, storeId, pub, { slug: "almanaque" }, "public");
    expect(alm.products).toEqual([{ name: KIDS[0] }]);
    expect(alm.bump).toBeNull();
    // O painel ainda vê o produto apagado na oferta (para corrigir).
    const got = await call(getOffer, storeId, owner, { id: completo.id });
    expect(got.products.map((p) => p.deletedAt !== null)).toEqual([false, false, false, true, false, false]);
  });
});
