// Validações brasileiras compartilhadas entre o formulário do checkout (navegador) e os esquemas do servidor.
// Sem imports do servidor: este arquivo vai para o bundle do cliente.

export const onlyDigits = (s: string): string => s.replace(/\D/g, "");

/** CPF com dígitos verificadores corretos (11 dígitos, não todos iguais). Recebe só dígitos. */
export function validCpf(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(d[n])) return false;
  }
  return true;
}

/** CNPJ com dígitos verificadores corretos (14 dígitos, não todos iguais). Recebe só dígitos. */
export function validCnpj(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  for (const n of [12, 13]) {
    const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * w[i]!;
    const r = sum % 11;
    if ((r < 2 ? 0 : 11 - r) !== Number(d[n])) return false;
  }
  return true;
}

/** Documento do comprador: CPF sempre; CNPJ só na loja que aceita (`store.accept_cnpj`). Recebe só dígitos. */
export function validTaxId(d: string, acceptCnpj: boolean): boolean {
  return validCpf(d) || (acceptCnpj && validCnpj(d));
}

/** Máscara do documento enquanto digita: CPF até 11 dígitos; com CNPJ aceito, passa a CNPJ do 12º dígito em diante. */
export function maskTaxId(v: string, acceptCnpj: boolean): string {
  const d = onlyDigits(v).slice(0, acceptCnpj ? 14 : 11);
  if (d.length <= 11) {
    return d.replace(/^(\d{3})(\d)/, "$1.$2").replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
  }
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})$/, (_, a, b, c, e, f) => `${a}.${b}.${c}/${e}${f ? `-${f}` : ""}`);
}

/** DDDs válidos no Brasil (Anatel). */
const DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92,
  93, 94, 95, 96, 97, 98, 99,
]);

/**
 * Celular brasileiro: DDD válido + 9 + 8 dígitos, aceitando máscara e o prefixo 55. Devolve os 11 dígitos ou `null`.
 * Recusa números com todos os dígitos do assinante iguais (ex.: 11 99999-9999, que o Asaas recusa).
 */
export function normalizeBrMobile(raw: string): string | null {
  let d = onlyDigits(raw);
  if (d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if (!/^\d{11}$/.test(d)) return null;
  if (!DDD.has(Number(d.slice(0, 2)))) return null;
  if (d[2] !== "9") return null;
  if (/^(\d)\1{8}$/.test(d.slice(2)) || /^(\d)\1{7}$/.test(d.slice(3))) return null;
  return d;
}

/** Parte local sem espaço nem `@`; domínio no formato de nome de host (rótulos de até 63, TLD de 2 a 24 letras). */
const EMAIL_LOCAL = /^[^\s@]+$/;
const EMAIL_DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
export function validEmail(s: string): boolean {
  const t = s.trim();
  const at = t.lastIndexOf("@");
  return s.length <= 254 && at > 0 && EMAIL_LOCAL.test(t.slice(0, at)) && EMAIL_DOMAIN.test(t.slice(at + 1));
}

const SP_MONTH = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" });

/** Ano e mês atuais no calendário de America/Sao_Paulo. */
export function saoPauloYearMonth(now: Date): { year: number; month: number } {
  const [y, m] = SP_MONTH.format(now).split("-").map(Number) as [number, number];
  return { year: y, month: m };
}

/**
 * Validade do cartão (mês 1–12, ano com 2 ou 4 dígitos) não anterior ao mês atual em São Paulo
 * e no máximo 20 anos à frente. O cartão vale até o fim do mês impresso.
 */
export function cardExpiryValid(month: string | number, year: string | number, now: Date = new Date()): boolean {
  const m = Number(month);
  const ys = String(year).trim();
  if (!Number.isInteger(m) || m < 1 || m > 12 || !/^(\d{2}|\d{4})$/.test(ys)) return false;
  const y = ys.length === 2 ? 2000 + Number(ys) : Number(ys);
  const cur = saoPauloYearMonth(now);
  if (y < cur.year || (y === cur.year && m < cur.month)) return false;
  return y <= cur.year + 20;
}
