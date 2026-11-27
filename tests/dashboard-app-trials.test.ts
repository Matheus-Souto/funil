// Bloco "Testes do app" do Dashboard: quando mostrar o painel em vez dos primeiros passos e o que cada número compara.
import { describe, expect, test } from "bun:test";
import { appTrialsKpis, overviewIsEmpty, TRIALS_RETENTION_NOTE } from "@/app/admin/(panel)/app-trials";
import type { TrialsSummary } from "@/lib/metrics";

const summary = (o: Partial<TrialsSummary> = {}): TrialsSummary => ({ trials: 4, paying: 1, conversionBp: 2500, byCampaign: [], retentionCovered: true, ...o });

describe("overviewIsEmpty (primeiros passos)", () => {
  test("decide por dado sem período: loja de app nunca cai nos primeiros passos, mesmo sem teste no período", () => {
    expect(overviewIsEmpty({ orders: 0, views: 0 }, false)).toBe(true);
    expect(overviewIsEmpty({ orders: 0, views: 0 }, true)).toBe(false);
    expect(overviewIsEmpty({ orders: 1, views: 0 }, false)).toBe(false);
    expect(overviewIsEmpty({ orders: 0, views: 3 }, false)).toBe(false);
  });
});

describe("appTrialsKpis", () => {
  test("só os testes iniciados comparam com o período anterior; pagantes e conversão não (coortes de maturidade diferente)", () => {
    const [trials, paying, conv] = appTrialsKpis(summary(), summary({ trials: 2, paying: 2, conversionBp: 10_000 }));
    expect(trials).toEqual({ label: "Testes iniciados", value: "4", delta: { cur: 4, prev: 2 } });
    expect(paying!.label).toBe("Pagantes");
    expect(paying!.value).toBe("1");
    expect(paying!.delta).toBeUndefined();
    expect(paying!.note).toBe("Contas dos testes do período que já pagaram, em qualquer data.");
    expect(conv).toEqual({ label: "Conversão teste → pagante", value: "25%" });
  });

  test("período além da retenção dos testes: nota nos testes e na conversão; sem comparação quando a janela anterior também passa", () => {
    const old = summary({ retentionCovered: false });
    const [trials, , conv] = appTrialsKpis(old, summary({ retentionCovered: false }));
    expect(trials).toEqual({ label: "Testes iniciados", value: "4", note: TRIALS_RETENTION_NOTE });
    expect(conv!.note).toBe(TRIALS_RETENTION_NOTE);
    // Período atual coberto e anterior não: o anterior conta menos testes do que houve; sem comparação.
    const [t2] = appTrialsKpis(summary(), summary({ retentionCovered: false }));
    expect(t2!.delta).toBeUndefined();
    expect(TRIALS_RETENTION_NOTE).toContain("179 dias");
  });

  test("sem testes: conversão aparece como —", () => {
    const [, , conv] = appTrialsKpis(summary({ trials: 0, paying: 0, conversionBp: null }), summary());
    expect(conv!.value).toBe("—");
  });
});
