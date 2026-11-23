"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ArrowUp } from "lucide-react";
import { animate, motion, useMotionValue, useReducedMotion, type Transition } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./sortable-data-table.module.css";

export type SortDirection = "asc" | "desc";
export type SortState = { key: string; direction: SortDirection };

export type DataColumn<T> = {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (value: unknown, row: T) => ReactNode;
  /** Right-aligns the column with tabular numerals. Detected when every value is a number (datas em milissegundos: passe `false`). */
  numeric?: boolean;
  /** Fixed width such as 120 or "20%". Other columns are measured once and held, so sorting never reflows them. */
  width?: number | string;
  /** Painel: controle extra no cabeçalho, ao lado do título (o filtro de várias opções da coluna). */
  filter?: ReactNode;
};

export type SortableDataTableProps<T extends Record<string, unknown>> = {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: keyof T | ((row: T) => string);
  caption?: string;
  emptyMessage?: string;
  /** Sort applied on the first render. */
  defaultSort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Painel: false desliga a ordenação de todas as colunas. Use quando as linhas são só uma página de uma lista paginada no servidor: ordenar no navegador reordenaria só a página aberta. */
  sorting?: boolean;
  /** Painel: destaque de uma linha (ex.: Pix manual esperando conferência). Vira `data-tone` na linha. */
  rowTone?: (row: T) => "warning" | undefined;
};

const collator = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
const isEmpty = (value: unknown) => value == null || value === "";
const comparable = (value: unknown) => value instanceof Date ? value.getTime() : value;
const blur = (px: number) => `blur(${px}px)`;
const enter: Transition = { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] };
const instant: Transition = { duration: motionTokens.duration.instant };

/** The arrow fades in where a column becomes sorted and flips on a spring when the direction changes. */
function SortGlyph({ active, descending, reduced }: { active: boolean; descending: boolean; reduced: boolean }) {
  const rotate = useMotionValue(descending ? 180 : 0);
  const seen = useRef({ active, hiddenAt: -Infinity });
  useLayoutEffect(() => {
    const state = seen.current;
    if (active) {
      // Turn only while the arrow is visible; a freshly shown arrow starts pointing the right way.
      const visible = state.active || performance.now() - state.hiddenAt < 160;
      if (visible && !reduced) animate(rotate, descending ? 180 : 0, motionTokens.spring.snappy);
      else rotate.jump(descending ? 180 : 0);
    } else if (state.active) state.hiddenAt = performance.now();
    state.active = active;
  }, [active, descending, reduced, rotate]);
  const transition: Transition = reduced ? instant : active ? { opacity: enter, filter: enter, scale: motionTokens.spring.snappy } : { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] };
  return <span className={styles.sortIcon} aria-hidden="true">
    <ArrowUp className={styles.sortHint} size={16} strokeWidth={1.75} />
    <motion.span className={styles.sortArrow} style={{ rotate }} initial={false} animate={active ? { opacity: 1, scale: 1, filter: blur(0) } : { opacity: 0, scale: .6, filter: blur(motionTokens.blur.subtle) }} transition={transition}><ArrowUp size={16} strokeWidth={1.75} /></motion.span>
  </span>;
}

export function SortableDataTable<T extends Record<string, unknown>>({ rows, columns, rowKey, caption = "Tabela", emptyMessage = "Nada para mostrar", defaultSort, onSortChange, sorting = true, rowTone }: SortableDataTableProps<T>) {
  const reduced = useReducedMotion() ?? false;
  const tableRef = useRef<HTMLTableElement>(null);
  const [chosenSort, setSort] = useState<SortState | null>(defaultSort ?? null);
  const sort = sorting ? chosenSort : null;
  const [announcement, setAnnouncement] = useState("");

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    return rows.map((row, index) => ({ row, index })).sort((a, b) => {
      const left = comparable(a.row[sort.key]);
      const right = comparable(b.row[sort.key]);
      // Empty values stay at the bottom in both directions.
      if (isEmpty(left) || isEmpty(right)) return isEmpty(left) === isEmpty(right) ? a.index - b.index : isEmpty(left) ? 1 : -1;
      const result = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
      return (sort.direction === "asc" ? result : -result) || a.index - b.index;
    }).map(entry => entry.row);
  }, [rows, sort]);

  const numeric = useMemo(() => new Set(columns.filter(column => column.numeric ?? (rows.some(row => typeof row[column.key] === "number") && rows.every(row => typeof row[column.key] === "number" || isEmpty(row[column.key])))).map(column => column.key)), [columns, rows]);
  const getRowKey = (row: T) => String(typeof rowKey === "function" ? rowKey(row) : row[rowKey]);
  const keys = sortedRows.map(getRowKey);
  const order = keys.join("\u0000");

  // Measure the natural column widths once, then hold them with a fixed layout so nothing reflows while rows move.
  const signature = columns.map(column => column.key).join("\u0000");
  const [locked, setLocked] = useState<{ signature: string; widths: Record<string, number> } | null>(null);
  const widths = locked?.signature === signature ? locked.widths : null;
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table || widths) return;
    const measure = () => {
      const total = table.getBoundingClientRect().width;
      if (!total || getComputedStyle(table).display !== "table") return false;
      const next: Record<string, number> = {};
      table.querySelectorAll<HTMLElement>("thead th[data-key]").forEach(cell => { next[cell.dataset.key ?? ""] = cell.getBoundingClientRect().width / total * 100; });
      setLocked({ signature, widths: next });
      return true;
    };
    if (measure()) return;
    const observer = new ResizeObserver(() => { if (measure()) observer.disconnect(); });
    observer.observe(table);
    return () => observer.disconnect();
  }, [signature, widths]);

  // A still tint under the sorted column fills the gaps that open while rows pass each other.
  const [band, setBand] = useState<{ left: number; width: number } | null>(null);
  const seenSort = useRef(false);
  useLayoutEffect(() => {
    const table = tableRef.current;
    const key = sort?.key;
    const update = () => {
      const cell = key ? table?.querySelector<HTMLElement>(`thead th[data-key="${CSS.escape(key)}"]`) : null;
      setBand(current => !cell ? null : current?.left === cell.offsetLeft && current.width === cell.offsetWidth ? current : { left: cell.offsetLeft, width: cell.offsetWidth });
    };
    update();
    if (!table || !key) return;
    // On a phone the header is a scrolling strip of sort controls; keep the active one in view.
    const cell = table.querySelector<HTMLElement>(`thead th[data-key="${CSS.escape(key)}"]`);
    const strip = cell?.parentElement;
    if (cell && strip && strip.scrollWidth > strip.clientWidth && getComputedStyle(table).display !== "table") {
      const bounds = strip.getBoundingClientRect(), target = cell.getBoundingClientRect(), inset = 8;
      const start = Math.max(bounds.left, strip.querySelector("th:not([data-key])")?.getBoundingClientRect().right ?? bounds.left) + inset;
      const shift = target.right > bounds.right - inset ? target.right - bounds.right + inset : target.left < start ? target.left - start : 0;
      if (shift) strip.scrollTo({ left: strip.scrollLeft + shift, behavior: reduced || !seenSort.current ? "auto" : "smooth" });
    }
    seenSort.current = true;
    const observer = new ResizeObserver(update);
    observer.observe(table);
    return () => observer.disconnect();
  }, [reduced, sort?.key, widths]);

  function sortBy(column: DataColumn<T>) {
    const next: SortState = { key: column.key, direction: sort?.key === column.key && sort.direction === "asc" ? "desc" : "asc" };
    setSort(next);
    onSortChange?.(next);
    setAnnouncement(`Ordenado por ${column.label}, ${next.direction === "asc" ? "crescente" : "decrescente"}`);
  }

  /** Arrows walk the header sort controls. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.dataset.nav !== "head") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-nav="head"]')];
    const index = items.indexOf(target);
    const steps: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: items.length - 1 };
    const step = steps[event.key];
    const next = step === undefined ? undefined : items[step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  return <div className={styles.wrapper} onKeyDown={onKeyDown}>
    <div className={styles.scroller}>
      {band ? <span className={styles.band} style={{ left: band.left, width: band.width }} aria-hidden="true" /> : null}
      <table ref={tableRef} role="table" className={styles.table} data-fixed={widths ? "" : undefined}>
        <caption>{caption}</caption>
        <colgroup>
          {columns.map((column, index) => <col key={column.key} style={{ width: column.width !== undefined ? (typeof column.width === "number" ? `${column.width}px` : column.width) : widths && index > 0 ? `${widths[column.key]}%` : undefined }} />)}
        </colgroup>
        <thead role="rowgroup"><tr role="row">
          {columns.map((column, index) => {
            const active = sort?.key === column.key;
            const sortable = sorting && column.sortable !== false;
            return <th key={column.key} scope="col" role="columnheader" data-key={column.key} data-primary={index === 0 || undefined} data-sorted={active || undefined} data-numeric={numeric.has(column.key) || undefined} data-sortable={sortable || undefined} aria-sort={!sortable ? undefined : active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
              <span className={column.filter ? styles.headWithFilter : styles.headPlain}>
              {sortable ? <button className={styles.sortButton} type="button" data-nav="head" onClick={() => sortBy(column)} aria-label={`Ordenar por ${column.label}${active ? `, agora ${sort.direction === "asc" ? "crescente" : "decrescente"}` : ""}`}>
                <span className={styles.sortInner}><span>{column.label}</span><SortGlyph active={active} descending={active && sort.direction === "desc"} reduced={reduced} /></span>
              </button> : column.label}
              {column.filter ? <span className={styles.headFilter}>{column.filter}</span> : null}
              </span>
            </th>;
          })}
        </tr></thead>
        <tbody role="rowgroup">{sortedRows.length ? sortedRows.map((row, index) => {
          const key = keys[index]!;
          return <motion.tr key={key} role="row" layout={reduced ? false : "position"} layoutDependency={order} transition={motionTokens.spring.smooth} data-tone={rowTone?.(row)}>
            {columns.map((column, columnIndex) => <td key={column.key} role="cell" data-label={column.label} data-primary={columnIndex === 0 || undefined} data-sorted={sort?.key === column.key || undefined} data-numeric={numeric.has(column.key) || undefined}>{column.render ? column.render(row[column.key], row) : String(row[column.key] ?? "–")}</td>)}
          </motion.tr>;
        }) : <tr role="row"><td role="cell" className={styles.empty} colSpan={columns.length}>{emptyMessage}</td></tr>}</tbody>
      </table>
    </div>
    <p className={styles.srOnly} role="status">{announcement}</p>
  </div>;
}

export default SortableDataTable;
