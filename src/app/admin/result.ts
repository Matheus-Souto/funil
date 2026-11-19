// Resultado das server actions do painel (o navegador mostra `error` numa região aria-live).
export type ActionResult<T> = { ok: true; data: T; message?: string } | { ok: false; error: string; code: string };
