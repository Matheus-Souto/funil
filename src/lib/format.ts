// Formatação na borda (UI). Dinheiro chega em centavos inteiros: nunca passa por ponto flutuante.

/** 990 -> "R$ 9,90"; 128470 -> "R$ 1.284,70". */
export function brl(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Valor único do Pix manual partido em [parte igual ao total, parte que muda], para destacar os centavos que
 * identificam o pedido (ex.: total 990, valor 993 -> ["R$ 9,9", "3"]). Se os reais mudarem, destaca os centavos.
 */
export function splitUniqueAmount(totalCents: number, amountCents: number): [string, string] {
  const a = brl(totalCents);
  const b = brl(amountCents);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const comma = b.indexOf(",");
  if (i <= comma) i = comma + 1;
  return [b.slice(0, i), b.slice(i)];
}

const SP_DATE = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
const SP_DAY_MONTH = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
const SP_TIME = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const SP_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

/** "18/11/2026" (São Paulo). */
export const dateSP = (d: Date): string => SP_DATE.format(d);

/** "18/11/2026 às 14:56" (São Paulo). */
export const dateTimeSP = (d: Date): string => `${SP_DATE.format(d)} às ${SP_TIME.format(d)}`;

/** "hoje, 18/11 às 14:52" / "amanhã, 19/11 às 14:52" / "20/11 às 14:52" (São Paulo). */
export function validUntilSP(d: Date, now: Date = new Date()): string {
  const day = (x: Date) => Date.parse(SP_KEY.format(x));
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const prefix = diff === 0 ? "hoje, " : diff === 1 ? "amanhã, " : "";
  return `${prefix}${SP_DAY_MONTH.format(d)} às ${SP_TIME.format(d)}`;
}

/** Tamanho de arquivo: 2411725 -> "2,3 MB"; 4000 -> "4 KB" (mínimo "1 KB"). */
export const fileSize = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Código curto do pedido mostrado ao vendedor e nos e-mails ("#PED10510"): 8 primeiros caracteres do txid. */
export const orderCode = (publicId: string): string => publicId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);

const SP_DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });
const SP_DAY_MONTH_TIME = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const SP_SHORT_DATE = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit" });

/** "21/11/26 09:08" (São Paulo): data real e hora, nas listas e no histórico do painel. */
export const dateTimeShortSP = (d: Date): string => `${SP_SHORT_DATE.format(d)} ${SP_TIME.format(d)}`;

/** "hoje, 15:12" / "ontem, 22:14" / "16/11, 09:40" (São Paulo). */
export function shortWhenSP(d: Date, now: Date = new Date()): string {
  const day = SP_DAY_KEY.format(d);
  if (day === SP_DAY_KEY.format(now)) return `hoje, ${SP_TIME.format(d)}`;
  if (day === SP_DAY_KEY.format(new Date(now.getTime() - 86_400_000))) return `ontem, ${SP_TIME.format(d)}`;
  return SP_DAY_MONTH_TIME.format(d);
}

/**
 * Texto de preço digitado no painel -> centavos inteiros (sem ponto flutuante). Aceita "9,90", "R$ 1.284,70", "27",
 * "9.90". Devolve null se não for um valor válido.
 */
export function parseBrl(text: string): number | null {
  const t = text.replace(/R\$|\s/g, "");
  if (!/^[\d.,]+$/.test(t)) return null;
  let reais: string;
  let cents = "";
  const comma = t.lastIndexOf(",");
  const dot = t.lastIndexOf(".");
  if (comma >= 0) {
    reais = t.slice(0, comma).replace(/\./g, "");
    cents = t.slice(comma + 1);
  } else if (dot >= 0 && t.length - dot - 1 <= 2 && t.indexOf(".") === dot) {
    reais = t.slice(0, dot);
    cents = t.slice(dot + 1);
  } else {
    reais = t.replace(/\./g, "");
  }
  if (!/^\d*$/.test(reais) || !/^\d{0,2}$/.test(cents) || (reais === "" && cents === "")) return null;
  const value = Number(reais || "0") * 100 + Number(cents.padEnd(2, "0") || "0");
  return Number.isSafeInteger(value) ? value : null;
}

/** 990 -> "9,90" (campo de preço). */
export const centsToInput = (cents: number): string => brl(cents).replace("R$ ", "");
