"use client";

// Rodapé das tabelas do painel: "Mostrando 1–10 de 48", quantos por página (10, 25, 50, 100) e as páginas (Pagination
// do Arc). Página e tamanho ficam na URL (?pagina=2&por=25), então o servidor devolve só o pedaço pedido.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { DropdownMenu } from "@/components/arc/dropdown-menu/dropdown-menu";
import { Pagination } from "@/components/arc/pagination/pagination";
import { PER_PAGE_OPTIONS } from "./per-page";
import s from "./panel.module.css";

export function TablePager({ page, perPage, total, defaultPerPage = PER_PAGE_OPTIONS[0] }: { page: number; perPage: number; total: number; defaultPerPage?: number }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  const go = (next: { pagina?: number; por?: number }) => {
    const p = new URLSearchParams(params.toString());
    if (next.por !== undefined) {
      p.delete("pagina");
      if (next.por === defaultPerPage) p.delete("por");
      else p.set("por", String(next.por));
    }
    if (next.pagina !== undefined) {
      if (next.pagina <= 1) p.delete("pagina");
      else p.set("pagina", String(next.pagina));
    }
    const str = p.toString();
    start(() => router.push(`${path}${str ? `?${str}` : ""}`, { scroll: false }));
  };
  return (
    <div className={s.tableFoot} data-pending={pending ? "true" : undefined}>
      <span className={s.pagerInfo}>
        Mostrando {from}–{to} de {total}
      </span>
      <div className={s.pagerControls}>
        <DropdownMenu
          label={`${perPage} por página`}
          align="end"
          items={PER_PAGE_OPTIONS.map((n) => ({ label: `${n} por página`, checked: n === perPage, onSelect: () => n !== perPage && go({ por: n }) }))}
        />
        <Pagination page={page} pageCount={pageCount} onPageChange={(n) => go({ pagina: n })} label="Páginas" />
      </div>
    </div>
  );
}
