import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DEFAULT_BRAND, brandVars, contrastRatio } from "@/lib/brand";

const WHITE = "#FFFFFF";
const INK = "#15201B";

describe("cor da loja no checkout (contraste AA garantido)", () => {
  test("sem cor ou cor inválida: padrão da plataforma", () => {
    expect(brandVars(null)).toEqual(DEFAULT_BRAND);
    expect(brandVars("verde")).toEqual(DEFAULT_BRAND);
    expect(brandVars("#12345")).toEqual(DEFAULT_BRAND);
    expect(DEFAULT_BRAND["--color-brand"]).toBe("#0B6E4F");
  });

  test("azul da Maná Kids: texto branco, strong igual à própria cor", () => {
    const v = brandVars("#2d55c8");
    expect(v["--color-brand"]).toBe("#2D55C8");
    expect(v["--color-on-brand"]).toBe(WHITE);
    expect(v["--color-brand-strong"]).toBe("#2D55C8");
  });

  test("amarelo claro: texto tinta e strong escurecido até 4,5:1 sobre branco", () => {
    const v = brandVars("#F5C518");
    expect(v["--color-on-brand"]).toBe(INK);
    expect(contrastRatio(v["--color-brand-strong"], WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  test("propriedade: para qualquer cor, texto sobre a marca e strong sobre branco passam de 4,5:1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const hex = `#${n.toString(16).padStart(6, "0")}`;
        const v = brandVars(hex);
        expect(contrastRatio(v["--color-on-brand"], v["--color-brand"])).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(v["--color-brand-strong"], WHITE)).toBeGreaterThanOrEqual(4.5);
        for (const k of Object.keys(v)) expect(v[k as keyof typeof v]).toMatch(/^#[0-9A-F]{6}$/);
      }),
    );
  });
});
