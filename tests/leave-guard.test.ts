// Aviso de alterações não salvas (src/app/admin/leave-guard.tsx): quais cliques em link viram o diálogo "Sair sem salvar?".
import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { internalTarget } from "@/app/admin/leave-guard";

const win = new Window({ url: "https://painel.example/admin/offers/abc?x=1" });
afterAll(() => win.happyDOM.close());
const here = new URL("https://painel.example/admin/offers/abc?x=1");

function click(html: string, extra: Partial<MouseEvent> = {}) {
  win.document.body.innerHTML = html;
  const target = win.document.querySelector("[data-hit]") as unknown as Element;
  return internalTarget({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target, ...extra } as MouseEvent, here);
}

describe("internalTarget", () => {
  test("link do painel para outra tela (inclusive clique num ícone dentro do link)", () => {
    expect(click(`<a href="/admin/orders" data-hit>Pedidos</a>`)).toBe("/admin/orders");
    expect(click(`<a href="/admin/settings?aba=loja#x"><svg data-hit></svg></a>`)).toBe("/admin/settings?aba=loja#x");
    expect(click(`<a href="/admin/offers/abc" data-hit>mesma rota, outra busca</a>`)).toBe("/admin/offers/abc");
  });

  test("não intercepta: âncora na mesma tela, outro site, nova aba, download, teclas e botão do meio", () => {
    expect(click(`<a href="#preco" data-hit>âncora</a>`)).toBeNull();
    expect(click(`<a href="https://outro.example/" data-hit>fora</a>`)).toBeNull();
    expect(click(`<a href="/admin/orders" target="_blank" data-hit>nova aba</a>`)).toBeNull();
    expect(click(`<a href="/admin/file" download data-hit>baixar</a>`)).toBeNull();
    expect(click(`<a href="/admin/orders" data-hit>x</a>`, { metaKey: true })).toBeNull();
    expect(click(`<a href="/admin/orders" data-hit>x</a>`, { ctrlKey: true })).toBeNull();
    expect(click(`<a href="/admin/orders" data-hit>x</a>`, { button: 1 })).toBeNull();
    expect(click(`<a href="/admin/orders" data-hit>x</a>`, { defaultPrevented: true })).toBeNull();
    expect(click(`<button data-hit>não é link</button>`)).toBeNull();
  });
});
