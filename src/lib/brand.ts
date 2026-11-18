// Cor da loja no checkout (T01 do design): a loja escolhe uma cor e o sistema deriva as variáveis `--color-brand*`
// com contraste AA garantido. Calculado no servidor e aplicado como estilo inline no contêiner da página.
//   --color-brand         a cor escolhida
//   --color-on-brand      texto sobre a marca: branco, tinta ou preto, o primeiro com contraste ≥ 4,5:1
//   --color-brand-hover   a cor com luminosidade (HSL) 8 pontos menor
//   --color-brand-soft    12% da cor sobre branco (fundo de seleção)
//   --color-brand-strong  a cor escurecida até 4,5:1 sobre branco (texto, ícones e bordas de seleção)

export type BrandVars = {
  "--color-brand": string;
  "--color-brand-hover": string;
  "--color-brand-soft": string;
  "--color-on-brand": string;
  "--color-brand-strong": string;
};

/** Padrão da plataforma (tokens `--color-primary*`). */
export const DEFAULT_BRAND: BrandVars = {
  "--color-brand": "#0B6E4F",
  "--color-brand-hover": "#085A40",
  "--color-brand-soft": "#E3F1EA",
  "--color-on-brand": "#FFFFFF",
  "--color-brand-strong": "#0B6E4F",
};

const WHITE = "#FFFFFF";
const INK = "#15201B";
const BLACK = "#000000";
const AA = 4.5;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Razão de contraste WCAG entre duas cores #RRGGBB. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a)!);
  const lb = luminance(parseHex(b)!);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const ss = s / 100;
  const ll = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = ss * Math.min(ll, 1 - ll);
  const f = (n: number) => ll - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Variáveis da marca para a cor `hex` (#RRGGBB); `null` ou inválida -> padrão da plataforma. */
export function brandVars(hex: string | null | undefined): BrandVars {
  const rgb = hex ? parseHex(hex) : null;
  if (!rgb) return DEFAULT_BRAND;
  const brand = toHex(rgb);
  const [h, s, l] = toHsl(rgb);
  const onBrand = [WHITE, INK, BLACK].find((c) => contrastRatio(c, brand) >= AA) ?? BLACK;
  let strong = brand;
  for (let ll = l; contrastRatio(strong, WHITE) < AA && ll > 0; ) {
    ll = Math.max(0, ll - 1);
    strong = toHex(fromHsl(h, s, ll));
  }
  return {
    "--color-brand": brand,
    "--color-brand-hover": toHex(fromHsl(h, s, Math.max(0, l - 8))),
    "--color-brand-soft": toHex(rgb.map((v) => 255 + (v - 255) * 0.12) as Rgb),
    "--color-on-brand": onBrand,
    "--color-brand-strong": strong,
  };
}
