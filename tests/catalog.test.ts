import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { ActionError, runAction, type Actor, type Origin } from "@/lib/actions/core";
import { listActions } from "@/lib/actions/registry";
import { createStorage, storage } from "@/lib/storage";
import { auditLog, offer, offerProduct, product, store } from "@/lib/db/schema";
import { withStore } from "@/lib/db/client";
import { checkPdfBytes, createProduct, deleteProduct, listProducts, readProductFile, updateProduct } from "@/lib/catalog/products";
import { createOffer, getOffer, getPublicOffer, listOffers, setOfferProducts, setOfferSlug, updateOffer, updateOfferPrice } from "@/lib/catalog/offers";
import {
  changeDialog,
  emptyOptionLabel,
  fillBumpLines,
  focusAfterMove,
  focusAfterRemove,
  moveAnnouncement,
  moveItem,
  offerChanges,
  productsProblem,
  removeAnnouncement,
  removeAt,
  runSaveSteps,
  saveCall,
  saveOutcome,
} from "@/lib/catalog/offer-editing";
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

describe("products.pageCount", () => {
  test("o envio grava o número de páginas contado na validação e a lista devolve", async () => {
    const { storeId } = await seedStore();
    const p = await call(createProduct, storeId, owner, { name: "Apostila", fileName: "apostila.pdf", file: await makePdf(3) });
    expect(p.pageCount).toBe(3);
    const list = await call(listProducts, storeId, owner, {});
    expect(list.find((x) => x.id === p.id)?.pageCount).toBe(3);
  });
});

describe("products.file (PDF para o painel)", () => {
  test("devolve os bytes e o nome do arquivo; support lê, sem permissão não; outra loja e excluído viram not_found", async () => {
    const { storeId } = await seedStore();
    const raw = await makePdf(2);
    const p = await call(createProduct, storeId, owner, { name: "Guia", fileName: "guia.pdf", file: raw });
    const out = await call(readProductFile, storeId, support, { id: p.id });
    expect(out.fileName).toBe("guia.pdf");
    expect(Buffer.from(out.bytes).equals(Buffer.from(raw))).toBe(true);
    expect(await code(call(readProductFile, storeId, pub, { id: p.id }))).toBe("forbidden");
    const other = await seedStore();
    expect(await code(call(readProductFile, other.storeId, owner, { id: p.id }))).toBe("not_found");
    await call(deleteProduct, storeId, owner, { id: p.id });
    expect(await code(call(readProductFile, storeId, owner, { id: p.id }))).toBe("not_found");
  });
});

describe("colunas antigas da oferta", () => {
  test("offer.product_id e offer.bump_product_id não existem mais; bump_price_cents e bump_label continuam", async () => {
    const rows = await t.ownerDb.execute(sql`select column_name from information_schema.columns where table_name = 'offer'`);
    const cols = rows.map((r) => (r as { column_name: string }).column_name);
    expect(cols).not.toContain("product_id");
    expect(cols).not.toContain("bump_product_id");
    expect(cols).toContain("bump_price_cents");
    expect(cols).toContain("bump_label");
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
      leadCapture: null,
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

  test("getPublic devolve leadCapture só quando a loja tem a captura ligada (com o e-mail de privacidade)", async () => {
    const { storeId } = await seedStore();
    const main = await mkProduct(storeId);
    await call(createOffer, storeId, owner, offerInput(main.id));
    const read = async () => (await call(getPublicOffer, storeId, pub, { slug: "oferta-1" }, "public")).leadCapture;
    expect(await read()).toBeNull();
    // e-mail preenchido com a captura desligada: continua sem aviso
    await t.ownerDb.update(store).set({ privacyEmail: "privacidade@example.com" }).where(eq(store.id, storeId));
    expect(await read()).toBeNull();
    await t.ownerDb.update(store).set({ leadCapture: true }).where(eq(store.id, storeId));
    expect(await read()).toEqual({ privacyEmail: "privacidade@example.com" });
    await t.ownerDb.update(store).set({ leadCapture: false }).where(eq(store.id, storeId));
    expect(await read()).toBeNull();
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
    for (const f of [{ priceCents: 1 }, { bumpPriceCents: 1 }, { bumpProductId: p.id }, { productId: p.id }, { productIds: [p.id] }, { bumpLabel: "x" }, { slug: "outro-endereco" }]) {
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
    expect(listActions().find((a) => a.name === "offers.update")?.sensitive).toBe(true); // D2: a oferta inteira passa pela fila
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
        .select({ bumpPriceCents: offer.bumpPriceCents, bumpLabel: offer.bumpLabel })
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
    expect(await legacyOf(storeId, o.id)).toEqual({ bumpPriceCents: null, bumpLabel: null });
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
    expect(await legacyOf(storeId, o.id)).toEqual({ bumpPriceCents: 1710, bumpLabel: "5 Kits Extras" });
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

  test("offers.setProducts é sensível (MCP pede aprovação; support não pode), troca a lista e regrava preço e rótulo do bump", async () => {
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
    expect(await legacyOf(storeId, o.id)).toEqual({ bumpPriceCents: 1710, bumpLabel: "5 Kits Extras" });

    // Reordena e troca: principal vira os 6 do Completo (ordem nova), sem bump.
    const order = [kits[2]!, alm!, kits[0]!, kits[4]!, kits[1]!, kits[3]!];
    const swapped = await call(setOfferProducts, storeId, owner, { id: o.id, productIds: ids(order), bump: null });
    expect(swapped.products.map((p) => p.id)).toEqual(ids(order));
    expect(swapped.bump).toBeNull();
    expect(await rowsOf(storeId, o.id)).toEqual(order.map((p, i) => ({ productId: p.id, kind: "main", position: i })));
    expect(await legacyOf(storeId, o.id)).toEqual({ bumpPriceCents: null, bumpLabel: null });
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

describe("rodada de correção 1 (concorrência, slug sensível, editor com N produtos)", () => {
  const rowsOf = (storeId: string, offerId: string) =>
    withStore(storeId, (tx) =>
      tx
        .select({ productId: offerProduct.productId, kind: offerProduct.kind, position: offerProduct.position })
        .from(offerProduct)
        .where(eq(offerProduct.offerId, offerId))
        .orderBy(offerProduct.kind, offerProduct.position),
    );

  test("setProducts concorrente na mesma oferta: fica exatamente uma das listas, sem posição repetida, preço e rótulo do bump coerentes", async () => {
    const { storeId } = await seedStore();
    const ps = await Promise.all(Array.from({ length: 7 }, (_, i) => seedProduct(storeId, `C${i}`)));
    const [p0, a1, a2, a3, b1, b2, b3] = ps.map((p) => p.id) as [string, string, string, string, string, string, string];
    const listA = [a1, a2, a3];
    const listB = [b1, b2, b3];
    for (let i = 0; i < 10; i++) {
      const o = await call(createOffer, storeId, owner, offerInput(p0, { slug: `corrida-${i}` }));
      const results = await Promise.allSettled([
        call(setOfferProducts, storeId, owner, { id: o.id, productIds: listA, bump: null }),
        call(setOfferProducts, storeId, owner, { id: o.id, productIds: listB, bump: null }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      const rows = await rowsOf(storeId, o.id);
      const ids = rows.map((r) => r.productId);
      expect([JSON.stringify(listA), JSON.stringify(listB)]).toContain(JSON.stringify(ids));
      expect(rows.map((r) => [r.kind, r.position])).toEqual([["main", 0], ["main", 1], ["main", 2]]);
      const [bumpCols] = await withStore(storeId, (tx) => tx.select({ bumpPriceCents: offer.bumpPriceCents, bumpLabel: offer.bumpLabel }).from(offer).where(eq(offer.id, o.id)));
      expect(bumpCols).toEqual({ bumpPriceCents: null, bumpLabel: null });
    }
  }, HEAVY_TEST_MS);

  test("offers.setSlug é sensível; offers.update recusa slug; a troca de slug entre ofertas não passa sem aprovação", async () => {
    const { storeId } = await seedStore();
    const p = await seedProduct(storeId, "Original");
    const x = await seedProduct(storeId, "Outro");
    const a = await call(createOffer, storeId, owner, offerInput(p.id, { slug: "oferta-a" }));
    expect(listActions().find((ac) => ac.name === "offers.setSlug")?.sensitive).toBe(true);
    for (const origin of ["mcp", "ai"] as const) {
      expect(await code(call(setOfferSlug, storeId, owner, { id: a.id, slug: "oferta-velha" }, origin))).toBe("approval_required");
    }
    expect(await code(call(setOfferSlug, storeId, support, { id: a.id, slug: "oferta-velha" }))).toBe("forbidden");
    expect(await code(call(setOfferSlug, storeId, traffic, { id: a.id, slug: "oferta-velha" }))).toBe("forbidden");
    // O contorno do revisor (S1): criar outra oferta e trocar os slugs só com ações não sensíveis.
    const b = await call(createOffer, storeId, owner, offerInput(x.id, { slug: "oferta-tmp", priceCents: 5 }));
    expect(await code(call(updateOffer, storeId, owner, { id: a.id, slug: "oferta-velha" }, "mcp"))).toBe("invalid_input");
    expect(await code(call(updateOffer, storeId, owner, { id: b.id, slug: "oferta-a" }, "mcp"))).toBe("invalid_input");
    const pubA = await call(getPublicOffer, storeId, pub, { slug: "oferta-a" }, "public");
    expect([pubA.products, pubA.priceCents]).toEqual([[{ name: "Original" }], 990]);
    // Pelo painel, o dono troca direto; slug ocupado é conflict; inválido é invalid_input; inexistente not_found.
    expect(await code(call(setOfferSlug, storeId, owner, { id: a.id, slug: "oferta-tmp" }))).toBe("conflict");
    expect(await code(call(setOfferSlug, storeId, owner, { id: a.id, slug: "Com Espaco" }))).toBe("invalid_input");
    expect(await code(call(setOfferSlug, storeId, owner, { id: "00000000-0000-4000-8000-000000000000", slug: "livre" }))).toBe("not_found");
    expect((await call(setOfferSlug, storeId, owner, { id: a.id, slug: "oferta-nova" })).slug).toBe("oferta-nova");
    expect((await call(setOfferSlug, storeId, owner, { id: a.id, slug: "oferta-nova" })).slug).toBe("oferta-nova"); // mesmo slug: ok
    expect((await call(getPublicOffer, storeId, pub, { slug: "oferta-nova" }, "public")).products).toEqual([{ name: "Original" }]);
    expect(await code(call(getPublicOffer, storeId, pub, { slug: "oferta-a" }, "public"))).toBe("not_found");
  });

  test("offers.setProducts com priceCents: produtos, bump e preço mudam juntos; uma recusa não muda nenhum dos dois", async () => {
    const { storeId } = await seedStore();
    const ps = await Promise.all(["A", "B", "C", "D"].map((n) => seedProduct(storeId, n)));
    const [a, b, c, d] = ps.map((p) => p.id) as [string, string, string, string];
    const o = await call(createOffer, storeId, owner, offerInput(a, { slug: "atomica" }));
    // Sensível como antes, também com o preço.
    const input = { id: o.id, productIds: [a, b], bump: { productIds: [c], priceCents: 500 }, priceCents: 2700 };
    expect(await code(call(setOfferProducts, storeId, owner, input, "mcp"))).toBe("approval_required");
    const r = await call(setOfferProducts, storeId, owner, input);
    expect([r.priceCents, r.products.map((p) => p.id), r.bump?.priceCents]).toEqual([2700, [a, b], 500]);
    // Sem priceCents, o preço fica como está.
    expect((await call(setOfferProducts, storeId, owner, { id: o.id, productIds: [b, a], bump: null })).priceCents).toBe(2700);
    // Recusa (produto apagado) depois de passar pela validação de entrada: nem lista nem preço mudam.
    await withStore(storeId, (tx) => tx.update(product).set({ deletedAt: new Date() }).where(eq(product.id, d)));
    expect(await code(call(setOfferProducts, storeId, owner, { id: o.id, productIds: [a, d], bump: null, priceCents: 100 }))).toBe("invalid_input");
    expect(await code(call(setOfferProducts, storeId, owner, { id: o.id, productIds: [a], bump: null, priceCents: 0 }))).toBe("invalid_input");
    const got = await call(getOffer, storeId, owner, { id: o.id });
    expect([got.priceCents, got.products.map((p) => p.id), got.bump]).toEqual([2700, [b, a], null]);
  });

  test("editor: mover e remover linhas", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]); // já no topo
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]); // já no fim
    expect(removeAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });

  test("editor: problemas nas listas (vazio, repetido, rótulo do bump com N, limite de 20)", () => {
    const ok = { productIds: ["a"], bumpOn: false, bumpProductIds: [], bumpPriceCents: null, bumpLabel: null };
    expect(productsProblem(ok)).toBeNull();
    expect(productsProblem({ ...ok, productIds: [""] })).toBe("Escolha o produto entregue (envie o PDF em Produtos).");
    expect(productsProblem({ ...ok, productIds: ["a", ""] })).toBe("Escolha um produto em cada linha ou remova a linha vazia.");
    expect(productsProblem({ ...ok, productIds: ["a", "b", "a"] })).toBe("O mesmo produto aparece mais de uma vez na oferta.");
    expect(productsProblem({ ...ok, productIds: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toBe("No máximo 20 produtos em cada lista.");
    const bump = { ...ok, bumpOn: true, bumpProductIds: ["b"], bumpPriceCents: 1710 };
    expect(productsProblem(bump)).toBeNull();
    expect(productsProblem({ ...bump, bumpPriceCents: null })).toBe("Bump: escolha o produto e o preço do acréscimo.");
    expect(productsProblem({ ...bump, bumpProductIds: ["b", ""] })).toBe("Bump: escolha o produto e o preço do acréscimo.");
    expect(productsProblem({ ...bump, bumpProductIds: ["a"] })).toBe("O mesmo produto aparece mais de uma vez na oferta.");
    expect(productsProblem({ ...bump, bumpProductIds: ["b", "c"] })).toBe("Bump com mais de um produto: preencha o título da caixa.");
    expect(productsProblem({ ...bump, bumpProductIds: ["b", "c"], bumpLabel: "5 Kits Extras" })).toBeNull();
    // Bump desligado: as linhas do bump não contam.
    expect(productsProblem({ ...bump, bumpOn: false, bumpProductIds: ["a", ""] })).toBeNull();
  });

  test("editor: o que mudou, a ação que salva e o diálogo de confirmação", () => {
    const before = { priceCents: 990, productIds: ["a"], bump: { productIds: ["b"], priceCents: 1710, label: "Quero" } };
    const none = { price: false, products: false, bump: false, label: false };
    expect(offerChanges(before, structuredClone(before))).toEqual(none);
    expect(saveCall(none)).toBeNull();
    // Só o preço: updatePrice, com o título que o E2E procura.
    const price = offerChanges(before, { ...before, priceCents: 1290 });
    expect(price).toEqual({ ...none, price: true });
    expect(saveCall(price)).toEqual({ action: "updatePrice" });
    expect(changeDialog(price)).toEqual({ title: "Alterar o preço desta oferta?", confirm: "Salvar novo preço" });
    // Só o rótulo: não fala de preço.
    const label = offerChanges(before, { ...before, bump: { ...before.bump, label: "Quero tudo" } });
    expect(label).toEqual({ ...none, label: true });
    expect(saveCall(label)).toEqual({ action: "setProducts", withPrice: false });
    expect(changeDialog(label).title).toBe("Alterar o título do bump desta oferta?");
    // Reordenar principais é mudança de produtos; produtos + preço vão juntos no setProducts.
    const both = offerChanges({ ...before, productIds: ["a", "c"] }, { ...before, productIds: ["c", "a"], priceCents: 2700 });
    expect(both).toEqual({ ...none, price: true, products: true });
    expect(saveCall(both)).toEqual({ action: "setProducts", withPrice: true });
    expect(changeDialog(both)).toEqual({ title: "Alterar o preço e os produtos desta oferta?", confirm: "Salvar alterações" });
    // Bump: ligar/desligar, preço ou lista. Rótulo junto com o bump é "o order bump".
    expect(offerChanges(before, { ...before, bump: null })).toEqual({ ...none, bump: true });
    expect(offerChanges(before, { ...before, bump: { ...before.bump, priceCents: 1000 } })).toEqual({ ...none, bump: true });
    const all = offerChanges(before, { priceCents: 2700, productIds: ["a", "c"], bump: { productIds: ["b", "d"], priceCents: 1710, label: "Kits" } });
    expect(all).toEqual({ price: true, products: true, bump: true, label: true });
    expect(changeDialog(all).title).toBe("Alterar o preço, os produtos e o order bump desta oferta?");
    expect(changeDialog({ ...none, products: true }).title).toBe("Alterar os produtos desta oferta?");
    expect(changeDialog({ ...none, bump: true }).title).toBe("Alterar o order bump desta oferta?");
  });
});

describe("Task 4, rodada de correção 1 (editor: gravação parcial, foco, bump religado; rollback do setProducts)", () => {
  const rowsOf = (storeId: string, offerId: string) =>
    withStore(storeId, (tx) =>
      tx
        .select({ productId: offerProduct.productId, kind: offerProduct.kind, position: offerProduct.position })
        .from(offerProduct)
        .where(eq(offerProduct.offerId, offerId))
        .orderBy(offerProduct.kind, offerProduct.position),
    );

  test("setProducts com priceCents: falha do banco DEPOIS de regravar a lista desfaz lista e preço juntos", async () => {
    const { storeId } = await seedStore();
    const [a, b, c] = (await Promise.all(["A", "B", "C"].map((n) => seedProduct(storeId, n)))).map((p) => p.id) as [string, string, string];
    const o = await call(createOffer, storeId, owner, { ...offerInput(a, { slug: "rollback" }), bump: { productIds: [b], priceCents: 500 } });
    const before = await rowsOf(storeId, o.id);
    // Gatilho só deste teste: o UPDATE do preço da oferta (que vem depois do delete/insert em offer_product) falha.
    await t.ownerDb.execute(sql.raw(`
      create function t4_recusa_preco() returns trigger language plpgsql as $$ begin raise exception 't4: preço recusado pelo banco'; end $$;
      create trigger t4_recusa_preco before update of price_cents on offer for each row when (new.price_cents = 4242) execute function t4_recusa_preco();
    `));
    try {
      const err = await call(setOfferProducts, storeId, owner, { id: o.id, productIds: [c, a], bump: null, priceCents: 4242 }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(String(err?.message ?? err) + String((err as { cause?: Error } | null)?.cause?.message ?? "")).toContain("t4: preço recusado pelo banco");
    } finally {
      await t.ownerDb.execute(sql.raw("drop trigger t4_recusa_preco on offer; drop function t4_recusa_preco();"));
    }
    expect(await rowsOf(storeId, o.id)).toEqual(before);
    const got = await call(getOffer, storeId, owner, { id: o.id });
    expect([got.priceCents, got.products.map((p) => p.id), got.bump?.products.map((p) => p.id)]).toEqual([990, [a], [b]]);
  });

  test("editor: sequência de gravação para no primeiro erro e diz o que foi salvo e o que falhou", async () => {
    const ran: string[] = [];
    const step = (label: string, error?: string) => ({
      label,
      run: async () => {
        ran.push(label);
        return error ? { ok: false as const, error } : { ok: true as const };
      },
    });
    const all = await runSaveSteps([step("preço"), step("endereço"), step("demais dados")]);
    expect([all, ran]).toEqual([{ saved: ["preço", "endereço", "demais dados"], failed: null }, ["preço", "endereço", "demais dados"]]);
    expect(saveOutcome(all, "Oferta salva.")).toEqual({ tone: "ok", text: "Oferta salva." });

    ran.length = 0;
    const mid = await runSaveSteps([step("produtos e preço"), step("endereço", "Já existe uma oferta com esse endereço"), step("demais dados")]);
    expect(ran).toEqual(["produtos e preço", "endereço"]); // depois da falha, nada mais roda
    expect(mid).toEqual({ saved: ["produtos e preço"], failed: { label: "endereço", error: "Já existe uma oferta com esse endereço" } });
    expect(saveOutcome(mid, "Oferta salva.")).toEqual({
      tone: "error",
      text: "Salvo: produtos e preço. Não foi salvo: endereço. Já existe uma oferta com esse endereço",
    });
    const two = await runSaveSteps([step("preço"), step("endereço"), step("demais dados", "Falhou")]);
    expect(saveOutcome(two, "x").text).toBe("Salvo: preço e endereço. Não foi salvo: demais dados. Falhou");

    // Falha na primeira: nada salvo, só o erro (como antes).
    const first = await runSaveSteps([step("preço", "Preço inválido"), step("endereço")]);
    expect(first).toEqual({ saved: [], failed: { label: "preço", error: "Preço inválido" } });
    expect(saveOutcome(first, "x")).toEqual({ tone: "error", text: "Preço inválido" });
  });

  test("editor: religar o bump não repete produto (vazias e repetidas ganham produtos livres diferentes)", () => {
    const avail = ["p1", "p2", "b1", "b2", "b3"];
    // O cenário da revisão: o bump era [p1, p2], que foram para os principais; religar dá dois produtos distintos.
    expect(fillBumpLines(["p1", "p2"], ["p1", "p2"], avail)).toEqual(["b1", "b2"]);
    // Linhas válidas ficam; vazias não roubam o produto de uma linha válida mais abaixo.
    expect(fillBumpLines(["p1"], ["", "b1"], avail)).toEqual(["p2", "b1"]);
    expect(fillBumpLines(["p1"], ["b2", "b2", ""], avail)).toEqual(["b2", "p2", "b1"]);
    // Sem produto livre: a linha fica vazia (o salvar pede para escolher).
    expect(fillBumpLines(["p1"], ["p1", ""], ["p1", "p2"])).toEqual(["p2", ""]);
  });

  test("editor: foco depois de mover e remover; anúncios", () => {
    // Subiu para o meio: o foco fica no ↑ do item na posição nova; chegou no topo: vai para o ↓.
    expect(focusAfterMove(2, -1, 4)).toEqual({ index: 1, target: "up" });
    expect(focusAfterMove(1, -1, 4)).toEqual({ index: 0, target: "down" });
    expect(focusAfterMove(1, 1, 4)).toEqual({ index: 2, target: "down" });
    expect(focusAfterMove(2, 1, 4)).toEqual({ index: 3, target: "up" });
    // Remover: o select vizinho (o que ocupou a posição, ou o anterior se era o último).
    expect(focusAfterRemove(1, 3)).toBe(1);
    expect(focusAfterRemove(3, 3)).toBe(2);
    expect(focusAfterRemove(0, 1)).toBe(0);
    expect(moveAnnouncement("Pack de jogos", 1)).toBe("Pack de jogos movido para a posição 1");
    expect(removeAnnouncement("Pack de jogos")).toBe("Pack de jogos removido");
  });

  test("editor: a opção vazia aparece sempre que o valor é vazio (o select mostra exatamente o estado)", () => {
    expect(emptyOptionLabel({ firstMain: true, value: "", hasProducts: false })).toBe("Envie um PDF em Produtos");
    expect(emptyOptionLabel({ firstMain: true, value: "", hasProducts: true })).toBe("Escolha…");
    expect(emptyOptionLabel({ firstMain: true, value: "p1", hasProducts: true })).toBeNull(); // 1 produto, como hoje
    expect(emptyOptionLabel({ firstMain: false, value: "p1", hasProducts: true })).toBe("Escolha…");
    expect(emptyOptionLabel({ firstMain: false, value: "", hasProducts: true })).toBe("Escolha…");
  });
});
