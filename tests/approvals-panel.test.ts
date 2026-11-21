// Painel de aprovações (F5 da revisão final): aprovar ou recusar que falha também recarrega a lista, porque o pedido
// mudou (outro decidiu, venceu, a execução falhou). O sucesso já recarrega pelo `useActionRunner`.
import { describe, expect, test } from "bun:test";
import { decideThenRefresh } from "@/app/admin/(panel)/aprovacoes/decision";

describe("decideThenRefresh", () => {
  test("erro ao decidir → recarrega a tela; sucesso → não recarrega de novo (o runner já recarregou)", async () => {
    let refreshes = 0;
    const refresh = () => void refreshes++;
    const failed = await decideThenRefresh(async () => ({ ok: false as const, error: "Solicitação já decidida ou cancelada", code: "conflict" }), refresh);
    expect(failed).toEqual({ ok: false, error: "Solicitação já decidida ou cancelada", code: "conflict" });
    expect(refreshes).toBe(1);
    const ok = await decideThenRefresh(async () => ({ ok: true as const, data: { status: "rejected" } }), refresh);
    expect(ok).toEqual({ ok: true, data: { status: "rejected" } });
    expect(refreshes).toBe(1);
  });
});
