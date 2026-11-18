import { log } from "@/lib/log";
import { runDueJobs, scheduleOnce } from "@/lib/jobs";
import { getHandlers } from "./handlers";

export const WORKER_INTERVAL_MS = 2000;
export const EXPIRE_EVERY_MS = 5 * 60 * 1000;
/** Varredura das cópias carimbadas: uma por dia (agendada para daqui a 24 h sempre que não houver outra na fila). */
export const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/** Liga o worker (intervalo de 2 s) e os agendamentos (expire_orders a cada 5 min, sweep_watermarks diário). Devolve a função de parada. */
export function startWorker(): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runDueJobs(getHandlers());
    } catch (e) {
      log.error("worker de jobs falhou", { error: e });
    } finally {
      busy = false;
    }
  };
  const schedule = () => {
    void scheduleOnce("expire_orders").catch((e: unknown) => log.error("falha ao agendar expire_orders", { error: e }));
    void scheduleOnce("sweep_watermarks", new Date(Date.now() + SWEEP_EVERY_MS)).catch((e: unknown) =>
      log.error("falha ao agendar sweep_watermarks", { error: e }),
    );
  };
  schedule();
  const a = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  const b = setInterval(() => void schedule(), EXPIRE_EVERY_MS);
  a.unref();
  b.unref();
  return () => {
    clearInterval(a);
    clearInterval(b);
  };
}
