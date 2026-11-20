// Ordem dos itens de um pedido em toda leitura (entrega, e-mails, painel, CSV, página do pedido, Meta): principais
// antes do bump e, dentro do grupo, a posição do produto na oferta no momento da compra. Pedidos anteriores à coluna
// `position` têm tudo em 0 e ficam como antes (principal antes do bump); o id só desempata de forma estável.
import { asc, desc } from "drizzle-orm";
import { orderItem } from "@/lib/db/schema";

/** `desc(kind)`: "main" > "bump" em ordem alfabética, então o principal vem primeiro. */
export const itemOrder = [desc(orderItem.kind), asc(orderItem.position), asc(orderItem.id)] as const;

export type ItemGroup = { kind: "main" | "bump"; names: string[]; priceCents: number };

/**
 * Itens (já em `itemOrder`) agrupados em principal e bump: os nomes na ordem e o preço do grupo (soma dos itens). É o
 * que comprador e vendedor veem: o preço rateado de cada PDF (ex.: 334/333/333) é interno e nunca aparece sozinho.
 */
export function groupItems(items: { name: string; kind: string; priceCents: number }[]): ItemGroup[] {
  const group = (kind: "main" | "bump"): ItemGroup[] => {
    const xs = items.filter((i) => i.kind === kind);
    return xs.length === 0 ? [] : [{ kind, names: xs.map((i) => i.name), priceCents: xs.reduce((sum, i) => sum + i.priceCents, 0) }];
  };
  return [...group("main"), ...group("bump")];
}
