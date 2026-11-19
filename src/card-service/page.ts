// Página do iframe do cartão: HTML mínimo (o formulário é montado por /form.js) e a CSP dela.
// Nenhum script inline executável: a configuração vai num <script type="application/json">, que o navegador não
// executa, e o JSON é escapado para nunca fechar a tag. Módulo puro: o monitor PCI compara contra `cardFormCsp`.

const TURNSTILE = "https://challenges.cloudflare.com";

/** CSP exata da página do formulário. `origins` = origens do checkout da loja (as únicas que podem embutir o iframe). */
export function cardFormCsp(origins: string[], opts: { turnstile: boolean }): string {
  return [
    "default-src 'none'",
    opts.turnstile ? `script-src 'self' ${TURNSTILE}` : "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    ...(opts.turnstile ? [`frame-src ${TURNSTILE}`] : []),
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${origins.length > 0 ? origins.join(" ") : "'none'"}`,
  ].join("; ");
}

export interface CardFormConfig {
  allowedOrigins: string[];
  turnstileSiteKey?: string;
}

/** JSON seguro dentro de <script>: `<`, `>`, `&` e os separadores de linha U+2028/U+2029 viram escapes \uXXXX. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function cardFormHtml(cfg: CardFormConfig): string {
  const json = scriptJson({ allowedOrigins: cfg.allowedOrigins, turnstileSiteKey: cfg.turnstileSiteKey ?? null });
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pagamento com cartão</title>
<link rel="stylesheet" href="/form.css">
<script type="application/json" id="cfg">${json}</script>
<script src="/form.js" defer></script>
</head>
<body>
<main id="card-form"></main>
</body>
</html>
`;
}
