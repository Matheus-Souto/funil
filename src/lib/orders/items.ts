// Ordem dos itens de um pedido em toda leitura (entrega, e-mails, painel, CSV, página do pedido, Meta): principais
// antes do bump e, dentro do grupo, a posição do produto na oferta no momento da compra. Pedidos anteriores à coluna
// `position` têm tudo em 0 e ficam como antes (principal antes do bump); o id só desempata de forma estável.
import { asc, desc } from "drizzle-orm";
import { orderItem } from "@/lib/db/schema";

/** `desc(kind)`: "main" > "bump" em ordem alfabética, então o principal vem primeiro. */
export const itemOrder = [desc(orderItem.kind), asc(orderItem.position), asc(orderItem.id)] as const;
