"use client";

// Controles da tabela de pedidos: busca dentro do cartão, filtros no cabeçalho das colunas (como no Excel, com o
// menu do Arc, marcando várias opções) e o botão de maximizar a tabela. Os filtros ficam na URL
// (?status=paid&status=pending&method=..., ?q=), aplicados a cada clique.
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  CircleCheck,
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
import s from "../../panel.module.css";

/** Ícone de cada opção de filtro (status e método). */
const OPTION_ICONS: Record<string, LucideIcon> = {
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
    start(() => router.replace(`/admin/orders${str ? `?${str}` : ""}`, { scroll: false }));
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
  statuses,
  methods,
  total,
  filtered,
  children,
}: {
  q?: string;
  statuses: string[];
  methods: string[];
  total: number;
  filtered?: boolean;
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
          {statuses.map((v) => (
            <input key={`s-${v}`} type="hidden" name="status" value={v} />
          ))}
          {methods.map((v) => (
            <input key={`m-${v}`} type="hidden" name="method" value={v} />
          ))}
          <Search size={15} strokeWidth={2} aria-hidden="true" />
          <input name="q" defaultValue={q} placeholder="Buscar por nome ou e-mail" maxLength={100} aria-label="Buscar pedidos" />
        </form>
        <span className={s.tableCount}>
          {total} {total === 1 ? "pedido" : "pedidos"}
          {filtered ? " com estes filtros" : ""}
        </span>
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
