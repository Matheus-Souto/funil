/**
 * Divide `totalCents` em `n` partes inteiras e iguais; a sobra da divisão inteira (no máximo n - 1 centavos) fica toda no
 * primeiro item, de modo que a soma é sempre `totalCents`. (1000 em 3 dá 334, 333, 333.) Lança erro se `n < 1` ou `n` não for inteiro, ou se `totalCents` não for inteiro >= 0.
 */
export function splitCents(totalCents: number, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new Error("splitCents: n deve ser um inteiro >= 1");
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error("splitCents: totalCents deve ser um inteiro >= 0");
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rest : base));
}
