"use client";

// Controles das tabelas do painel (pedidos, produtos): busca dentro do cartão, filtros no cabeçalho das colunas (como
// no Excel, com o menu do Arc, marcando várias opções) e o botão de maximizar a tabela. Os filtros ficam na URL
// (?status=paid&status=pending&method=..., ?q=), aplicados a cada clique.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  CircleCheck,
  CircleMinus,
  Clock,
  CreditCard,
  ListFilter,
  Maximize2,
  Minimize2,
  QrCode,
  RotateCcw,
  Search,
  ShieldAlert,
  TimerOff,
  CircleX,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { DropdownMenu } from "@/components/arc/dropdown-menu/dropdown-menu";
import s from "./panel.module.css";

/** Ícone de cada opção de filtro (status e método dos pedidos, uso dos produtos). */
const OPTION_ICONS: Record<string, LucideIcon> = {
  "em-uso": CircleCheck,
  "sem-oferta": CircleMinus,
  pending: Clock,
  paid: CircleCheck,
  expired: TimerOff,
  declined: CircleX,
  refunded: RotateCcw,
  disputed: ShieldAlert,
  pix_manual: QrCode,
  pix_asaas: Zap,
  card_asaas: CreditCard,
};

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
  icon?: string;
}

/** Cabeçalho de coluna com filtro de várias opções. Marca e desmarca com o menu aberto; aplica ao fechar. */
export function ColumnFilter({ title, param, values, options }: { title: string; param: string; values: string[]; options: FilterOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [picked, setPicked] = useState<string[]>(values);
  const [seen, setSeen] = useState(values.join(","));
  if (values.join(",") !== seen) {
    setSeen(values.join(","));
    setPicked(values);
  }
  const [pending, start] = useTransition();
  // Cada clique já filtra (o menu continua aberto para marcar mais opções).
  const toggle = (v: string) => {
    const next = picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v];
    setPicked(next);
    apply(next);
  };
  const apply = (next: string[]) => {
    const p = new URLSearchParams(params.toString());
    p.delete("pagina");
    p.delete(param);
    for (const v of options.map((o) => o.value).filter((v) => next.includes(v))) p.append(param, v);
    const str = p.toString();
    start(() => router.replace(`${pathname}${str ? `?${str}` : ""}`, { scroll: false }));
  };
  const active = values.length > 0;
  return (
    <DropdownMenu
      label={title}
      align="start"
      triggerClassName={s.thFilter}
      triggerLabel={active ? `${title}: ${values.length} ${values.length === 1 ? "filtro" : "filtros"}. Mudar` : `Filtrar por ${title.toLowerCase()}`}
      trigger={
        <>
          {title}
          {picked.length > 0 ? <span className={s.thCount}>{picked.length}</span> : null}
          {pending ? <span className={s.thPending} aria-hidden="true" /> : null}
          <ListFilter size={14} strokeWidth={2} aria-hidden="true" data-on={active ? true : undefined} />
        </>
      }
      items={[
        ...options.map((o) => {
          const Icon = o.icon ? OPTION_ICONS[o.icon] : undefined;
          return {
            label: o.label,
            hint: o.count,
            checked: picked.includes(o.value),
            keepOpen: true,
            icon: Icon ? <Icon size={15} strokeWidth={1.75} /> : undefined,
            onSelect: () => toggle(o.value),
          };
        }),
        {
          label: "Limpar filtro",
          separatorBefore: true,
          disabled: picked.length === 0,
          keepOpen: true,
          onSelect: () => {
            setPicked([]);
            apply([]);
          },
        },
      ]}
    />
  );
}

/** Cartão da tabela com a barra de cima (busca, total e maximizar). Maximizada, ocupa a tela; Esc volta. */
export function TableShell({
  q,
  keep,
  placeholder,
  searchLabel,
  count,
  children,
}: {
  q?: string;
  /** Filtros das colunas que a busca mantém, ex.: { status: ["paid"], method: [] }. */
  keep: Record<string, string[]>;
  placeholder: string;
  searchLabel: string;
  /** Texto do total ao lado da busca, ex.: "12 pedidos com estes filtros". */
  count: string;
  children: ReactNode;
}) {
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
          {Object.entries(keep).flatMap(([name, values]) => values.map((v) => <input key={`${name}-${v}`} type="hidden" name={name} value={v} />))}
          <Search size={15} strokeWidth={2} aria-hidden="true" />
          <input name="q" defaultValue={q} placeholder={placeholder} maxLength={100} aria-label={searchLabel} />
        </form>
        <span className={s.tableCount}>{count}</span>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setMax((v) => !v)}
          aria-label={max ? "Voltar ao tamanho normal" : "Maximizar tabela"}
          title={max ? "Voltar (Esc)" : "Maximizar"}
        >
          {max ? <Minimize2 size={16} strokeWidth={1.75} /> : <Maximize2 size={16} strokeWidth={1.75} />}
        </button>
      </div>
      {children}
    </section>
  );
}
