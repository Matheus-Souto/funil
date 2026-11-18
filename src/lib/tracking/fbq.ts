// Meta Pixel no navegador (só páginas do comprador: /c e /o, e só com Pixel configurado). Mesmo carregador do código
// base do Meta (fila `fbq` + fbevents.js assíncrono), escrito aqui para não depender de HTML inline.
// Sem servidor: pode ser importado por componentes cliente.

type Fbq = ((...args: unknown[]) => void) & { callMethod?: (...a: unknown[]) => void; queue: unknown[]; push: unknown; loaded: boolean; version: string };
declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

export const FBEVENTS_SRC = "https://connect.facebook.net/en_US/fbevents.js";
const PIXEL_ID_RE = /^\d{5,20}$/;
const inited = new Set<string>();
/** Eventos já disparados nesta carga da página (efeitos do React podem rodar duas vezes). */
const fired = new Set<string>();

function install(): Fbq {
  if (window.fbq) return window.fbq;
  const n = function (...args: unknown[]) {
    if (n.callMethod) n.callMethod(...args);
    else n.queue.push(args);
  } as Fbq;
  n.push = n;
  n.loaded = true;
  n.version = "2.0";
  n.queue = [];
  window.fbq = n;
  window._fbq ??= n;
  const s = document.createElement("script");
  s.async = true;
  s.src = FBEVENTS_SRC;
  document.head.appendChild(s);
  return n;
}

/** Carrega o Pixel (uma vez) e dispara o PageView do pixel. Pixel inválido: nada. */
export function initPixel(pixelId: string | null | undefined): boolean {
  if (!pixelId || !PIXEL_ID_RE.test(pixelId) || typeof window === "undefined") return false;
  const fbq = install();
  if (!inited.has(pixelId)) {
    inited.add(pixelId);
    fbq("init", pixelId);
    fbq("track", "PageView");
  }
  return true;
}

/** Evento padrão com `eventID` (o mesmo da API de Conversões, para o Meta deduplicar). Só depois de `initPixel`. */
export function trackPixel(event: string, params: Record<string, unknown>, eventId?: string): void {
  if (inited.size === 0 || !window.fbq) return;
  if (eventId) {
    const key = `${event}:${eventId}`;
    if (fired.has(key)) return;
    fired.add(key);
    window.fbq("track", event, params, { eventID: eventId });
  } else window.fbq("track", event, params);
}
