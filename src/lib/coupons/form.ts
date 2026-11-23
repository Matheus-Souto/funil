// Conversões do formulário de cupons (puras, sem banco e sem relógio; usadas pelo painel no navegador). Só inteiros:
// o percentual digitado vira pontos-base (1000 = 10%) e o valor em reais vira centavos por leitura do texto, nunca
// por multiplicação em ponto flutuante.
import { brl, parseBrl } from "@/lib/format";

export type Parsed = { ok: true; value: number } | { ok: false; error: string };

const PERCENT_RE = /^(\d{1,3})(?:[.,](\d+))?$/;

/** "10" -> 1000; "12,5" -> 1250. Até 2 casas decimais e de 0,01% a 90%. */
export function percentToBp(text: string): Parsed {
  const m = PERCENT_RE.exec(text.replace(/%|\s/g, ""));
  if (!m) return { ok: false, error: "Informe o percentual, por exemplo 10 ou 12,5." };
  const frac = m[2] ?? "";
  if (frac.length > 2) return { ok: false, error: "Use no máximo 2 casas decimais." };
  const bp = Number(m[1]) * 100 + Number(frac.padEnd(2, "0") || "0");
  if (bp < 1 || bp > 9000) return { ok: false, error: "O percentual vai de 0,01% a 90%." };
  return { ok: true, value: bp };
}

/** 1000 -> "10"; 1250 -> "12,5"; 725 -> "7,25". */
export function percentToInput(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole},${frac}`;
}

/** "9,90" -> 990 (maior que zero). */
export function amountToCents(text: string): Parsed {
  const cents = parseBrl(text);
  if (cents === null || cents <= 0) return { ok: false, error: "Informe um valor em reais maior que zero, por exemplo 5,00." };
  return { ok: true, value: cents };
}

/** 990 -> "9,90". */
export const centsToAmountInput = (cents: number): string => brl(cents).replace("R$ ", "");

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SP_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

/** "2026-12-01" -> o início desse dia em São Paulo (Brasil sem horário de verão: -03:00). */
export function startOfDateInput(day: string): Date {
  if (!DAY.test(day)) throw new RangeError("data inválida");
  return new Date(`${day}T00:00:00-03:00`);
}

/** "2026-12-31" -> o último segundo desse dia em São Paulo (o cupom vale durante o dia inteiro). */
export function endOfDateInput(day: string): Date {
  if (!DAY.test(day)) throw new RangeError("data inválida");
  return new Date(`${day}T23:59:59-03:00`);
}

/** Instante -> "AAAA-MM-DD" do dia em São Paulo (campo de data); vazio sem data. */
export const dateInputOf = (d: Date | null): string => (d ? SP_KEY.format(d) : "");

export type CouponStatus = "active" | "inactive" | "scheduled" | "expired" | "archived";

/** Situação do cupom no painel: arquivado, desligado, ainda não começou, vencido ou valendo. */
export function couponStatus(c: { active: boolean; archivedAt: Date | null; startsAt: Date | null; endsAt: Date | null }, now: Date): CouponStatus {
  if (c.archivedAt) return "archived";
  if (!c.active) return "inactive";
  if (c.startsAt && c.startsAt.getTime() > now.getTime()) return "scheduled";
  if (c.endsAt && c.endsAt.getTime() <= now.getTime()) return "expired";
  return "active";
}
