// Número do cartão: módulo puro, sem imports. Vai no bundle do iframe do cartão e no servidor (payWithCard).

/**
 * Cartão de aprovação do sandbox do Asaas (documentado; não passa no Luhn). O servidor só o aceita com a conexão
 * sandbox: em produção nenhum cartão real falha no Luhn.
 */
export const SANDBOX_TEST_CARD = "4444444444444444";

/** Dígito verificador (Luhn): todo número de cartão real passa. Recebe só dígitos (13 a 19). */
export function luhnValid(number: string): boolean {
  if (!/^\d{13,19}$/.test(number)) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = number.charCodeAt(number.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
