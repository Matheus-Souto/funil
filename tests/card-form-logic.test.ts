// Formulário do cartão no iframe (Task 7): funções puras (logic.ts) e o formulário montado num DOM de verdade
// (happy-dom), com o `parent` e o `fetch` falsos. Foco de revisão 3 (rede cai: mesma chave) e 5 (mensagem de outra
// origem ou de outro frame: ignorada; resposta só para a origem que mandou).
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mountCardForm, type FormDeps } from "@/card-service/form/form";
import {
  attemptKey,
  attemptSig,
  buildCardBody,
  fieldErrors,
  installmentOptions,
  mapApiResponse,
  mayHaveCharged,
  NETWORK_MESSAGE,
  newAttemptKey,
  safeFieldNames,
  ticketTerms,
  validateCardFields,
  type CardFields,
} from "@/card-service/form/logic";
import { createCardFrameController, payWithFrame, type CardOrder } from "@/app/c/[slug]/card-frame";
import type { FrameMsg, ParentMsg } from "@/lib/card-frame/protocol";

const NOW = new Date("2026-11-19T12:00:00-03:00");
const ok: CardFields = {
  cardNumber: "4111 1111 1111 1111",
  holderName: "MARIA DA SILVA",
  expiry: "12/34",
  cvv: "123",
  holderCpf: "",
  cep: "01310-100",
  addressNumber: "100",
};

describe("validateCardFields", () => {
  test("campos corretos: nenhum erro", () => {
    expect(validateCardFields(ok, false, NOW)).toEqual([]);
  });

  test("cartão vencido dá expiry (com a mesma mensagem do checkout); formato errado também", () => {
    expect(validateCardFields({ ...ok, expiry: "10/26" }, false, NOW)).toEqual(["expiry"]);
    expect(fieldErrors({ ...ok, expiry: "10/26" }, false, NOW).expiry).toBe("Cartão vencido.");
    expect(fieldErrors({ ...ok, expiry: "13/30" }, false, NOW).expiry).toBe("Use o formato MM/AA.");
    expect(fieldErrors({ ...ok, expiry: "1" }, false, NOW).expiry).toBe("Use o formato MM/AA.");
    expect(validateCardFields({ ...ok, expiry: "11/26" }, false, NOW)).toEqual([]);
  });

  test("Luhn inválido dá cardNumber; o cartão de teste do sandbox passa (o servidor decide)", () => {
    expect(validateCardFields({ ...ok, cardNumber: "4111 1111 1111 1112" }, false, NOW)).toEqual(["cardNumber"]);
    expect(fieldErrors({ ...ok, cardNumber: "4111" }, false, NOW).cardNumber).toBe("Confira o número do cartão.");
    expect(validateCardFields({ ...ok, cardNumber: "4444 4444 4444 4444" }, false, NOW)).toEqual([]);
  });

  test("CPF do titular inválido só conta com 'titular é outra pessoa' ligado", () => {
    const bad = { ...ok, holderCpf: "111.111.111-11" };
    expect(validateCardFields(bad, false, NOW)).toEqual([]);
    expect(validateCardFields(bad, true, NOW)).toEqual(["holderCpf"]);
    expect(fieldErrors(bad, true, NOW).holderCpf).toBe("CPF do titular inválido.");
    expect(validateCardFields({ ...ok, holderCpf: "529.982.247-25" }, true, NOW)).toEqual([]);
  });

  test("demais campos, na ordem do formulário, com as mensagens do checkout", () => {
    const e = fieldErrors({ cardNumber: "", holderName: " a ", expiry: "", cvv: "12", holderCpf: "", cep: "0131", addressNumber: " " }, true, NOW);
    expect(Object.keys(e)).toEqual(["cardNumber", "holderName", "expiry", "cvv", "holderCpf", "cep", "addressNumber"]);
    expect(e).toEqual({
      cardNumber: "Confira o número do cartão.",
      holderName: "Informe o nome como está no cartão.",
      expiry: "Use o formato MM/AA.",
      cvv: "3 ou 4 números no verso.",
      holderCpf: "CPF do titular inválido.",
      cep: "Confira o CEP.",
      addressNumber: "Informe o número.",
    });
  });
});

describe("attemptKey e attemptSig", () => {
  const sig = (over: Partial<CardFields> = {}, inst = 1) => attemptSig("ped-1", { ...ok, ...over }, false, inst);
  let n = 0;
  const newKey = () => `k${++n}`;

  test("mesma assinatura: mesma chave; CVV diferente: chave nova", () => {
    const a = attemptKey(null, sig(), newKey);
    expect(attemptKey(a, sig(), newKey)).toEqual(a);
    const b = attemptKey(a, sig({ cvv: "124" }), newKey);
    expect(b.key).not.toBe(a.key);
    expect(attemptKey(b, sig({ cvv: "124" }), newKey).key).toBe(b.key);
  });

  test("a assinatura muda com número, validade, parcelas, titular e pedido, e não guarda o cartão em claro", () => {
    const base = sig();
    for (const other of [sig({ cardNumber: "4111 1111 1111 1129" }), sig({ expiry: "11/34" }), sig({}, 2), sig({ cep: "01310-200" }), attemptSig("ped-2", ok, false, 1)]) {
      expect(other).not.toBe(base);
    }
    expect(sig({ cardNumber: "4111111111111111" })).toBe(base); // máscara não muda a tentativa
    for (const secret of ["4111111111111111", "4111 1111", "123", "12/34"]) expect(base).not.toContain(secret);
  });
});

describe("newAttemptKey", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  test("usa crypto.randomUUID quando existe", () => {
    expect(newAttemptKey({ randomUUID: () => "11111111-2222-4333-8444-555555555555", getRandomValues: crypto.getRandomValues.bind(crypto) })).toBe("11111111-2222-4333-8444-555555555555");
  });
  test("sem randomUUID (iOS < 15.4): UUID v4 a partir de getRandomValues, sem repetir", () => {
    const c = { getRandomValues: crypto.getRandomValues.bind(crypto) } as Parameters<typeof newAttemptKey>[0];
    const keys = new Set(Array.from({ length: 200 }, () => newAttemptKey(c)));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(UUID_V4);
    const zeros = newAttemptKey({ getRandomValues: <T extends ArrayBufferView | null>(a: T) => a } as Parameters<typeof newAttemptKey>[0]);
    expect(zeros).toBe("00000000-0000-4000-8000-000000000000");
  });
});

describe("buildCardBody", () => {
  test("titular é o comprador: CPF do titular vem do `pay`; só dígitos; sem token sem captcha", () => {
    expect(buildCardBody(ok, false, "52998224725", 3, "bilhete", "ped-1", "chave")).toEqual({
      ticket: "bilhete",
      orderPublicId: "ped-1",
      idempotencyKey: "chave",
      installments: 3,
      card: { holderName: "MARIA DA SILVA", number: "4111111111111111", expiryMonth: "12", expiryYear: "34", ccv: "123" },
      holder: { cpf: "52998224725", postalCode: "01310100", addressNumber: "100" },
    });
  });

  test("titular é outra pessoa: CPF do campo; com token do Turnstile", () => {
    const b = buildCardBody({ ...ok, holderCpf: "529.982.247-25", holderName: "  JOSE  " }, true, "11144477735", 1, "t", "p", "k", "tok");
    expect(b.holder.cpf).toBe("52998224725");
    expect(b.card.holderName).toBe("JOSE");
    expect(b.turnstileToken).toBe("tok");
  });
});

describe("installmentOptions", () => {
  test("rótulos iguais aos do checkout de hoje", () => {
    expect(installmentOptions(2700, 3)).toEqual([
      { n: 1, label: "1x de R$ 27,00 sem juros" },
      { n: 2, label: "2x (total R$ 27,00)" },
      { n: 3, label: "3x (total R$ 27,00)" },
    ]);
    expect(installmentOptions(990, 1)).toEqual([{ n: 1, label: "1x de R$ 9,90 sem juros" }]);
    expect(installmentOptions(990, 40)).toHaveLength(12);
    expect(installmentOptions(990, 0)).toHaveLength(1);
  });
});

describe("safeFieldNames e mapApiResponse", () => {
  test("só nomes conhecidos saem; caminhos do servidor viram nomes do formulário", () => {
    expect(safeFieldNames(["cardNumber", "__proto__", "cpf", "cep", "cep", "customer", 7 as unknown as string])).toEqual(["cardNumber", "cpf", "cep"]);
  });

  test("200: status do servidor; recusa leva os 4 últimos dígitos", () => {
    expect(mapApiResponse(200, { status: "approved" }, "1111", true)).toEqual({ status: "approved" });
    expect(mapApiResponse(200, { status: "declined", message: "Pagamento recusado." }, "1111", true)).toEqual({ status: "declined", message: "Pagamento recusado.", last4: "1111" });
    expect(mapApiResponse(200, { status: "unknown", message: "x" }, "1111", true)).toEqual({ status: "unknown", message: "x" });
    expect(mapApiResponse(200, { status: "unavailable", message: "y" }, "1111", true)).toEqual({ status: "unavailable", message: "y" });
    expect(mapApiResponse(200, { status: "hacked" }, "1111", true).status).toBe("error");
  });

  test("400 com campos: holder.cpf -> holderCpf, card.number -> cardNumber, customer.phone -> phone, desconhecidos caem fora", () => {
    const r = mapApiResponse(
      400,
      { error: "invalid_input", message: "Dados de pagamento inválidos", fields: [["holder", "cpf"], ["card", "number"], ["card", "expiryMonth"], ["card", "expiryYear"], ["holder", "postalCode"], ["holder", "addressNumber"], ["installments"], ["customer", "phone"], ["card", "ccv"], ["card", "holderName"]] },
      "1111",
      true,
    );
    expect(r).toEqual({
      status: "error",
      message: "Confira os 9 campos marcados para continuar.",
      fields: [["holderCpf"], ["cardNumber"], ["expiry"], ["cep"], ["addressNumber"], ["installments"], ["phone"], ["cvv"], ["holderName"]],
    });
    expect(mapApiResponse(400, { message: "Dados de pagamento inválidos", fields: [["card", "number"]] }, "1111", true).message).toBe("Confira o campo marcado para continuar.");
    expect(mapApiResponse(400, { message: "Parcelas inválidas", fields: [["installments"]] }, "1111", true).message).toBe("Parcelas inválidas");
    expect(mapApiResponse(400, { message: "JSON inválido" }, "1111", true)).toEqual({ status: "error", message: "JSON inválido" });
  });

  test("holder.cpf com 'titular é outra pessoa' desligado sai como `cpf` (o CPF do comprador, campo do app)", () => {
    const body = { message: "Dados de pagamento inválidos", fields: [["holder", "cpf"], ["holder", "postalCode"]] };
    expect(mapApiResponse(400, body, "1111", false)).toEqual({ status: "error", message: "Confira os 2 campos marcados para continuar.", fields: [["cpf"], ["cep"]] });
    expect(mapApiResponse(400, body, "1111", true).fields).toEqual([["holderCpf"], ["cep"]]);
  });

  test("dados do comprador recusados pelo servidor saem com o nome do campo do app", () => {
    const body = (path: string[], message = "Confira o número de WhatsApp") => ({ error: "invalid_input", message, fields: [path] });
    expect(mapApiResponse(400, body(["customer", "phone"]), "1111", false)).toEqual({ status: "error", message: "Confira o número de WhatsApp", fields: [["phone"]] });
    expect(mapApiResponse(400, body(["customer", "cpf"], "CPF inválido"), "1111", true).fields).toEqual([["cpf"]]);
    expect(mapApiResponse(400, body(["customer", "name"], "x"), "1111", true).fields).toEqual([["name"]]);
    expect(mapApiResponse(400, body(["customer", "email"], "x"), "1111", true).fields).toEqual([["email"]]);
    expect(mapApiResponse(400, body(["customer", "address"], "x"), "1111", true).fields).toBeUndefined();
  });

  test("mayHaveCharged: só trava o cartão quando o servidor pode ter cobrado", () => {
    const e = { status: "error" as const, message: "x" };
    expect(mayHaveCharged(null, e)).toBe(false); // nada enviado / sem resposta da rede
    expect(mayHaveCharged(400, e)).toBe(false);
    expect(mayHaveCharged(403, { ...e, ticketExpired: true })).toBe(false);
    expect(mayHaveCharged(429, { ...e, captcha: true })).toBe(false);
    expect(mayHaveCharged(200, { status: "unavailable", message: "x" })).toBe(false);
    for (const status of ["approved", "declined", "unknown"] as const) expect(mayHaveCharged(200, { status })).toBe(true);
    expect(mayHaveCharged(200, e)).toBe(true); // 200 com status estranho: conservador
    expect(mayHaveCharged(500, e)).toBe(true);
    expect(mayHaveCharged(502, e)).toBe(true);
  });

  test("403 de bilhete: erro com ticketExpired; 429: captcha; outros: mensagem do servidor ou a genérica", () => {
    expect(mapApiResponse(403, { error: "ticket", ticketExpired: true }, "1111", true)).toEqual({
      status: "error",
      ticketExpired: true,
      message: "Não foi possível processar o pagamento. Tente de novo em instantes.",
    });
    expect(mapApiResponse(403, { error: "ticket", ticketExpired: false }, "1111", true).ticketExpired).toBe(false);
    expect(mapApiResponse(429, { captcha: true, message: "Muitas tentativas." }, "1111", true)).toEqual({ status: "error", captcha: true, message: "Muitas tentativas." });
    expect(mapApiResponse(502, {}, "1111", true)).toEqual({ status: "error", message: "Não foi possível processar o pagamento. Tente de novo em instantes." });
    expect(mapApiResponse(500, "lixo", "1111", true).status).toBe("error");
    expect(mapApiResponse(503, { message: "x".repeat(400) }, "1111", true).message!.length).toBeLessThanOrEqual(300);
  });
});

describe("ticketTerms (lê o corpo do bilhete, sem conferir a assinatura: quem confere é o servidor)", () => {
  const body = (o: unknown) => `${Buffer.from(JSON.stringify(o)).toString("base64url")}.sig`;
  test("total e parcelas do corpo", () => {
    expect(ticketTerms(body({ s: "x", t: 4990, m: 3 }))).toEqual({ totalCents: 4990, maxInstallments: 3 });
    // base64url sem padding, com - e _ (caracteres que o atob não aceita direto)
    expect(ticketTerms(body({ p: "??>>~~", t: 1, m: 12 }))).toEqual({ totalCents: 1, maxInstallments: 12 });
  });
  test("malformado ou sem os campos: null", () => {
    for (const bad of ["", ".", "x", "@@@.sig", body([1]), body({ t: 990 }), body({ m: 1 }), body({ t: "990", m: 1 }), body({ t: 9.5, m: 1 }), body({ t: 0, m: 1 }), body({ t: 1, m: 13 }), `${Buffer.from("{nope").toString("base64url")}.s`]) {
      expect(ticketTerms(bad)).toBeNull();
    }
  });
});

// ---- formulário montado (happy-dom) ----

const SHOP = "https://loja.example";
const OTHER_SHOP = "https://loja.example.com.br";
const EVIL = "https://evil.example";
const STORE = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const GENERIC = "Não foi possível processar o pagamento. Tente de novo em instantes.";
/** Bilhete no formato do app (corpo base64url + assinatura); o iframe só lê o corpo (total e parcelas), sem a chave. */
const ticketFor = (n: number | string, totalCents = 990, maxInstallments = 1) =>
  `${Buffer.from(JSON.stringify({ s: STORE, o: "0b1c2d3e-4f50-4617-8899-000000000001", p: `ped-${n}`, e: 2_000_000_000, t: totalCents, m: maxInstallments })).toString("base64url")}.assinatura-${n}`;
const T1 = ticketFor(1);
const T2 = ticketFor(2);
type Posted = { msg: FrameMsg; origin: string };
type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };

const open: Window[] = [];
afterEach(async () => {
  for (const w of open.splice(0)) await w.happyDOM.close();
});

function setup(
  opts: { responses?: (Response | Error | Promise<Response>)[]; storeId?: string | null; payTimeoutMs?: number; topLevel?: boolean; config?: false } = {},
) {
  const w = new Window({ url: "https://pagar.example/form/x", settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } as never });
  open.push(w);
  w.document.head.innerHTML = `<script type="application/json" id="cfg">${JSON.stringify({ allowedOrigins: [SHOP, OTHER_SHOP], ...(opts.storeId === null ? {} : { storeId: opts.storeId ?? STORE }) })}</script>`;
  w.document.body.innerHTML = `<main id="card-form"></main>`;
  const posted: Posted[] = [];
  const waiters: ((p: Posted) => void)[] = [];
  const postMessage = (msg: FrameMsg, origin: string) => {
    const p = { msg, origin };
    posted.push(p);
    waiters.splice(0).forEach((r) => r(p));
  };
  // Aberto fora de moldura: window.parent é a própria janela.
  const parent: { postMessage: typeof postMessage } = opts.topLevel ? Object.assign(w as unknown as { postMessage: typeof postMessage }, { postMessage }) : { postMessage };
  const calls: FetchCall[] = [];
  const responses = [...(opts.responses ?? [])];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const r = responses.shift() ?? Response.json({ status: "approved" });
    if (r instanceof Error) throw r;
    return await r;
  }) as unknown as typeof fetch;
  let k = 0;
  mountCardForm({ win: w as unknown as FormDeps["win"], parent, fetch: fakeFetch, newKey: () => `key-${++k}`, now: () => NOW, payTimeoutMs: opts.payTimeoutMs });
  const doc = w.document;
  const input = (id: string) => doc.getElementById(id) as unknown as HTMLInputElement;
  const type = (id: string, value: string) => {
    const el = input(id);
    el.value = value;
    el.dispatchEvent(new w.Event("input", { bubbles: true }) as unknown as Event);
  };
  const fill = (v: Partial<CardFields> = {}) => {
    const f = { ...ok, ...v };
    for (const [id, value] of Object.entries(f)) if (id !== "holderCpf" || value) type(id, value);
  };
  const send = (data: unknown, origin = SHOP, source: unknown = parent) =>
    w.dispatchEvent(new w.MessageEvent("message", { data, origin, source: source as never }));
  // O checkout manda o total e as parcelas assim que o iframe fica pronto (o bilhete padrão, T1, bate com eles).
  if (opts.config !== false) send({ t: "funil-card:config", totalCents: 990, maxInstallments: 1 });
  /** Próxima mensagem do iframe de um tipo (sem espera fixa: resolve quando o iframe posta). */
  const next = (t: FrameMsg["t"]) =>
    new Promise<Posted>((resolve) => {
      const found = posted.find((p) => p.msg.t === t && !seen.has(p));
      if (found) {
        seen.add(found);
        return resolve(found);
      }
      const wait = (p: Posted) => {
        if (p.msg.t === t) {
          seen.add(p);
          resolve(p);
        } else waiters.push(wait);
      };
      waiters.push(wait);
    });
  const seen = new Set<Posted>();
  const pay = (id: string, over: Record<string, unknown> = {}) =>
    send({ t: "funil-card:pay", id, orderPublicId: "ped-1", ticket: T1, buyerCpf: "52998224725", ...over });
  return { w, doc, posted, calls, parent, input, type, fill, send, next, pay };
}

describe("formulário no iframe", () => {
  test("campos com os rótulos do checkout, sem atributo name, e o form não envia nada sem JS", () => {
    const { doc } = setup();
    const form = doc.querySelector("form")!;
    expect(form.hasAttribute("action")).toBe(false);
    expect(form.hasAttribute("method")).toBe(false);
    const labels = [...doc.querySelectorAll("label")].map((l) => l.textContent!.trim());
    expect(labels).toEqual(["Número do cartão", "Nome impresso no cartão", "Validade", "CVV", "O cartão está no nome de outra pessoa", "CPF do titular do cartão", "CEP", "Número", "Parcelas"]);
    for (const el of doc.querySelectorAll("input, select")) expect(el.hasAttribute("name")).toBe(false);
    expect(doc.querySelectorAll("[style]").length).toBe(0);
    const ev = new doc.defaultView!.Event("submit", { cancelable: true });
    form.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("máscaras do checkout atual", () => {
    const { type, input } = setup();
    type("cardNumber", "4111111111111111999");
    expect(input("cardNumber").value).toBe("4111 1111 1111 1111 999");
    type("expiry", "1234");
    expect(input("expiry").value).toBe("12/34");
    type("cvv", "12a345");
    expect(input("cvv").value).toBe("1234");
    type("holderName", "maria");
    expect(input("holderName").value).toBe("MARIA");
    type("holderCpf", "52998224725");
    expect(input("holderCpf").value).toBe("529.982.247-25");
    type("cep", "01310100");
    expect(input("cep").value).toBe("01310-100");
  });

  test("ready vai a cada origem permitida, e nunca com destino '*'", () => {
    const { posted } = setup();
    const ready = posted.filter((p) => p.msg.t === "funil-card:ready").map((p) => p.origin);
    expect(ready).toEqual([SHOP, OTHER_SHOP]);
    expect(posted.some((p) => p.origin === "*")).toBe(false);
  });

  test("mensagem de outra origem ou de outro frame é ignorada; a resposta vai só para a origem que mandou", async () => {
    const { send, posted, parent, next } = setup();
    const before = posted.length;
    send({ t: "funil-card:validate", id: "v1" }, EVIL);
    send({ t: "funil-card:validate", id: "v2" }, SHOP, {});
    send({ t: "funil-card:validate", id: "v3" }, SHOP, null);
    send({ t: "funil-card:validate", id: "v4", extra: 1 }, "null", parent);
    expect(posted.slice(before).filter((p) => p.msg.t === "funil-card:validated")).toEqual([]);
    send({ t: "funil-card:validate", id: "v5" }, OTHER_SHOP);
    const r = await next("funil-card:validated");
    expect(r.origin).toBe(OTHER_SHOP);
    expect(r.msg).toEqual({ t: "funil-card:validated", id: "v5", ok: false, fields: ["cardNumber", "holderName", "expiry", "cvv", "cep", "addressNumber"] });
  });

  test("validate com campos corretos: ok; com erro, marca o campo com a mensagem do checkout", async () => {
    const { fill, send, next, doc } = setup();
    fill({ expiry: "10/26" });
    send({ t: "funil-card:validate", id: "v1" });
    expect((await next("funil-card:validated")).msg).toEqual({ t: "funil-card:validated", id: "v1", ok: false, fields: ["expiry"] });
    const field = doc.getElementById("expiry")!.closest("[data-invalid]")!;
    expect(field.getAttribute("data-invalid")).toBe("true");
    expect(doc.getElementById("expiry-msg")!.textContent).toBe("Cartão vencido.");
    fill();
    expect(doc.getElementById("expiry")!.closest("[data-invalid]")).toBeNull();
    send({ t: "funil-card:validate", id: "v2" });
    expect((await next("funil-card:validated")).msg).toEqual({ t: "funil-card:validated", id: "v2", ok: true, fields: [] });
  });

  test("pay: POST relativo /api/card com o corpo certo; result sem dados do cartão; id repetido é ignorado", async () => {
    const { fill, pay, next, calls, posted } = setup({ responses: [Response.json({ status: "declined", message: "Pagamento recusado. Confira os dados ou pague com Pix." })] });
    fill();
    pay("p1");
    const r = await next("funil-card:result");
    expect(r.origin).toBe(SHOP);
    expect(r.msg).toEqual({ t: "funil-card:result", id: "p1", status: "declined", message: "Pagamento recusado. Confira os dados ou pague com Pix.", last4: "1111" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/card");
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(calls[0]!.body).toEqual({
      storeId: STORE,
      ticket: T1,
      orderPublicId: "ped-1",
      idempotencyKey: "key-1",
      installments: 1,
      card: { holderName: "MARIA DA SILVA", number: "4111111111111111", expiryMonth: "12", expiryYear: "34", ccv: "123" },
      holder: { cpf: "52998224725", postalCode: "01310100", addressNumber: "100" },
    });
    pay("p1");
    pay("p1");
    expect(calls).toHaveLength(1);
    const all = JSON.stringify(posted);
    for (const secret of ["4111111111111111", "4111 1111", "\"123\"", "12/34", T1]) expect(all).not.toContain(secret);
  });

  test("um pay por vez: o segundo, durante o primeiro, recebe erro genérico; id repetido continua ignorado", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((r) => (release = r));
    const { fill, pay, next, calls, posted } = setup({ responses: [pending, Response.json({ status: "approved" })] });
    fill();
    pay("p1");
    pay("p2");
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p2", status: "error", message: GENERIC });
    pay("p1");
    expect(calls).toHaveLength(1);
    release(Response.json({ status: "unknown", message: "m" }));
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p1", status: "unknown" });
    expect(posted.filter((p) => p.msg.t === "funil-card:result")).toHaveLength(2);
    pay("p2");
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p2", status: "approved" });
  });

  test("POST sem resposta no prazo conta como queda de rede: 'Sem conexão…' e a mesma chave na próxima", async () => {
    const { fill, pay, next, calls } = setup({ payTimeoutMs: 5, responses: [new Promise<Response>(() => {}), Response.json({ status: "approved" })] });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", message: NETWORK_MESSAGE });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    pay("p2");
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p2", status: "approved" });
    expect(calls.map((c) => c.body.idempotencyKey)).toEqual(["key-1", "key-1"]);
  });

  test("bilhete vencido (403): nada foi processado, então a próxima tentativa usa a mesma chave", async () => {
    const { fill, pay, next, calls } = setup({ responses: [Response.json({ error: "ticket", ticketExpired: true }, { status: 403 }), Response.json({ status: "approved" })] });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p1", status: "error", ticketExpired: true });
    pay("p2", { ticket: T2 });
    await next("funil-card:result");
    expect(calls.map((c) => [c.body.ticket, c.body.idempotencyKey])).toEqual([
      [T1, "key-1"],
      [T2, "key-1"],
    ]);
  });

  test("depois de um result, pay para OUTRO pedido só passa se o comprador editou o iframe", async () => {
    const { fill, pay, next, calls, type, doc } = setup({ responses: [Response.json({ status: "declined" }), Response.json({ status: "approved" }), Response.json({ status: "approved" })] });
    fill();
    pay("p1");
    await next("funil-card:result");
    // mesmo pedido (retentativa normal): passa sem edição
    pay("p2");
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p2", status: "approved" });
    // outro pedido sem edição: recusado sem chamar a API, com o número do cartão marcado
    pay("p3", { orderPublicId: "ped-2" });
    expect((await next("funil-card:result")).msg).toEqual({
      t: "funil-card:result",
      id: "p3",
      status: "error",
      message: "Confira o campo marcado para continuar.",
      fields: [["cardNumber"]],
    });
    expect(calls).toHaveLength(2);
    expect(doc.getElementById("cardNumber")!.closest("[data-invalid]")).not.toBeNull();
    // o comprador mexe em qualquer campo: outro pedido passa
    type("cvv", "123");
    pay("p4", { orderPublicId: "ped-2" });
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p4", status: "approved" });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.orderPublicId).toBe("ped-2");
  });

  test("resposta que não cobrou (400 de campo, rede, unavailable) não trava o cartão para outro pedido", async () => {
    const { fill, pay, next, calls } = setup({
      responses: [
        Response.json({ error: "invalid_input", message: "Confira o número de WhatsApp", fields: [["customer", "phone"]] }, { status: 400 }),
        new Error("rede"),
        Response.json({ status: "unavailable", message: "Pagamento com cartão indisponível no momento" }),
        Response.json({ status: "approved" }),
      ],
    });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p1", status: "error", fields: [["phone"]] });
    pay("p2", { orderPublicId: "ped-2" });
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p2", status: "error", message: NETWORK_MESSAGE });
    pay("p3", { orderPublicId: "ped-3" });
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p3", status: "unavailable" });
    pay("p4", { orderPublicId: "ped-4" });
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p4", status: "approved" });
    expect(calls.map((c) => c.body.orderPublicId)).toEqual(["ped-1", "ped-2", "ped-3", "ped-4"]);
  });

  test("telefone recusado no campo do app: nada é marcado no iframe", async () => {
    const { fill, pay, next, doc } = setup({
      responses: [Response.json({ error: "invalid_input", message: "Confira o número de WhatsApp", fields: [["customer", "phone"]] }, { status: 400 })],
    });
    fill();
    pay("p1");
    await next("funil-card:result");
    expect(doc.querySelectorAll("[data-invalid]")).toHaveLength(0);
  });

  test("validate com erros foca o primeiro campo inválido do iframe", async () => {
    const { fill, send, next, doc } = setup();
    fill({ cardNumber: "", expiry: "" });
    (doc.getElementById("cvv") as unknown as HTMLInputElement).focus();
    send({ t: "funil-card:validate", id: "v1" });
    expect((await next("funil-card:validated")).msg).toMatchObject({ ok: false, fields: ["cardNumber", "expiry"] });
    expect(doc.activeElement?.id).toBe("cardNumber");
  });

  test("ponta a ponta (controlador do app + iframe): telefone recusado, corrigido, pedido novo paga sem mexer no cartão", async () => {
    const { fill, send, posted, calls, parent } = setup({
      responses: [
        Response.json({ error: "invalid_input", message: "Confira o número de WhatsApp", fields: [["customer", "phone"]] }, { status: 400 }),
        Response.json({ status: "approved" }),
      ],
    });
    // O controlador do app fala com o formulário montado: o que ele posta vira `message` no iframe (vindo do pai), e
    // o que o iframe posta ao pai é entregue ao controlador com a origem do cartão e a janela do iframe.
    const CARD = "https://pagar.example";
    const frameWin = { iframe: true };
    let seq = 0;
    const ctrl = createCardFrameController({
      origin: CARD,
      getWindow: () => frameWin,
      post: (m: ParentMsg) => send(m, SHOP, parent),
      setTimer: () => () => {}, // prazos não entram aqui: o iframe sempre responde
      newId: () => `m-${++seq}`,
      onStatus: () => {},
      onHeight: () => {},
    });
    // Daqui em diante, cada mensagem do iframe ao pai chega também ao controlador (como o `message` do navegador).
    const original = parent.postMessage;
    parent.postMessage = (msg: FrameMsg, origin: string) => {
      original(msg, origin);
      queueMicrotask(() => ctrl.handle({ origin: CARD, source: frameWin, data: msg }));
    };
    try {
      ctrl.setConfig({ totalCents: 990, maxInstallments: 1 });
      ctrl.start();
      // O `ready` da montagem saiu antes do gancho: entrega o que já foi postado.
      for (const p of [...posted]) ctrl.handle({ origin: CARD, source: frameWin, data: p.msg });
      expect(ctrl.status).toBe("ready");
      fill();
      let created = 0;
      const run = (order: CardOrder | null, sig: string) =>
        payWithFrame({
          order,
          sig,
          now: () => 0,
          start: async () => ({ ok: true as const, publicId: `ped-${++created}`, cardTicket: ticketFor(created) }),
          renew: async () => ({ ok: false as const, message: "x", definitive: true }),
          pay: (a) => ctrl.pay({ ...a, buyerCpf: "52998224725" }),
        });
      const first = await run(null, "telefone-errado");
      expect(first.outcome).toEqual({ kind: "failed", message: "Confira o número de WhatsApp", marks: ["phone"] });
      expect(first.order).toBeNull();
      // O comprador corrige o WhatsApp no app (nenhum gesto no iframe): pedido novo, o mesmo cartão paga.
      const second = await run(first.order, "telefone-certo");
      expect(second.outcome).toEqual({ kind: "go", publicId: "ped-2" });
      expect(calls.map((c) => c.body.orderPublicId)).toEqual(["ped-1", "ped-2"]);
    } finally {
      ctrl.dispose();
    }
  });

  test("página sem storeId no cfg: não envia o cartão", async () => {
    const { fill, pay, next, calls } = setup({ storeId: null });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", message: GENERIC });
    expect(calls).toHaveLength(0);
  });

  test("aberto fora de moldura (window.parent é a própria janela): não aceita mensagem nenhuma", async () => {
    const { fill, send, posted, w, calls } = setup({ topLevel: true });
    fill();
    const self = w as unknown;
    send({ t: "funil-card:validate", id: "v1" }, SHOP, self);
    send({ t: "funil-card:pay", id: "p1", orderPublicId: "ped-1", ticket: "b", buyerCpf: "52998224725" }, SHOP, self);
    await Promise.resolve();
    expect(posted.filter((p) => p.msg.t === "funil-card:validated" || p.msg.t === "funil-card:result")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("rede cai: result de erro com a mensagem de sempre; a próxima tentativa com os mesmos dados reaproveita a chave", async () => {
    const { fill, pay, next, calls, type } = setup({ responses: [new TypeError("Failed to fetch"), Response.json({ status: "approved" }), Response.json({ status: "approved" })] });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", message: NETWORK_MESSAGE });
    expect(NETWORK_MESSAGE).toBe("Sem conexão. Confira a internet e toque em pagar de novo.");
    pay("p2");
    expect((await next("funil-card:result")).msg.t).toBe("funil-card:result");
    expect(calls.map((c) => c.body.idempotencyKey)).toEqual(["key-1", "key-1"]);
    // depois de uma resposta, a chave não volta: nova tentativa, chave nova (mesmo com os mesmos dados)
    type("cvv", "123");
    pay("p3");
    await next("funil-card:result");
    expect(calls[2]!.body.idempotencyKey).toBe("key-2");
  });

  test("rede cai e o comprador troca o CVV: chave nova", async () => {
    const { fill, pay, next, calls, type } = setup({ responses: [new TypeError("x"), Response.json({ status: "approved" })] });
    fill();
    pay("p1");
    await next("funil-card:result");
    type("cvv", "999");
    pay("p2");
    await next("funil-card:result");
    expect(calls.map((c) => c.body.idempotencyKey)).toEqual(["key-1", "key-2"]);
  });

  test("pay com campo inválido: não chama a API e devolve os campos", async () => {
    const { fill, pay, next, calls } = setup();
    fill({ cardNumber: "4111 1111 1111 1112", cep: "1" });
    pay("p1");
    expect((await next("funil-card:result")).msg).toEqual({
      t: "funil-card:result",
      id: "p1",
      status: "error",
      message: "Confira os 2 campos marcados para continuar.",
      fields: [["cardNumber"], ["cep"]],
    });
    expect(calls).toHaveLength(0);
  });

  test("titular é outra pessoa: CPF do titular do campo", async () => {
    const { fill, pay, next, calls, doc, w } = setup();
    const box = doc.getElementById("holderOther") as unknown as HTMLInputElement;
    expect((doc.getElementById("holderCpf")!.closest(".field") as unknown as HTMLElement).hidden).toBe(true);
    box.checked = true;
    box.dispatchEvent(new w.Event("change", { bubbles: true }) as unknown as Event);
    expect((doc.getElementById("holderCpf")!.closest(".field") as unknown as HTMLElement).hidden).toBe(false);
    fill({ holderCpf: "111.444.777-35" });
    pay("p1");
    await next("funil-card:result");
    expect((calls[0]!.body.holder as { cpf: string }).cpf).toBe("11144477735");
  });

  test("400 em holder.cpf: titular desligado devolve `cpf` (o app marca); ligado, marca o CPF do titular no iframe", async () => {
    const bad = () => Response.json({ error: "invalid_input", message: "Dados de pagamento inválidos", fields: [["holder", "cpf"]] }, { status: 400 });
    const { fill, pay, next, doc, w } = setup({ responses: [bad(), bad()] });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", message: "Confira o campo marcado para continuar.", fields: [["cpf"]] });
    expect(doc.getElementById("holderCpf-msg")?.textContent ?? "").toBe("");
    const box = doc.getElementById("holderOther") as unknown as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new w.Event("change", { bubbles: true }) as unknown as Event);
    fill({ holderCpf: "111.444.777-35" });
    pay("p2");
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p2", fields: [["holderCpf"]] });
    expect(doc.getElementById("holderCpf-msg")!.textContent).toBe("Confira este campo.");
  });

  test("400 com campos: marca os campos no iframe e devolve os nomes; 403 de bilhete: ticketExpired", async () => {
    const { fill, pay, next, doc } = setup({
      responses: [
        Response.json({ error: "invalid_input", message: "Dados de pagamento inválidos", fields: [["holder", "postalCode"], ["card", "expiryYear"]] }, { status: 400 }),
        Response.json({ error: "ticket", ticketExpired: true }, { status: 403 }),
      ],
    });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toEqual({
      t: "funil-card:result",
      id: "p1",
      status: "error",
      message: "Confira os 2 campos marcados para continuar.",
      fields: [["cep"], ["expiry"]],
    });
    expect(doc.getElementById("cep-msg")!.textContent).toBe("Confira este campo.");
    expect(doc.getElementById("expiry-msg")!.textContent).toBe("Cartão vencido ou validade inválida.");
    pay("p2");
    const r = (await next("funil-card:result")).msg;
    expect(r).toMatchObject({ id: "p2", status: "error", ticketExpired: true });
  });

  test("depois da resposta os campos continuam na tela para corrigir", async () => {
    const { fill, pay, next, input } = setup({ responses: [Response.json({ status: "declined" })] });
    fill();
    pay("p1");
    await next("funil-card:result");
    expect(input("cardNumber").value).toBe("4111 1111 1111 1111");
    expect(input("cvv").value).toBe("123");
  });

  test("captcha: o iframe só repassa o pedido de captcha ao checkout; nenhum script de terceiro é carregado", async () => {
    const t = setup({ responses: [Response.json({ captcha: true, message: "Confirme que você não é um robô." }, { status: 429 })] });
    t.fill();
    t.pay("p1");
    expect((await t.next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", captcha: true, message: "Confirme que você não é um robô." });
    expect(t.doc.querySelector("script[src]")).toBeNull();
    expect(t.doc.querySelector(".turnstile")).toBeNull();
    expect((t.w as unknown as { turnstile?: unknown }).turnstile).toBeUndefined();
  });

  test("token do Turnstile resolvido no checkout: vai no corpo do POST só no pay que o trouxe", async () => {
    const t = setup({ responses: [Response.json({ captcha: true, message: "m" }, { status: 429 }), Response.json({ status: "approved" })] });
    t.fill();
    t.pay("p1");
    await t.next("funil-card:result");
    expect(t.calls[0]!.body.turnstileToken).toBeUndefined();
    t.pay("p2", { turnstileToken: "tok-do-checkout" });
    expect((await t.next("funil-card:result")).msg).toMatchObject({ id: "p2", status: "approved" });
    expect(t.calls[1]!.body.turnstileToken).toBe("tok-do-checkout");
    t.type("cvv", "321"); // outro pedido exige gesto do comprador depois de um approved
    t.pay("p3", { orderPublicId: "ped-2" });
    await t.next("funil-card:result");
    expect(t.calls[2]!.body.turnstileToken).toBeUndefined();
  });

  describe("navegador sem AbortSignal.timeout (iOS 15)", () => {
    const sig = AbortSignal as unknown as { timeout?: unknown };
    const without = async (fn: () => Promise<void>) => {
      const original = sig.timeout;
      delete sig.timeout;
      try {
        await fn();
      } finally {
        sig.timeout = original;
      }
    };

    test("o prazo continua valendo: estoura com 'Sem conexão…' e a mesma chave na próxima", () =>
      without(async () => {
        expect(sig.timeout).toBeUndefined();
        const { fill, pay, next, calls } = setup({ payTimeoutMs: 5, responses: [new Promise<Response>(() => {}), Response.json({ status: "approved" })] });
        fill();
        pay("p1");
        expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", message: NETWORK_MESSAGE });
        pay("p2");
        expect((await next("funil-card:result")).msg).toMatchObject({ id: "p2", status: "approved" });
        expect(calls.map((c) => c.body.idempotencyKey)).toEqual(["key-1", "key-1"]);
      }));

    test("pagamento normal segue funcionando", () =>
      without(async () => {
        const { fill, pay, next, calls } = setup({ responses: [Response.json({ status: "approved" })] });
        fill();
        pay("p1");
        expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "approved" });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
      }));
  });

  test("bilhete com total ou parcelas diferentes do que o checkout mostrou: recusa sem chamar a API", async () => {
    const { fill, pay, next, calls, send } = setup({ responses: [Response.json({ status: "approved" })] });
    fill();
    pay("p1", { ticket: ticketFor(1, 2700, 1) }); // pedido de R$ 27,00 com o checkout mostrando R$ 9,90
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", message: GENERIC });
    pay("p2", { ticket: ticketFor(1, 990, 12) });
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p2", status: "error", message: GENERIC });
    pay("p3", { ticket: "nao-e-bilhete" });
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p3", status: "error", message: GENERIC });
    expect(calls).toHaveLength(0);
    // Checkout atualiza o total (bump ligado): o bilhete do pedido novo bate e passa.
    send({ t: "funil-card:config", totalCents: 2700, maxInstallments: 1 });
    pay("p4", { ticket: ticketFor(2, 2700, 1) });
    expect((await next("funil-card:result")).msg).toMatchObject({ id: "p4", status: "approved" });
    expect(calls).toHaveLength(1);
  });

  test("sem config do checkout (total que o comprador viu desconhecido): não paga", async () => {
    const { fill, pay, next, calls } = setup({ config: false });
    fill();
    pay("p1");
    expect((await next("funil-card:result")).msg).toEqual({ t: "funil-card:result", id: "p1", status: "error", message: GENERIC });
    expect(calls).toHaveLength(0);
  });

  test("config: parcelas com os rótulos do checkout; escondidas com 1x", () => {
    const { send, doc } = setup();
    const sel = doc.getElementById("installments") as unknown as HTMLSelectElement;
    const field = sel.closest(".field") as unknown as HTMLElement;
    expect(field.hidden).toBe(true);
    send({ t: "funil-card:config", totalCents: 2700, maxInstallments: 3 });
    expect(field.hidden).toBe(false);
    expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([
      ["1", "1x de R$ 27,00 sem juros"],
      ["2", "2x (total R$ 27,00)"],
      ["3", "3x (total R$ 27,00)"],
    ]);
    sel.value = "3";
    sel.dispatchEvent(new (doc.defaultView!.Event)("change", { bubbles: true }) as unknown as Event);
    send({ t: "funil-card:config", totalCents: 3700, maxInstallments: 3 });
    expect(sel.value).toBe("3");
    expect(sel.options[2]!.textContent).toBe("3x (total R$ 37,00)");
    send({ t: "funil-card:config", totalCents: 3700, maxInstallments: 2 });
    expect(sel.value).toBe("1");
  });
});
