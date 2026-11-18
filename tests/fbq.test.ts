import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { FBEVENTS_SRC, initPixel, resetPixelForTests, trackPixel } from "@/lib/tracking/fbq";

// O Pixel roda na página onde o comprador digita cartão/CPF: nada de coleta automática do Meta (autoConfig false
// ANTES do init) e eventos só com os parâmetros que o app passa.
type Win = Window & { fbq?: { queue: unknown[][] } };
let w: Win | null = null;
afterEach(async () => {
  resetPixelForTests();
  await w?.happyDOM.close();
  w = null;
});

const open = () => {
  w = new Window({ url: "https://loja.example/c/oferta", settings: { disableJavaScriptFileLoading: true } as never }) as unknown as Win;
  return w;
};
const calls = (win: Win) => (win.fbq?.queue ?? []).map((a) => Array.from(a as ArrayLike<unknown>));

test("autoConfig false antes do init; depois PageView; script do Meta com src oficial", () => {
  const win = open();
  expect(initPixel("1234567890", win as unknown as globalThis.Window)).toBe(true);
  expect(calls(win)).toEqual([
    ["set", "autoConfig", false, "1234567890"],
    ["init", "1234567890"],
    ["track", "PageView"],
  ]);
  const scripts = [...win.document.querySelectorAll("script")].map((s) => s.getAttribute("src"));
  expect(scripts).toEqual([FBEVENTS_SRC]);
});

test("eventos levam só os parâmetros dados (sem dados do formulário) e eventID", () => {
  const win = open();
  win.document.body.innerHTML = '<input id="cardNumber" value="4444444444444444"><input id="cpf" value="52998224725">';
  initPixel("1234567890", win as unknown as globalThis.Window);
  trackPixel("AddPaymentInfo", { currency: "BRL", value: 27 }, undefined, win as unknown as globalThis.Window);
  trackPixel("Purchase", { currency: "BRL", value: 27 }, "purchase:abc", win as unknown as globalThis.Window);
  trackPixel("Purchase", { currency: "BRL", value: 27 }, "purchase:abc", win as unknown as globalThis.Window); // repetido: ignorado
  const tracked = calls(win).filter((c) => c[0] === "track" && c[1] !== "PageView");
  expect(tracked).toEqual([
    ["track", "AddPaymentInfo", { currency: "BRL", value: 27 }],
    ["track", "Purchase", { currency: "BRL", value: 27 }, { eventID: "purchase:abc" }],
  ]);
  expect(JSON.stringify(calls(win))).not.toMatch(/4444|52998224725/);
});

test("Pixel ID inválido: nada carrega", () => {
  const win = open();
  expect(initPixel("12ab", win as unknown as globalThis.Window)).toBe(false);
  expect(win.fbq).toBeUndefined();
  expect(win.document.querySelectorAll("script")).toHaveLength(0);
});
