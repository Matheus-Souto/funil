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
    expect(DEFAULT_BRAND["--color-brand"]).toBe("#9BE86A");
    // o padrão é exatamente o que brandVars calcula para a cor da plataforma (contraste AA garantido)
    expect(brandVars("#9BE86A")).toEqual(DEFAULT_BRAND);
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

  /**
   * Todo par texto/fundo que buyer.module.css monta com as variáveis da marca (texto ≥ 4,5:1):
   *  1. on-brand sobre brand: botão primário, ícone do e-mail no obrigado, check do bump marcado, "PDF" da capa
   *  2. on-brand sobre brand-hover: botão primário em hover, ponta escura do gradiente da capa
   *  3. brand-strong sobre surface (branco): nome da loja no cabeçalho, ícones de passos e de informação
   *  4. brand-strong sobre brand-soft: ícone da opção de método selecionada, número dos passos, centavos destacados
   *  5. text sobre brand-soft: título da opção selecionada, bump marcado, valor único, cartão "Enviamos o acesso"
   *  6. text-muted sobre brand-soft: legenda da opção selecionada, texto do bump marcado e do cartão de acesso
   */
  const pairs = (v: ReturnType<typeof brandVars>): [string, string, string][] => [
    ["on-brand/brand", v["--color-on-brand"], v["--color-brand"]],
    ["on-brand/brand-hover", v["--color-on-brand"], v["--color-brand-hover"]],
    ["brand-strong/surface", v["--color-brand-strong"], WHITE],
    ["brand-strong/brand-soft", v["--color-brand-strong"], v["--color-brand-soft"]],
    ["text/brand-soft", INK, v["--color-brand-soft"]],
    ["text-muted/brand-soft", "#56615B", v["--color-brand-soft"]],
  ];

  test("padrão da plataforma passa em todos os pares", () => {
    for (const [name, fg, bg] of pairs(DEFAULT_BRAND)) expect([name, contrastRatio(fg, bg) >= 4.5]).toEqual([name, true]);
  });

  test("propriedade: para qualquer cor, todos os pares texto/fundo passam de 4,5:1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const hex = `#${n.toString(16).padStart(6, "0")}`;
        const v = brandVars(hex);
        for (const [name, fg, bg] of pairs(v)) expect([hex, name, contrastRatio(fg, bg) >= 4.5]).toEqual([hex, name, true]);
        for (const k of Object.keys(v)) expect(v[k as keyof typeof v]).toMatch(/^#[0-9A-F]{6}$/);
      }),
      { numRuns: 2000 },
    );
  });

  test("hover se afasta da cor no sentido do texto (mais escuro com texto branco, mais claro com texto escuro)", () => {
    const dark = brandVars("#2D55C8");
    expect(contrastRatio(dark["--color-brand-hover"], WHITE)).toBeGreaterThan(contrastRatio(dark["--color-brand"], WHITE));
    const light = brandVars("#F5C518");
    expect(light["--color-brand-hover"]).not.toBe(light["--color-brand"]);
    expect(contrastRatio(INK, light["--color-brand-hover"])).toBeGreaterThanOrEqual(4.5);
  });
});
