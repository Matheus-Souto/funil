"use client";

// Aviso de alterações não salvas ao sair da tela: fechar a aba, recarregar ou ir a outro site usam o aviso do navegador
// (beforeunload); um link do próprio painel (sidebar, "Voltar") abre um diálogo e só navega se a pessoa confirmar. O
// clique é interceptado na captura, antes do <Link> do Next.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import s from "./panel.module.css";
import { Dialog } from "./ui";

/** Link interno que trocaria de tela (não âncora na mesma página, nova aba, download nem tecla de modificação). */
export function internalTarget(e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented" | "target">, here: URL): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
  const url = new URL(a.getAttribute("href")!, here);
  // "//outro.site" (ex.: href "/.//outro.site") seria levado pelo router.push a outro domínio.
  if (url.origin !== here.origin || url.pathname.startsWith("//")) return null;
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Liga o aviso enquanto `active` (há alteração não salva). Devolve o diálogo, para a tela renderizar. */
export function useLeaveGuard(active: boolean, what = "As alterações ainda não foram salvas.") {
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    const click = (e: MouseEvent) => {
      const to = internalTarget(e, new URL(window.location.href));
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      setTarget(to);
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [active]);

  return (
    <Dialog
      open={target !== null}
      onClose={() => setTarget(null)}
      tone="danger"
      title="Sair sem salvar?"
      footer={
        <>
          <button type="button" className={s.btn} onClick={() => setTarget(null)} data-autofocus>
            Continuar editando
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.btnDanger}`}
            onClick={() => {
              const to = target;
              setTarget(null);
              if (to) router.push(to);
            }}
          >
            Sair sem salvar
          </button>
        </>
      }
    >
      <p>{what}</p>
    </Dialog>
  );
}
