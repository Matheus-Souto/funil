"use client";

// Controles da tabela de pedidos: busca dentro do cartão, filtros no cabeçalho das colunas (como no Excel, com o
// menu do Arc) e o botão de maximizar a tabela. Os filtros continuam na URL (?status=, ?method=, ?q=), como antes.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ListFilter, Maximize2, Minimize2, Search } from "lucide-react";
import { DropdownMenu } from "@/components/arc/dropdown-menu/dropdown-menu";
import s from "../../panel.module.css";

/** URL dos pedidos com um parâmetro trocado (e a paginação zerada). */
function useHref() {
  const params = useSearchParams();
  return (key: string, value: string | undefined) => {
    const p = new URLSearchParams(params.toString());
    p.delete("pagina");
    if (value) p.set(key, value);
    else p.delete(key);
    const str = p.toString();
    return `/admin/orders${str ? `?${str}` : ""}`;
  };
}

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

/** Cabeçalho de coluna com filtro: clicar abre as opções; a escolhida fica marcada e o ícone acende. */
export function ColumnFilter({ title, param, value, options }: { title: string; param: string; value?: string; options: FilterOption[] }) {
  const router = useRouter();
  const href = useHref();
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu
      label={title}
      align="start"
      triggerClassName={s.thFilter}
      triggerLabel={current ? `${title}: ${current.label}. Mudar filtro` : `Filtrar por ${title.toLowerCase()}`}
      trigger={
        <>
          {title}
          <ListFilter size={14} strokeWidth={2} aria-hidden="true" data-on={current ? true : undefined} />
        </>
      }
      items={[
        { label: "Todos", checked: !current, onSelect: () => router.push(href(param, undefined)) },
        ...options.map((o) => ({
          label: o.label,
          hint: o.count,
          checked: o.value === value,
          onSelect: () => router.push(href(param, o.value)),
        })),
      ]}
    />
  );
}

/** Cartão da tabela com a barra de cima (busca, total e maximizar). Maximizada, ocupa a tela; Esc volta. */
export function TableShell({ q, status, method, total, filtered, children }: { q?: string; status?: string; method?: string; total: number; filtered?: boolean; children: ReactNode }) {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!max) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMax(false);
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [max]);
  return (
    <section className={`${s.card} ${s.cardFlush} ${s.tableShell}`} data-max={max ? "true" : undefined}>
      <div className={s.tableBar}>
        <form method="get" role="search" className={s.tableSearch}>
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {method ? <input type="hidden" name="method" value={method} /> : null}
          <Search size={15} strokeWidth={2} aria-hidden="true" />
          <span className={s.srOnly}>Buscar pedidos</span>
          <input name="q" defaultValue={q} placeholder="Buscar por nome ou e-mail" maxLength={100} aria-label="Buscar pedidos" />
        </form>
        <span className={s.tableCount}>
          {total} {total === 1 ? "pedido" : "pedidos"}
          {filtered ? " com estes filtros" : ""}
        </span>
        <button type="button" className={s.iconBtn} onClick={() => setMax((v) => !v)} aria-label={max ? "Voltar ao tamanho normal" : "Maximizar tabela"} title={max ? "Voltar (Esc)" : "Maximizar"}>
          {max ? <Minimize2 size={16} strokeWidth={1.75} /> : <Maximize2 size={16} strokeWidth={1.75} />}
        </button>
      </div>
      {children}
    </section>
  );
}
