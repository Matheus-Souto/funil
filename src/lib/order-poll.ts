// Polling do status do pedido na página /o/[publicId] (roda no navegador). Relógio e agenda injetáveis:
// os testes avançam o tempo à mão, sem espera real.

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_MS = 30 * 60 * 1000;

export interface PollOptions {
  /** Status mostrado na tela agora; qualquer status diferente dispara `onChange` uma vez e encerra. */
  initial: string;
  fetchStatus: () => Promise<string | null>;
  onChange: (status: string) => void;
  /** Chamado ao fim dos 30 min sem mudança. */
  onGiveUp?: () => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  intervalMs?: number;
  maxMs?: number;
}

/** Começa a consultar o status a cada `intervalMs`; devolve a função que para. Erros de rede são ignorados. */
export function pollOrderStatus(opts: PollOptions): () => void {
  const schedule = opts.schedule ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));
  const now = opts.now ?? (() => Date.now());
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const max = opts.maxMs ?? POLL_MAX_MS;
  const started = now();
  let stopped = false;
  let handle: unknown;

  const tick = async () => {
    if (stopped) return;
    let status: string | null = null;
    try {
      status = await opts.fetchStatus();
    } catch {
      status = null;
    }
    if (stopped) return;
    if (status !== null && status !== opts.initial) {
      stopped = true;
      opts.onChange(status);
      return;
    }
    if (now() - started >= max) {
      stopped = true;
      opts.onGiveUp?.();
      return;
    }
    handle = schedule(() => void tick(), interval);
  };

  handle = schedule(() => void tick(), interval);
  return () => {
    stopped = true;
    cancel(handle);
  };
}
