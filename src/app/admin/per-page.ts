// Tamanhos de página das tabelas do painel (o primeiro é o padrão) e a leitura de ?pagina= e ?por= da URL.
import { firstParam, type Param } from "@/lib/panel-params";

export const PER_PAGE_OPTIONS = [10, 25, 50, 100] as const;
export type PerPage = (typeof PER_PAGE_OPTIONS)[number];

/** ?por= válido (10, 25, 50 ou 100); qualquer outro valor vira o padrão da tabela (10, ou 50 em Pedidos). */
export function parsePerPage(p: Param, fallback: PerPage = PER_PAGE_OPTIONS[0]): PerPage {
  const n = Number.parseInt(firstParam(p) ?? "", 10);
  return (PER_PAGE_OPTIONS as readonly number[]).includes(n) ? (n as PerPage) : fallback;
}

/** Pedidos mantêm 50 por página como padrão (o de sempre: links antigos com ?pagina= mostram os mesmos pedidos). */
export const ORDERS_PER_PAGE: PerPage = 50;

/** ?pagina= válido (1 ou mais); limitado à última página quando o total é conhecido. */
export function parsePage(p: Param, total?: number, perPage?: number): number {
  const n = Number.parseInt(firstParam(p) ?? "1", 10);
  const page = Number.isFinite(n) && n >= 1 ? Math.min(n, 10_000) : 1;
  if (total === undefined || !perPage) return page;
  return Math.min(page, Math.max(1, Math.ceil(total / perPage)));
}
