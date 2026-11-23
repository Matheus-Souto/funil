import { describe, expect, test } from "bun:test";
import { MAX_RANGE_DAYS, parseDashboardRange } from "@/app/admin/date-range";

// Período do Dashboard: dias de São Paulo (UTC−3), os dois inclusos. Os instantes abaixo estão em UTC.
const at = (iso: string) => new Date(iso);
/** 12:00 de 22/11/2026 em São Paulo. */
const NOON_22 = at("2026-11-22T15:00:00Z");

describe("parseDashboardRange: fuso e virada de dia", () => {
  test("23:30 em São Paulo ainda é o dia 21 (em UTC já é 22)", () => {
    const now = at("2026-11-22T02:30:00Z");
    const r = parseDashboardRange({ periodo: "hoje" }, now);
    expect(r.de).toBe("2026-11-21");
    expect(r.ate).toBe("2026-11-21");
    expect(r.from.toISOString()).toBe("2026-11-21T03:00:00.000Z");
    expect(r.to).toEqual(now);
    expect(r.endsToday).toBe(true);
    expect(r.compare).toBe("ontem no mesmo horário");
    expect(r.prev.from.toISOString()).toBe("2026-11-20T03:00:00.000Z");
    expect(r.prev.to.toISOString()).toBe("2026-11-21T02:30:00.000Z");
  });

  test("sem parâmetros: o mês atual; 23:59 de 30/11 ainda é novembro", () => {
    const r = parseDashboardRange({}, at("2026-12-01T02:59:00Z"));
    expect([r.de, r.ate, r.days]).toEqual(["2026-11-01", "2026-11-30", 30]);
  });

  test("00:00 de 01/12 em São Paulo já é dezembro, com 1 dia", () => {
    const r = parseDashboardRange({}, at("2026-12-01T03:00:00Z"));
    expect([r.de, r.ate, r.days]).toEqual(["2026-12-01", "2026-12-01", 1]);
    expect(r.from.toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(r.label).toBe("01/12/26");
  });
});

describe("parseDashboardRange: links antigos com ?periodo=", () => {
  test("hoje, 7d e 30d contam o dia de hoje", () => {
    expect(parseDashboardRange({ periodo: "hoje" }, NOON_22)).toMatchObject({ de: "2026-11-22", ate: "2026-11-22", days: 1 });
    expect(parseDashboardRange({ periodo: "7d" }, NOON_22)).toMatchObject({ de: "2026-11-16", ate: "2026-11-22", days: 7, compare: "7 dias anteriores" });
    expect(parseDashboardRange({ periodo: "30d" }, NOON_22)).toMatchObject({ de: "2026-10-24", ate: "2026-11-22", days: 30 });
  });

  test("?periodo= desconhecido cai no mês atual", () => {
    expect(parseDashboardRange({ periodo: "90d" }, NOON_22)).toMatchObject({ de: "2026-11-01", ate: "2026-11-22", days: 22 });
  });

  test("?de=&ate= válidos têm prioridade sobre ?periodo=", () => {
    expect(parseDashboardRange({ de: "2026-11-02", ate: "2026-11-03", periodo: "30d" }, NOON_22)).toMatchObject({ de: "2026-11-02", ate: "2026-11-03", days: 2 });
  });
});

describe("parseDashboardRange: datas escolhidas", () => {
  test("período fechado no passado vai até o fim do último dia", () => {
    const r = parseDashboardRange({ de: "2026-11-01", ate: "2026-11-10" }, NOON_22);
    expect(r.days).toBe(10);
    expect(r.endsToday).toBe(false);
    expect(r.from.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-11T03:00:00.000Z");
    expect(r.prev.from.toISOString()).toBe("2026-10-22T03:00:00.000Z");
    expect(r.prev.to.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(r.compare).toBe("10 dias anteriores");
    expect(r.label).toBe("01/11/26 – 10/11/26");
  });

  test("um dia só no passado compara com o dia anterior", () => {
    expect(parseDashboardRange({ de: "2026-11-21", ate: "2026-11-21" }, NOON_22)).toMatchObject({ days: 1, endsToday: false, compare: "dia anterior" });
  });

  test("data futura é cortada em hoje", () => {
    const r = parseDashboardRange({ de: "2026-11-01", ate: "2026-11-30" }, NOON_22);
    expect([r.de, r.ate, r.days, r.endsToday]).toEqual(["2026-11-01", "2026-11-22", 22, true]);
    expect(r.to).toEqual(NOON_22);
  });

  test("período todo no futuro vira só hoje", () => {
    expect(parseDashboardRange({ de: "2026-11-23", ate: "2026-11-25" }, NOON_22)).toMatchObject({ de: "2026-11-22", ate: "2026-11-22", days: 1 });
  });

  test("datas invertidas são trocadas", () => {
    expect(parseDashboardRange({ de: "2026-11-10", ate: "2026-11-01" }, NOON_22)).toMatchObject({ de: "2026-11-01", ate: "2026-11-10", days: 10 });
  });

  test("30/02 não existe: cai no mês atual", () => {
    expect(parseDashboardRange({ de: "2026-02-30", ate: "2026-03-01" }, NOON_22)).toMatchObject({ de: "2026-11-01", ate: "2026-11-22" });
  });

  test("formato errado ou só uma das datas: cai no mês atual", () => {
    for (const sp of [{ de: "2026-11-10" }, { de: "10/11/2026", ate: "2026-11-12" }, { de: "2026-11-1", ate: "2026-11-12" }]) {
      expect(parseDashboardRange(sp, NOON_22)).toMatchObject({ de: "2026-11-01", ate: "2026-11-22" });
    }
  });

  test(`mais de ${MAX_RANGE_DAYS} dias: mantém o fim e corta o começo`, () => {
    const r = parseDashboardRange({ de: "2020-01-01", ate: "2026-11-10" }, NOON_22);
    expect(r.days).toBe(MAX_RANGE_DAYS);
    expect(r.ate).toBe("2026-11-10");
    expect(r.de).toBe("2025-11-10");
    expect(r.to.getTime() - r.from.getTime()).toBe(MAX_RANGE_DAYS * 86_400_000);
    expect(r.capped).toBe(true);
  });

  test(`exatamente ${MAX_RANGE_DAYS} dias passa inteiro`, () => {
    expect(parseDashboardRange({ de: "2025-11-11", ate: "2026-11-11" }, NOON_22)).toMatchObject({ de: "2025-11-11", ate: "2026-11-11", days: MAX_RANGE_DAYS, capped: false });
  });
});
