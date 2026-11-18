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

/** "18/11/2026 às 14:56" (São Paulo). */
export const dateTimeSP = (d: Date): string => `${SP_DATE.format(d)} às ${SP_TIME.format(d)}`;

/** "hoje, 18/11 às 14:52" / "amanhã, 19/11 às 14:52" / "20/11 às 14:52" (São Paulo). */
export function validUntilSP(d: Date, now: Date = new Date()): string {
  const day = (x: Date) => Date.parse(SP_KEY.format(x));
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const prefix = diff === 0 ? "hoje, " : diff === 1 ? "amanhã, " : "";
  return `${prefix}${SP_DAY_MONTH.format(d)} às ${SP_TIME.format(d)}`;
}
