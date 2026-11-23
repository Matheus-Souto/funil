// Toque (origem da visita) que chega ao checkout: UTMs, fbclid, código de indicação e cookies do Meta.
// A página de vendas externa roda public/t.js, que guarda primeiro e último toque no navegador e acrescenta aos links
// do checkout `utm_*`, `fbclid`, `ref` e `ft` (primeiro toque em base64url JSON). Aqui só se lê a URL e os cookies.
// Sem dependências de servidor: usado pela página do checkout e pelos testes.
import { z } from "zod";

/** Parâmetros do toque (último toque = os desta URL). `ref` vai à parte (coluna `orders.ref`). `cupom`: código do `?cupom=` (não é dado pessoal). */
export const TOUCH_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "cupom"] as const;
/** Chaves aceitas no primeiro toque vindo do t.js (`ft`): as do toque mais `ref`. */
const FIRST_TOUCH_KEYS: readonly string[] = [...TOUCH_KEYS, "ref"];
export const TOUCH_VALUE_MAX = 500;
export const REF_MAX = 100;
/** `ft` maior que isto (decodificado) é ignorado. */
export const FIRST_TOUCH_MAX_BYTES = 1024;

export type TouchRecord = Record<string, string>;
export type Touch = { first: TouchRecord | null; last: TouchRecord | null };
export type ParsedTouch = Touch & { ref?: string; fbc?: string; fbp?: string };

/** Registro de toque aceito do navegador (limites de tamanho; quem grava é `touchSchema` em checkout.ts). */
export const touchRecordSchema = z
  .record(z.string().max(40), z.string().max(TOUCH_VALUE_MAX))
  .refine((r) => Object.keys(r).length <= 20, "Toque com campos demais");

/**
 * Id do evento do Meta gerado no navegador (InitiateCheckout): UUID ou 16 a 64 caracteres url-safe.
 * (O UUID com hífens já cabe na segunda forma.)
 */
export const META_EVENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const clean = (v: string | null | undefined, max: number): string | undefined => {
  const s = v?.trim();
  return s ? s.slice(0, max) : undefined;
};

/** `_fbc` derivado do clique quando o cookie não existe: `fb.1.<ms>.<fbclid>` (formato do Pixel). */
export function fbcFromFbclid(fbclid: string | undefined, nowMs: number = Date.now()): string | undefined {
  const id = clean(fbclid, 400);
  return id ? `fb.1.${nowMs}.${id}` : undefined;
}

function decodeFirstTouch(ft: string | undefined): TouchRecord | null {
  if (!ft || ft.length > Math.ceil((FIRST_TOUCH_MAX_BYTES * 4) / 3) + 4) return null;
  try {
    const text = Buffer.from(ft, "base64url").toString("utf8");
    if (Buffer.byteLength(text) > FIRST_TOUCH_MAX_BYTES) return null;
    const raw = JSON.parse(text) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out: TouchRecord = {};
    for (const k of FIRST_TOUCH_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      const s = typeof v === "string" ? clean(v, TOUCH_VALUE_MAX) : undefined;
      if (s) out[k] = s;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Toque na entrada do checkout. `last` = parâmetros desta URL; `first` = `ft` do t.js; `ref` = indicação;
 * `fbc`/`fbp` dos cookies do Pixel (`_fbc`, `_fbp`), com `fbc` derivado do `fbclid` quando o cookie não existe.
 */
export function parseTouch(url: URL, cookies: { _fbc?: string; _fbp?: string }, nowMs: number = Date.now()): ParsedTouch {
  const q = url.searchParams;
  const last: TouchRecord = {};
  for (const k of TOUCH_KEYS) {
    const v = clean(q.get(k), TOUCH_VALUE_MAX);
    if (v) last[k] = v;
  }
  const out: ParsedTouch = { first: decodeFirstTouch(q.get("ft") ?? undefined), last: Object.keys(last).length > 0 ? last : null };
  const ref = clean(q.get("ref"), REF_MAX);
  if (ref) out.ref = ref;
  const fbc = clean(cookies._fbc, 500) ?? fbcFromFbclid(last.fbclid, nowMs);
  if (fbc) out.fbc = fbc;
  const fbp = clean(cookies._fbp, 500);
  if (fbp) out.fbp = fbp;
  return out;
}

/** Trecho para colar na página de vendas (o painel mostra; Task 14). `checkoutBaseUrl` = origem pública do checkout. */
export function trackingSnippet(checkoutBaseUrl: string): string {
  const u = new URL(checkoutBaseUrl);
  return `<script src="${u.origin}/t.js" data-checkout="${u.host}" defer></script>`;
}
