import type { ActionResult } from "../../result";

/**
 * Aprovar ou recusar e, se falhar, recarregar a tela: a falha também muda o pedido (outro decidiu, venceu, a execução
 * falhou e virou `failed`). No sucesso o `useActionRunner` já recarrega; o comportamento dele nas outras telas não muda.
 */
export async function decideThenRefresh<T>(run: () => Promise<ActionResult<T>>, refresh: () => void): Promise<ActionResult<T>> {
  const r = await run();
  if (!r.ok) refresh();
  return r;
}
