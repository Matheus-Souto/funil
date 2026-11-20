import fc from "fast-check";
import { splitCents } from "@/lib/money";

test("exemplos do plano", () => {
  expect(splitCents(2700, 6)).toEqual([450, 450, 450, 450, 450, 450]);
  expect(splitCents(1710, 5)).toEqual([342, 342, 342, 342, 342]);
  expect(splitCents(1000, 3)).toEqual([334, 333, 333]);
  expect(splitCents(1001, 3)).toEqual([335, 333, 333]);
  expect(splitCents(0, 4)).toEqual([0, 0, 0, 0]);
  expect(splitCents(5, 1)).toEqual([5]);
});

test("propriedade: soma igual ao total, inteiros >= 0, sobra (<= n - 1) só no primeiro", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 20 }), (total, n) => {
      const parts = splitCents(total, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      expect(new Set(parts.slice(1)).size).toBeLessThanOrEqual(1);
      expect(parts[0]! - Math.min(...parts)).toBeLessThanOrEqual(n - 1);
      expect(parts[0]!).toBeGreaterThanOrEqual(Math.max(...parts));
    }),
  );
});

test("entradas inválidas lançam erro", () => {
  expect(() => splitCents(100, 0)).toThrow();
  expect(() => splitCents(100, -1)).toThrow();
  expect(() => splitCents(100, 1.5)).toThrow();
  expect(() => splitCents(-1, 2)).toThrow();
  expect(() => splitCents(10.5, 2)).toThrow();
  expect(() => splitCents(Number.NaN, 2)).toThrow();
});
