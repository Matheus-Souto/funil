// Resultado das server actions do painel (o navegador mostra `error` numa região aria-live).
// `field`: caminho do campo recusado (ex.: "recovery.on"), quando a ação aponta um; a tela usa para levar até ele.
export type ActionResult<T> = { ok: true; data: T; message?: string } | { ok: false; error: string; code: string; field?: string };
