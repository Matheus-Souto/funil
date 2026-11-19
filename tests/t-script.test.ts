import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

// public/t.js rodando num DOM de verdade (happy-dom), como na página de vendas externa.
const SRC = readFileSync(join(import.meta.dir, "..", "public", "t.js"), "utf8");
const CHECKOUT = "pay.loja.example";

type Win = Window & { localStorage: Storage; __err?: unknown };
const open: Win[] = [];
afterEach(async () => {
  for (const w of open.splice(0)) await w.happyDOM.close();
});

/** Abre `url`, monta os links, roda o t.js com data-checkout. `storage` simula visitas anteriores no mesmo navegador. */
function visit(url: string, links: string[], storage?: Record<string, string>, opts: { breakStorage?: boolean } = {}): Win {
  const w = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } as never }) as unknown as Win;
  open.push(w);
  if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  if (opts.breakStorage) {
    Object.defineProperty(w, "localStorage", {
      get() {
        throw new Error("SecurityError");
      },
    });
  }
  w.document.body.innerHTML = links.map((h, i) => `<a id="l${i}" href="${h}">x</a>`).join("");
  w.addEventListener("error", (e) => {
    w.__err = (e as unknown as { error: unknown }).error;
  });
  const s = w.document.createElement("script");
  s.setAttribute("data-checkout", CHECKOUT);
  s.textContent = SRC;
  w.document.body.appendChild(s);
  return w;
}
const href = (w: Win, i: number) => new URL(w.document.getElementById(`l${i}`)!.getAttribute("href")!);
const ft = (u: URL) => JSON.parse(Buffer.from(u.searchParams.get("ft")!, "base64url").toString("utf8")) as Record<string, string>;
const dump = (w: Win) => ({ funil_touch: w.localStorage.getItem("funil_touch")! });

describe("public/t.js", () => {
  test("tem menos de 3 KB e não usa cookies", () => {
    expect(Buffer.byteLength(SRC)).toBeLessThan(3072);
    expect(SRC).not.toContain("cookie");
  });

  test("decora só links do host do checkout com utm_*, fbclid, ref e ft", () => {
    const w = visit("https://vendas.example/?utm_source=ig&utm_campaign=natal&ref=joao&fbclid=abc&outro=1", [
      `https://${CHECKOUT}/c/mana?x=1`,
      "https://outro.example/c/mana",
      "/pagina-local",
      `https://${CHECKOUT}.evil.example/c/mana`,
    ]);
    expect(w.__err).toBeUndefined();
    const a = href(w, 0);
    expect(a.searchParams.get("x")).toBe("1");
    expect(a.searchParams.get("utm_source")).toBe("ig");
    expect(a.searchParams.get("utm_campaign")).toBe("natal");
    expect(a.searchParams.get("ref")).toBe("joao");
    expect(a.searchParams.get("fbclid")).toBe("abc");
    expect(a.searchParams.get("outro")).toBeNull();
    expect(ft(a)).toEqual({ utm_source: "ig", utm_campaign: "natal", ref: "joao", fbclid: "abc" });
    expect(href(w, 1).search).toBe("");
    expect(w.document.getElementById("l2")!.getAttribute("href")).toBe("/pagina-local");
    expect(href(w, 3).search).toBe("");
  });

  test("preserva o primeiro toque entre visitas; o último toque muda", () => {
    const v1 = visit("https://vendas.example/?utm_source=google&utm_campaign=busca", [`https://${CHECKOUT}/c/mana`]);
    const saved = dump(v1);
    const v2 = visit("https://vendas.example/?utm_source=ig&ref=joao", [`https://${CHECKOUT}/c/mana`], saved);
    const a = href(v2, 0);
    expect(a.searchParams.get("utm_source")).toBe("ig");
    expect(a.searchParams.get("utm_campaign")).toBeNull(); // último toque é só desta visita
    expect(a.searchParams.get("ref")).toBe("joao");
    expect(ft(a)).toEqual({ utm_source: "google", utm_campaign: "busca" });
    // Visita sem parâmetros: usa o último toque guardado.
    const v3 = visit("https://vendas.example/sobre", [`https://${CHECKOUT}/c/mana`], dump(v2));
    expect(href(v3, 0).searchParams.get("utm_source")).toBe("ig");
    expect(ft(href(v3, 0))).toEqual({ utm_source: "google", utm_campaign: "busca" });
  });

  test("não sobrescreve parâmetros que o link já tem", () => {
    const w = visit("https://vendas.example/?utm_source=ig", [`https://${CHECKOUT}/c/mana?utm_source=site`]);
    expect(href(w, 0).searchParams.get("utm_source")).toBe("site");
  });

  test("links criados depois são decorados no clique", () => {
    const w = visit("https://vendas.example/?utm_source=ig", []);
    const a = w.document.createElement("a");
    a.setAttribute("href", `https://${CHECKOUT}/c/mana`);
    a.addEventListener("click", (e) => e.preventDefault());
    w.document.body.appendChild(a);
    a.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
    expect(new URL(a.getAttribute("href")!).searchParams.get("utm_source")).toBe("ig");
  });

  test("sem localStorage (bloqueado) não lança e ainda decora com a visita atual", () => {
    const w = visit("https://vendas.example/?utm_source=ig", [`https://${CHECKOUT}/c/mana`], undefined, { breakStorage: true });
    expect(w.__err).toBeUndefined();
    expect(href(w, 0).searchParams.get("utm_source")).toBe("ig");
  });

  test("funil_touch corrompido não quebra", () => {
    const w = visit("https://vendas.example/?utm_source=ig", [`https://${CHECKOUT}/c/mana`], { funil_touch: "{nao json" });
    expect(w.__err).toBeUndefined();
    expect(ft(href(w, 0))).toEqual({ utm_source: "ig" });
  });
});
