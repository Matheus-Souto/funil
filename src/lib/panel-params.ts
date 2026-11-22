// Parâmetros de URL das telas do painel. O Next entrega `string | string[]` quando a chave se repete
// (?q=a&q=b): sempre vale o primeiro valor, nunca um 500.
import { ORDER_METHODS, ORDER_STATUSES, type OrderMethod, type OrderStatus } from "@/lib/orders/labels";

export type Param = string | string[] | undefined;

export const firstParam = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Filtros do painel com vários valores: ?status=paid&status=pending (ou "paid,pending"); inválidos são ignorados. */
export function parseOrderMultiFilters(sp: { status?: Param; method?: Param; q?: Param; pagina?: Param }): {
  statuses: OrderStatus[];
  methods: OrderMethod[];
  q: string | undefined;
  page: number;
} {
  const all = (p: Param) => (p === undefined ? [] : (Array.isArray(p) ? p : [p]).flatMap((v) => v.split(",")).map((v) => v.trim()));
  const { q, page } = parseOrderFilters(sp);
  return {
    statuses: [...new Set(all(sp.status))].filter((v): v is OrderStatus => ORDER_STATUSES.includes(v as OrderStatus)),
    methods: [...new Set(all(sp.method))].filter((v): v is OrderMethod => ORDER_METHODS.includes(v as OrderMethod)),
    q,
    page,
  };
}

/** Filtros da lista de pedidos: status/método fora da lista são ignorados; página inválida vira 1. */
export function parseOrderFilters(sp: { status?: Param; method?: Param; q?: Param; pagina?: Param }): {
  status: OrderStatus | undefined;
  method: OrderMethod | undefined;
  q: string | undefined;
  page: number;
} {
  const status = firstParam(sp.status);
  const method = firstParam(sp.method);
  const q = firstParam(sp.q)?.trim().slice(0, 100);
  const page = Number.parseInt(firstParam(sp.pagina) ?? "1", 10);
  return {
    q: q || undefined,
    status: ORDER_STATUSES.includes(status as OrderStatus) ? (status as OrderStatus) : undefined,
    method: ORDER_METHODS.includes(method as OrderMethod) ? (method as OrderMethod) : undefined,
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
  };
}
