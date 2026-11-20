import { describe, expect, test } from "bun:test";
import {
  FRAME_READY_TIMEOUT_MS,
  FRAME_UNAVAILABLE_MESSAGE,
  TICKET_RENEW_AFTER_MS,
  acceptFrameMessage,
  createCardFrameController,
  frameFieldNames,
  payWithFrame,
  type CardOrder,
  type FrameResult,
} from "@/app/c/[slug]/card-frame";
import type { ParentMsg } from "@/lib/card-frame/protocol";

const ORIGIN = "https://pagar.loja.test";
const win = { name: "janela do iframe" };

describe("acceptFrameMessage", () => {
  const frame = { origin: ORIGIN, window: win };
  test("origem diferente: null", () => {
    expect(acceptFrameMessage({ origin: "https://outra.test", source: win, data: { t: "funil-card:ready" } }, frame)).toBeNull();
    expect(acceptFrameMessage({ origin: "http://pagar.loja.test", source: win, data: { t: "funil-card:ready" } }, frame)).toBeNull();
  });
  test("source diferente da janela do iframe: null", () => {
    expect(acceptFrameMessage({ origin: ORIGIN, source: {}, data: { t: "funil-card:ready" } }, frame)).toBeNull();
    expect(acceptFrameMessage({ origin: ORIGIN, source: null, data: { t: "funil-card:ready" } }, { origin: ORIGIN, window: null })).toBeNull();
  });
  test("mensagem válida passa; inválida não", () => {
    expect(acceptFrameMessage({ origin: ORIGIN, source: win, data: { t: "funil-card:ready" } }, frame)).toEqual({ t: "funil-card:ready" });
    expect(acceptFrameMessage({ origin: ORIGIN, source: win, data: { t: "funil-card:height", px: 320, extra: "x" } }, frame)).toEqual({ t: "funil-card:height", px: 320 });
    expect(acceptFrameMessage({ origin: ORIGIN, source: win, data: { t: "funil-card:result", id: "a", status: "paid" } }, frame)).toBeNull();
    expect(acceptFrameMessage({ origin: ORIGIN, source: win, data: "funil-card:ready" }, frame)).toBeNull();
  });
});

test("frameFieldNames: só nomes conhecidos (inclui os do comprador), sem repetir", () => {
  expect(frameFieldNames([["cardNumber"], ["cpf"], ["__proto__"], ["customer.phone"], ["phone"], ["cardNumber"], ["cep", "x"]])).toEqual(["cardNumber", "cpf", "phone", "cep"]);
  expect(frameFieldNames(["holderCpf", "toString", "installments"])).toEqual(["holderCpf", "installments"]);
});

// ---- controlador (sem DOM): timers e postMessage falsos ----

function harness() {
  const posted: ParentMsg[] = [];
  const statuses: string[] = [];
  const heights: number[] = [];
  let submits = 0;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let seq = 0;
  const frameWindow: { current: unknown } = { current: win };
  const ctrl = createCardFrameController({
    origin: ORIGIN,
    getWindow: () => frameWindow.current,
    post: (m) => posted.push(m),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    newId: () => `id-${++seq}`,
    onStatus: (s) => statuses.push(s),
    onHeight: (px) => heights.push(px),
    onSubmit: () => submits++,
  });
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.fn();
    }
  };
  const send = (data: unknown, over: { origin?: string; source?: unknown } = {}) =>
    ctrl.handle({ origin: over.origin ?? ORIGIN, source: "source" in over ? over.source : win, data });
  return { ctrl, posted, statuses, heights, timers, fire, send, frameWindow, submits: () => submits };
}

describe("controlador do iframe", () => {
  test("submit (Enter num campo do iframe): chama onSubmit só da origem e da janela do iframe, e só depois do ready", () => {
    const h = harness();
    h.ctrl.setConfig({ totalCents: 990, maxInstallments: 1 });
    h.ctrl.start();
    h.send({ t: "funil-card:submit" });
    expect(h.submits()).toBe(0); // antes do ready
    h.send({ t: "funil-card:ready" });
    h.send({ t: "funil-card:submit" }, { origin: "https://outra.test" });
    h.send({ t: "funil-card:submit" }, { source: {} });
    h.send({ t: "funil-card:submit" }, { source: null });
    expect(h.submits()).toBe(0);
    h.send({ t: "funil-card:submit", number: "4111111111111111" });
    expect(h.submits()).toBe(1);
    h.ctrl.dispose();
    h.send({ t: "funil-card:submit" });
    expect(h.submits()).toBe(1);
  });

  test("ready: manda config (total e parcelas atuais) e fica pronto; altura vem de height", () => {
    const h = harness();
    h.ctrl.setConfig({ totalCents: 990, maxInstallments: 3 });
    h.ctrl.start();
    expect(h.posted).toEqual([]); // nada antes do ready
    expect(h.ctrl.status).toBe("loading");
    h.send({ t: "funil-card:ready" });
    expect(h.ctrl.status).toBe("ready");
    expect(h.statuses).toEqual(["ready"]);
    expect(h.posted).toEqual([{ t: "funil-card:config", totalCents: 990, maxInstallments: 3 }]);
    h.send({ t: "funil-card:height", px: 412 });
    expect(h.heights).toEqual([412]);
  });

  test("bump ligado ou desligado depois do ready: reenvia config com o total novo", () => {
    const h = harness();
    h.ctrl.setConfig({ totalCents: 990, maxInstallments: 3 });
    h.ctrl.start();
    h.send({ t: "funil-card:ready" });
    h.ctrl.setConfig({ totalCents: 2700, maxInstallments: 3 });
    h.ctrl.setConfig({ totalCents: 2700, maxInstallments: 3 }); // igual: não reenvia
    h.ctrl.setConfig({ totalCents: 990, maxInstallments: 3 });
    expect(h.posted.map((m) => (m.t === "funil-card:config" ? m.totalCents : null))).toEqual([990, 2700, 990]);
  });

  test("sem ready em FRAME_READY_TIMEOUT_MS: indisponível, validate e pay nem são enviados", async () => {
    const h = harness();
    expect(FRAME_READY_TIMEOUT_MS).toBe(10_000);
    expect(FRAME_UNAVAILABLE_MESSAGE).toBe("Pagamento com cartão indisponível agora. Tente de novo em instantes ou pague com Pix.");
    h.ctrl.setConfig({ totalCents: 990, maxInstallments: 1 });
    h.ctrl.start();
    h.fire(FRAME_READY_TIMEOUT_MS);
    expect(h.ctrl.status).toBe("unavailable");
    expect(h.statuses).toEqual(["unavailable"]);
    expect(await h.ctrl.validate()).toBeNull();
    expect(await h.ctrl.pay({ orderPublicId: "p", ticket: "t", buyerCpf: "52998224725" })).toBeNull();
    expect(h.posted).toEqual([]);
  });

  test("ready dentro do prazo cancela o timer de indisponível", () => {
    const h = harness();
    h.ctrl.start();
    const readyTimer = h.timers.find((x) => x.ms === FRAME_READY_TIMEOUT_MS)!;
    expect(readyTimer.live).toBe(true);
    h.send({ t: "funil-card:ready" });
    expect(readyTimer.live).toBe(false);
    h.fire(FRAME_READY_TIMEOUT_MS);
    expect(h.ctrl.status).toBe("ready");
    expect(h.statuses).toEqual(["ready"]);
  });

  test("pay leva o token do Turnstile do checkout quando há; sem token, a mensagem não tem a chave", () => {
    const h = harness();
    h.ctrl.setConfig({ totalCents: 990, maxInstallments: 1 });
    h.ctrl.start();
    h.send({ t: "funil-card:ready" });
    void h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725", turnstileToken: "tok-1" });
    void h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    const pays = h.posted.filter((m) => m.t === "funil-card:pay");
    expect(pays[0]).toEqual({ t: "funil-card:pay", id: "id-1", orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725", turnstileToken: "tok-1" });
    expect(Object.keys(pays[1]!)).not.toContain("turnstileToken");
  });

  test("iframe recarregado (novo ready) com pay pendente: o pendente termina já (null), sem esperar o prazo", async () => {
    const h = harness();
    h.ctrl.setConfig({ totalCents: 990, maxInstallments: 1 });
    h.ctrl.start();
    h.send({ t: "funil-card:ready" });
    const p = h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    const payTimer = h.timers.at(-1)!;
    h.send({ t: "funil-card:ready" });
    expect(await p).toBeNull();
    expect(payTimer.live).toBe(false);
    expect(h.posted.filter((m) => m.t === "funil-card:config")).toHaveLength(2); // o formulário novo recebe o total
    // A resposta do formulário antigo, se viesse, já não casa com nada.
    const q = h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    let settled = false;
    void q.then(() => (settled = true));
    h.send({ t: "funil-card:result", id: "id-1", status: "approved" });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  test("mensagem de outra origem ou de outro frame é ignorada (inclusive ready)", () => {
    const h = harness();
    h.ctrl.start();
    h.send({ t: "funil-card:ready" }, { origin: "https://evil.test" });
    h.send({ t: "funil-card:ready" }, { source: {} });
    expect(h.ctrl.status).toBe("loading");
    h.frameWindow.current = null; // iframe desmontado
    h.send({ t: "funil-card:ready" }, { source: null });
    expect(h.ctrl.status).toBe("loading");
  });

  test("validated só casa com um validate pendente; result só com um pay pendente do mesmo id", async () => {
    const h = harness();
    h.ctrl.start();
    h.send({ t: "funil-card:ready" });
    // result sem pay pendente: ignorado (não vira resposta do próximo pay)
    h.send({ t: "funil-card:result", id: "id-1", status: "approved" });
    const v = h.ctrl.validate();
    expect(h.posted.at(-1)).toEqual({ t: "funil-card:validate", id: "id-1" });
    h.send({ t: "funil-card:result", id: "id-1", status: "approved" }); // tipo errado para o id: ignorado
    h.send({ t: "funil-card:validated", id: "outro", ok: true, fields: [] }); // id desconhecido: ignorado
    h.send({ t: "funil-card:validated", id: "id-1", ok: false, fields: ["cardNumber"] });
    expect(await v).toEqual({ t: "funil-card:validated", id: "id-1", ok: false, fields: ["cardNumber"] });

    const p = h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    expect(h.posted.at(-1)).toEqual({ t: "funil-card:pay", id: "id-2", orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    h.send({ t: "funil-card:result", id: "id-2", status: "approved" }, { origin: "https://evil.test" }); // forjado: ignorado
    h.send({ t: "funil-card:validated", id: "id-2", ok: true, fields: [] }); // tipo errado
    h.send({ t: "funil-card:result", id: "id-2", status: "declined", last4: "1111" });
    expect(await p).toEqual({ t: "funil-card:result", id: "id-2", status: "declined", last4: "1111" });
    // a mesma resposta de novo: já não há pendência, e ela não responde o próximo pay
    const p2 = h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    let settled = false;
    void p2.then(() => (settled = true));
    h.send({ t: "funil-card:result", id: "id-2", status: "approved" });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.send({ t: "funil-card:result", id: "id-3", status: "approved" });
    expect(await p2).toEqual({ t: "funil-card:result", id: "id-3", status: "approved" });
  });

  test("sem resposta no prazo: validate e pay resolvem null e a resposta atrasada é ignorada", async () => {
    const h = harness();
    h.ctrl.start();
    h.send({ t: "funil-card:ready" });
    const v = h.ctrl.validate();
    const vTimer = h.timers.at(-1)!;
    vTimer.live = false;
    vTimer.fn();
    expect(await v).toBeNull();
    const p = h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    const pTimer = h.timers.at(-1)!;
    expect(pTimer.ms).toBeGreaterThan(75_000); // acima do prazo do POST no iframe
    pTimer.live = false;
    pTimer.fn();
    expect(await p).toBeNull();
    // a resposta atrasada não vale para o pay seguinte
    const p3 = h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    let settled = false;
    void p3.then(() => (settled = true));
    h.send({ t: "funil-card:result", id: "id-2", status: "approved" });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.send({ t: "funil-card:result", id: "id-3", status: "declined", last4: "4444" });
    expect((await p3)?.status).toBe("declined");
  });

  test("dispose: pendências resolvem null e nada mais é aceito", async () => {
    const h = harness();
    h.ctrl.start();
    h.send({ t: "funil-card:ready" });
    const p = h.ctrl.pay({ orderPublicId: "pub", ticket: "tk", buyerCpf: "52998224725" });
    h.ctrl.dispose();
    expect(await p).toBeNull();
    h.send({ t: "funil-card:height", px: 99 });
    expect(h.heights).toEqual([]);
  });
});

// ---- fluxo do "Pagar" (pedido, bilhete, pay, renovação) ----

const T0 = 1_800_000_000_000;
type PayArgs = { orderPublicId: string; ticket: string; turnstileToken?: string };

type Renewal = { ok: true; ticket: string } | { ok: false; message: string; definitive: boolean };
function flow(opts: { order?: CardOrder | null; now?: number; results: (FrameResult | null)[]; renew?: Renewal; turnstileToken?: string }) {
  const calls = { start: 0, renew: [] as string[], renewTickets: [] as string[], pay: [] as PayArgs[] };
  const results = [...opts.results];
  return {
    calls,
    run: () =>
      payWithFrame({
        order: opts.order ?? null,
        sig: "sig-1",
        ...(opts.turnstileToken ? { turnstileToken: opts.turnstileToken } : {}),
        now: () => opts.now ?? T0,
        start: async () => {
          calls.start++;
          return { ok: true as const, publicId: "pub-new", cardTicket: "ticket-new" };
        },
        renew: async ({ publicId, ticket }) => {
          calls.renew.push(publicId);
          calls.renewTickets.push(ticket);
          return opts.renew ?? { ok: true as const, ticket: "ticket-renewed" };
        },
        pay: async (a) => {
          calls.pay.push(a);
          return results.shift() ?? null;
        },
      }),
  };
}
const result = (r: Omit<FrameResult, "t" | "id">): FrameResult => ({ t: "funil-card:result", id: "x", ...r });

describe("payWithFrame", () => {
  test("sem pedido: cria, guarda o bilhete e paga; aprovado ou desconhecido vai para o pedido", async () => {
    const f = flow({ results: [result({ status: "approved" })] });
    const r = await f.run();
    expect(f.calls.start).toBe(1);
    expect(f.calls.pay).toEqual([{ orderPublicId: "pub-new", ticket: "ticket-new" }]);
    expect(r.outcome).toEqual({ kind: "go", publicId: "pub-new" });
    expect(r.order).toEqual({ publicId: "pub-new", sig: "sig-1", ticket: "ticket-new", ticketAt: T0 });
    expect((await flow({ results: [result({ status: "unknown" })] }).run()).outcome).toEqual({ kind: "go", publicId: "pub-new" });
  });

  test("erro ao criar o pedido: devolve o erro, sem pay", async () => {
    const calls = { pay: 0 };
    const r = await payWithFrame({
      order: null,
      sig: "s",
      now: () => T0,
      start: async () => ({ ok: false as const, message: "Confira os campos marcados.", fields: { "customer.email": "x" } }),
      renew: async () => ({ ok: true as const, ticket: "t" }),
      pay: async () => {
        calls.pay++;
        return null;
      },
    });
    expect(r.outcome).toEqual({ kind: "start_error", result: { ok: false, message: "Confira os campos marcados.", fields: { "customer.email": "x" } } });
    expect(calls.pay).toBe(0);
  });

  test("pedido reaproveitado com bilhete novo: não cria outro nem renova", async () => {
    const order = { publicId: "pub-old", sig: "sig-1", ticket: "ticket-old", ticketAt: T0 - 10 * 60_000 };
    const f = flow({ order, results: [result({ status: "approved" })] });
    expect((await f.run()).outcome).toEqual({ kind: "go", publicId: "pub-old" });
    expect(f.calls.start).toBe(0);
    expect(f.calls.renew).toEqual([]);
    expect(f.calls.pay).toEqual([{ orderPublicId: "pub-old", ticket: "ticket-old" }]);
  });

  test("pedido reaproveitado com bilhete de mais de 25 min: renova antes do pay, mesmo pedido", async () => {
    expect(TICKET_RENEW_AFTER_MS).toBe(25 * 60_000);
    const order = { publicId: "pub-old", sig: "sig-1", ticket: "ticket-old", ticketAt: T0 - TICKET_RENEW_AFTER_MS - 1 };
    const f = flow({ order, results: [result({ status: "approved" })] });
    const r = await f.run();
    expect(f.calls.start).toBe(0);
    expect(f.calls.renew).toEqual(["pub-old"]);
    expect(f.calls.renewTickets).toEqual(["ticket-old"]); // a renovação apresenta o bilhete anterior
    expect(f.calls.pay).toEqual([{ orderPublicId: "pub-old", ticket: "ticket-renewed" }]);
    expect(r.order).toEqual({ publicId: "pub-old", sig: "sig-1", ticket: "ticket-renewed", ticketAt: T0 });
  });

  test("dados pessoais ou bump mudaram (outra assinatura): cria pedido novo", async () => {
    const order = { publicId: "pub-old", sig: "outra", ticket: "ticket-old", ticketAt: T0 };
    const f = flow({ order, results: [result({ status: "approved" })] });
    expect((await f.run()).outcome).toEqual({ kind: "go", publicId: "pub-new" });
    expect(f.calls.start).toBe(1);
  });

  test("ticketExpired: renova e reenvia o pay uma única vez, para o mesmo pedido", async () => {
    const f = flow({ results: [result({ status: "error", ticketExpired: true, message: "g" }), result({ status: "approved" })] });
    const r = await f.run();
    expect(f.calls.start).toBe(1);
    expect(f.calls.renew).toEqual(["pub-new"]);
    expect(f.calls.pay).toEqual([
      { orderPublicId: "pub-new", ticket: "ticket-new" },
      { orderPublicId: "pub-new", ticket: "ticket-renewed" },
    ]);
    expect(r.outcome).toEqual({ kind: "go", publicId: "pub-new" });
    expect(r.order?.ticket).toBe("ticket-renewed");
  });

  test("ticketExpired duas vezes: para na segunda, com a mensagem genérica", async () => {
    const f = flow({ results: [result({ status: "error", ticketExpired: true }), result({ status: "error", ticketExpired: true })] });
    const r = await f.run();
    expect(f.calls.pay).toHaveLength(2);
    expect(r.outcome).toEqual({ kind: "failed", message: "Não foi possível processar o pagamento. Tente de novo em instantes.", marks: [] });
  });

  test("renovação recusada de vez (pedido não pendente, bilhete recusado): mensagem genérica, sem novo pay, pedido esquecido", async () => {
    const msg = "Não foi possível continuar agora. Tente de novo em instantes.";
    const f = flow({ results: [result({ status: "error", ticketExpired: true })], renew: { ok: false, message: msg, definitive: true } });
    const r = await f.run();
    expect(f.calls.pay).toHaveLength(1);
    expect(r.outcome).toEqual({ kind: "failed", message: msg, marks: [] });
    expect(r.order).toBeNull();
    const old = { publicId: "pub-old", sig: "sig-1", ticket: "t", ticketAt: T0 - TICKET_RENEW_AFTER_MS - 1 };
    const g = flow({ order: old, results: [], renew: { ok: false, message: msg, definitive: true } });
    const r2 = await g.run();
    expect(g.calls.pay).toEqual([]);
    expect(r2.outcome.kind).toBe("failed");
    expect(r2.order).toBeNull();
  });

  test("renovação com erro passageiro: mensagem genérica, sem novo pay, e o pedido fica para a próxima tentativa", async () => {
    const msg = "Não foi possível continuar agora. Tente de novo em instantes.";
    const f = flow({ results: [result({ status: "error", ticketExpired: true })], renew: { ok: false, message: msg, definitive: false } });
    const r = await f.run();
    expect(f.calls.pay).toHaveLength(1);
    expect(r.outcome).toEqual({ kind: "failed", message: msg, marks: [] });
    expect(r.order).toEqual({ publicId: "pub-new", sig: "sig-1", ticket: "ticket-new", ticketAt: T0 });
    const old = { publicId: "pub-old", sig: "sig-1", ticket: "t", ticketAt: T0 - TICKET_RENEW_AFTER_MS - 1 };
    const r2 = await flow({ order: old, results: [], renew: { ok: false, message: msg, definitive: false } }).run();
    expect(r2.order).toEqual(old);
  });

  test("celular recusado pelo servidor: marca o WhatsApp no app e esquece o pedido (o corrigido cria outro)", async () => {
    const r = await flow({ results: [result({ status: "error", message: "Confira o campo marcado para continuar.", fields: [["phone"]] })] }).run();
    expect(r.outcome).toEqual({ kind: "failed", message: "Confira o campo marcado para continuar.", marks: ["phone"] });
    expect(r.order).toBeNull();
  });

  test("recusa: tela de recusa com os 4 últimos; pedido fica para a nova tentativa", async () => {
    const r = await flow({ results: [result({ status: "declined", last4: "4444", message: "Pagamento recusado." })] }).run();
    expect(r.outcome).toEqual({ kind: "declined", last4: "4444" });
    expect(r.order?.publicId).toBe("pub-new");
  });

  test("erros: mensagem do iframe; CPF do comprador marcado quando vem `cpf`; captcha vai para o checkout", async () => {
    const withCpf = await flow({ results: [result({ status: "error", message: "Confira os 2 campos marcados para continuar.", fields: [["cpf"], ["cep"], ["evil"]] })] }).run();
    expect(withCpf.outcome).toEqual({ kind: "failed", message: "Confira os 2 campos marcados para continuar.", marks: ["cpf"] });
    expect(withCpf.order?.publicId).toBe("pub-new"); // CPF recusado: o corrigido muda a assinatura de qualquer forma
    const unavailable = await flow({ results: [result({ status: "unavailable", message: "Pagamento com cartão indisponível no momento" })] }).run();
    expect(unavailable.outcome).toEqual({ kind: "failed", message: "Pagamento com cartão indisponível no momento", marks: [] });
    const captcha = await flow({ results: [result({ status: "error", captcha: true, message: "Muitas tentativas." })] }).run();
    // Captcha: o checkout mostra o Turnstile (no pai) e o pedido fica para o `pay` com o token.
    expect(captcha.outcome).toEqual({ kind: "failed", message: "Muitas tentativas.", marks: [], captcha: true });
    expect(captcha.order?.publicId).toBe("pub-new");
  });

  test("token do Turnstile: mesmo pedido, vai em cada pay (também no de depois do bilhete renovado)", async () => {
    const order = { publicId: "pub-old", sig: "sig-1", ticket: "ticket-old", ticketAt: T0 - 60_000 };
    const f = flow({ order, turnstileToken: "tok", results: [result({ status: "error", ticketExpired: true }), result({ status: "approved" })] });
    const r = await f.run();
    expect(f.calls.start).toBe(0);
    expect(f.calls.pay).toEqual([
      { orderPublicId: "pub-old", ticket: "ticket-old", turnstileToken: "tok" },
      { orderPublicId: "pub-old", ticket: "ticket-renewed", turnstileToken: "tok" },
    ]);
    expect(r.outcome).toEqual({ kind: "go", publicId: "pub-old" });
  });

  test("iframe não respondeu: mensagem genérica e o pedido fica", async () => {
    const r = await flow({ results: [null] }).run();
    expect(r.outcome).toEqual({ kind: "failed", message: "Não foi possível processar o pagamento. Tente de novo em instantes.", marks: [] });
    expect(r.order?.publicId).toBe("pub-new");
  });

  test("pedido criado sem bilhete (não deveria acontecer): erro genérico, sem pay", async () => {
    const calls = { pay: 0 };
    const r = await payWithFrame({
      order: null,
      sig: "s",
      now: () => T0,
      start: async () => ({ ok: true as const, publicId: "p" }),
      renew: async () => ({ ok: true as const, ticket: "t" }),
      pay: async () => {
        calls.pay++;
        return null;
      },
    });
    expect(r.outcome.kind).toBe("failed");
    expect(calls.pay).toBe(0);
  });
});
