// Meta Pixel no navegador (só páginas do comprador: /c e /o, e só com Pixel configurado). Mesmo carregador do código
// base do Meta (fila `fbq` + fbevents.js assíncrono), escrito aqui para não depender de HTML inline (CSP com nonce).
// O checkout tem campos de cartão/CPF: `autoConfig` desligado ANTES do `init` (sem coleta automática de cliques,
// campos ou metadados da página) e os eventos só levam os parâmetros que o app passa (moeda, valor, método).
// Sem servidor: pode ser importado por componentes cliente. `win` existe para os testes (happy-dom).

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

function install(win: Window): Fbq {
  if (win.fbq) return win.fbq;
  const n = function (...args: unknown[]) {
    if (n.callMethod) n.callMethod(...args);
    else n.queue.push(args);
  } as Fbq;
  n.push = n;
  n.loaded = true;
  n.version = "2.0";
  n.queue = [];
  win.fbq = n;
  win._fbq ??= n;
  const s = win.document.createElement("script");
  s.async = true;
  s.src = FBEVENTS_SRC;
  win.document.head.appendChild(s);
  return n;
}

/** Carrega o Pixel (uma vez) e dispara o PageView do pixel. Pixel inválido: nada. */
export function initPixel(pixelId: string | null | undefined, win: Window | undefined = globalThis.window): boolean {
  if (!pixelId || !PIXEL_ID_RE.test(pixelId) || !win) return false;
  const fbq = install(win);
  if (!inited.has(pixelId)) {
    inited.add(pixelId);
    fbq("set", "autoConfig", false, pixelId);
    fbq("init", pixelId);
    fbq("track", "PageView");
  }
  return true;
}

/** Evento padrão com `eventID` (o mesmo da API de Conversões, para o Meta deduplicar). Só depois de `initPixel`. */
export function trackPixel(
  event: string,
  params: Record<string, string | number>,
  eventId?: string,
  win: Window | undefined = globalThis.window,
): void {
  if (inited.size === 0 || !win?.fbq) return;
  if (eventId) {
    const key = `${event}:${eventId}`;
    if (fired.has(key)) return;
    fired.add(key);
    win.fbq("track", event, params, { eventID: eventId });
  } else win.fbq("track", event, params);
}

/** Testes: esquece pixels iniciados e eventos disparados. */
export function resetPixelForTests(): void {
  inited.clear();
  fired.clear();
}
