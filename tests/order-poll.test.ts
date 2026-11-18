import { describe, expect, test } from "bun:test";
import { POLL_INTERVAL_MS, POLL_MAX_MS, pollOrderStatus } from "@/lib/order-poll";

/** Relógio e agenda manuais: nada espera de verdade. */
function fakeClock() {
  let t = 0;
  let queue: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      const id = ++seq;
      queue.push({ at: t + ms, fn, id });
      return id;
    },
    cancel: (id: unknown) => {
      queue = queue.filter((q) => q.id !== id);
    },
    pending: () => queue.length,
    /** Avança até o próximo agendamento e o executa. */
    async step() {
      queue.sort((a, b) => a.at - b.at);
      const next = queue.shift();
      if (!next) return false;
      t = next.at;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return true;
    },
  };
}

describe("polling do status do pedido", () => {
  test("consulta a cada 3 s e avisa quando o status muda (uma vez)", async () => {
    const c = fakeClock();
    const answers = ["pending", "pending", "paid"];
    const seen: string[] = [];
    let calls = 0;
    pollOrderStatus({
      initial: "pending",
      fetchStatus: async () => answers[calls++] ?? "paid",
      onChange: (s) => seen.push(s),
      ...c,
    });
    expect(POLL_INTERVAL_MS).toBe(3000);
    for (let i = 0; i < 3; i++) await c.step();
    expect(c.now()).toBe(9000);
    expect(seen).toEqual(["paid"]);
    expect(c.pending()).toBe(0);
  });

  test("erro de rede não interrompe; para depois de 30 min", async () => {
    const c = fakeClock();
    let calls = 0;
    let gaveUp = false;
    pollOrderStatus({
      initial: "pending",
      fetchStatus: async () => {
        calls++;
        if (calls % 2) throw new Error("offline");
        return "pending";
      },
      onChange: () => {
        throw new Error("não devia mudar");
      },
      onGiveUp: () => (gaveUp = true),
      ...c,
    });
    while (await c.step());
    expect(POLL_MAX_MS).toBe(30 * 60 * 1000);
    expect(gaveUp).toBe(true);
    expect(calls).toBe(POLL_MAX_MS / POLL_INTERVAL_MS);
    expect(c.now()).toBe(POLL_MAX_MS);
  });

  test("stop() cancela o próximo agendamento", async () => {
    const c = fakeClock();
    let calls = 0;
    const stop = pollOrderStatus({ initial: "pending", fetchStatus: async () => (calls++, "pending"), onChange: () => {}, ...c });
    await c.step();
    stop();
    expect(c.pending()).toBe(0);
    expect(calls).toBe(1);
  });
});
