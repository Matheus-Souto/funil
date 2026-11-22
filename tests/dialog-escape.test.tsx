// Esc em diálogos aninhados (src/components/arc/dialog/dialog.tsx), montados de verdade (React + Radix + motion no
// happy-dom): o 1º Esc fecha só a confirmação de cima; um Esc enquanto a confirmação ainda anima a saída vai para o
// diálogo de baixo (que é o que a pessoa vê); e um Esc que o Radix entrega ao diálogo de baixo logo depois de a
// confirmação abrir (a camada nova só entra no Radix num efeito depois da pintura) fecha a confirmação, não os dois.
// Regressão (E2E de Conexões no CI): o mesmo Esc fechava a confirmação e o modal de baixo.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState, type ReactNode } from "react";

const win = new Window({ url: "https://painel.example/admin" });
const KEYS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "PointerEvent", "MouseEvent", "FocusEvent", "CustomEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment", "SVGElement", "IntersectionObserver"] as const;
const saved = new Map<string, unknown>();

beforeAll(() => {
  for (const k of KEYS) {
    saved.set(k, (globalThis as Record<string, unknown>)[k]);
    const v = (win as unknown as Record<string, unknown>)[k];
    (globalThis as Record<string, unknown>)[k] = typeof v === "function" && /^[a-z]/.test(k) ? (v as (...a: unknown[]) => unknown).bind(win) : v;
  }
  // As demais classes do DOM (NodeFilter, HTMLDivElement…) que o Bun não tem.
  for (const k of Object.getOwnPropertyNames(win)) {
    if (/^[A-Z]/.test(k) && !(k in globalThis)) {
      saved.set(k, undefined);
      (globalThis as Record<string, unknown>)[k] = (win as unknown as Record<string, unknown>)[k];
    }
  }
  // Sem Web Animations: o motion anima por quadros (requestAnimationFrame), como num navegador sem WAAPI. A saída dura
  // de verdade, e é nessa janela que o 2º Esc acontece.
  delete (win.Element.prototype as { animate?: unknown }).animate;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  for (const [k, v] of saved) {
    if (v === undefined) delete (globalThis as Record<string, unknown>)[k];
    else (globalThis as Record<string, unknown>)[k] = v;
  }
  await win.happyDOM.close();
});

type Root = { render: (n: ReactNode) => void; unmount: () => void };
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** `layer: false`: a confirmação está aberta mas ainda sem camada no Radix (sem conteúdo montado), como na janela entre
 * abrir e o efeito do Radix rodar. */
async function mount({ layer = true }: { layer?: boolean } = {}) {
  const { createRoot } = await import("react-dom/client");
  const { Dialog, DialogContent } = await import("@/components/arc/dialog/dialog");
  const state = { outer: true, inner: true };
  function Harness() {
    const [outer, setOuter] = useState(true);
    const [inner, setInner] = useState(true);
    state.outer = outer;
    state.inner = inner;
    return (
      <Dialog open={outer} onOpenChange={setOuter}>
        <DialogContent title="Conexões">
          <p>formulário</p>
          <Dialog open={inner} onOpenChange={setInner}>
            {layer ? (
              <DialogContent title="Salvar esta chave Pix?">
                <p>confirmação</p>
              </DialogContent>
            ) : null}
          </Dialog>
        </DialogContent>
      </Dialog>
    );
  }
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el as unknown as HTMLElement) as Root;
  await act(async () => root!.render(<Harness />));
  return state;
}

const escape = async () => {
  await act(async () => {
    const target = (document.activeElement ?? document.body) as unknown as EventTarget;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
};

describe("Dialog: Esc com um diálogo aberto sobre outro", () => {
  test("o 1º Esc fecha só a confirmação de cima", async () => {
    const state = await mount();
    expect(state).toEqual({ outer: true, inner: true });
    await escape();
    expect(state).toEqual({ outer: true, inner: false });
  });

  test("Esc durante a saída da confirmação vai para o diálogo de baixo", async () => {
    const state = await mount();
    await escape();
    expect(state).toEqual({ outer: true, inner: false });
    // A confirmação ainda está no DOM (animando a saída) e segue como a camada de cima para o Radix.
    expect(document.body.textContent).toContain("confirmação");
    // O repasse só vale se a saída começou antes da tecla (`at < event.timeStamp`). O relógio do teste anda 1 ms à força,
    // em vez de esperar: o Event do happy-dom e o diálogo leem o mesmo `performance.now()`.
    const realNow = performance.now.bind(performance);
    performance.now = () => realNow() + 1;
    try {
      await escape();
    } finally {
      performance.now = realNow;
    }
    expect(state.outer).toBe(false);
  });

  test("Esc entregue ao diálogo de baixo com a confirmação aberta fecha só a confirmação", async () => {
    const state = await mount({ layer: false });
    await escape();
    expect(state).toEqual({ outer: true, inner: false });
    await escape();
    expect(state.outer).toBe(false);
  });
});
