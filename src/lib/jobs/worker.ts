import { log } from "@/lib/log";
import { runDueJobs, scheduleOnce } from "@/lib/jobs";
import { PCI_MONITOR_EVERY_MS } from "@/lib/security/page-monitor";
import { getHandlers } from "./handlers";

export const WORKER_INTERVAL_MS = 2000;
export const EXPIRE_EVERY_MS = 5 * 60 * 1000;
/** Varredura das cópias carimbadas: uma por dia (agendada para daqui a 24 h sempre que não houver outra na fila). */
export const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
/** Retenção dos contatos de checkout abandonado (30 dias): uma varredura por dia. */
export const SWEEP_LEADS_EVERY_MS = 24 * 60 * 60 * 1000;
/** Varredura da fila de aprovação e dos links de upload do MCP: uma por hora. */
export const SWEEP_MCP_EVERY_MS = 60 * 60 * 1000;

/**
 * Liga o worker (intervalo de 2 s) e os agendamentos (expire_orders a cada 5 min, sweep_watermarks e sweep_leads diários, sweep_mcp
 * de hora em hora, pci_page_monitor semanal). Devolve a função de parada.
 */
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
    void scheduleOnce("sweep_mcp", new Date(Date.now() + SWEEP_MCP_EVERY_MS)).catch((e: unknown) =>
      log.error("falha ao agendar sweep_mcp", { error: e }),
    );
    void scheduleOnce("sweep_leads", new Date(Date.now() + SWEEP_LEADS_EVERY_MS)).catch((e: unknown) =>
      log.error("falha ao agendar sweep_leads", { error: e }),
    );
    // PCI DSS 11.6.1: cabeçalhos e scripts das páginas de pagamento conferidos em produção, toda semana.
    void scheduleOnce("pci_page_monitor", new Date(Date.now() + PCI_MONITOR_EVERY_MS)).catch((e: unknown) =>
      log.error("falha ao agendar pci_page_monitor", { error: e }),
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
