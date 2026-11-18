import { log } from "@/lib/log";
import { runDueJobs, scheduleOnce } from "@/lib/jobs";
import { getHandlers } from "./handlers";

export const WORKER_INTERVAL_MS = 2000;
export const EXPIRE_EVERY_MS = 5 * 60 * 1000;

/** Liga o worker (intervalo de 2 s) e o agendamento de expire_orders (5 min). Devolve a função de parada. */
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
  const schedule = () => scheduleOnce("expire_orders").catch((e: unknown) => log.error("falha ao agendar expire_orders", { error: e }));
  void schedule();
  const a = setInterval(() => void tick(), WORKER_INTERVAL_MS);
  const b = setInterval(() => void schedule(), EXPIRE_EVERY_MS);
  a.unref();
  b.unref();
  return () => {
    clearInterval(a);
    clearInterval(b);
  };
}
