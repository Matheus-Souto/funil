/**
 * `reader` e `integration` só existem para tokens (o `membership_role_check` não os aceita: usuário do painel nunca é
 * leitor nem integração). `integration` é a chave da API de integração da loja (`/api/integracao/v1/*`): não serve
 * para o MCP, e nenhum outro papel serve para a API.
 */
export type Role = "owner" | "admin" | "support" | "traffic" | "reader" | "integration";

export type Permission =
  | "products.read"
  | "products.write"
  | "offers.read"
  | "offers.write"
  | "orders.read"
  | "orders.release"
  | "orders.refund"
  | "orders.resend"
  | "orders.export"
  /** Relatório de vendas pagas sem dados do comprador (orders.paidReport): quem tem metrics.read ou orders.read. */
  | "orders.report"
  | "metrics.read"
  | "connections.read"
  | "connections.write"
  | "tracking.write"
  | "team.manage"
  /** A própria conta (trocar a senha): todos os papéis. */
  | "account.self"
  /** Fila de aprovação do MCP: criar um pedido e ler os próprios. Todos os papéis (o token pede com o papel dele). */
  | "approvals.request"
  /** Aprovar ou recusar pedidos da fila (sempre com a permissão da ação-alvo também). Nunca um token (TOKEN_DENIED). */
  | "approvals.decide"
  /** Contatos de quem não finalizou a compra (checkout_lead): dono, admin e suporte. Nunca um token (TOKEN_DENIED). */
  | "leads.read"
  | "leads.write"
  /** API de integração de apps (`/api/integracao/v1/*`): só o papel `integration`, fora de ALL e do MCP. */
  | "integration.use";

const ALL: Permission[] = [
  "products.read",
  "products.write",
  "offers.read",
  "offers.write",
  "orders.read",
  "orders.release",
  "orders.refund",
  "orders.resend",
  "orders.export",
  "orders.report",
  "metrics.read",
  "connections.read",
  "connections.write",
  "tracking.write",
  "team.manage",
  "account.self",
  "approvals.request",
  "approvals.decide",
  "leads.read",
  "leads.write",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "team.manage" && p !== "connections.write"),
  support: ["orders.read", "orders.report", "orders.resend", "products.read", "offers.read", "account.self", "approvals.request", "approvals.decide", "leads.read", "leads.write"],
  // tracking.write: pixel próprio das ofertas (validado contra o token salvo pelo dono) e teste da conexão Meta.
  // Token/Pixel da loja (connections.saveMeta) exige connections.write: só o dono.
  traffic: [
    "metrics.read",
    "orders.report",
    "offers.read",
    "products.read",
    "connections.read",
    "tracking.write",
    "account.self",
    "approvals.request",
    "approvals.decide",
  ],
  // Só tokens MCP: catálogo, métricas e o relatório de vendas pagas. Sem pedidos (dados do comprador), conexões, escrita
  // nem a própria conta (um token não tem conta). `approvals.request`: pedir pela fila (a ação-alvo ainda exige a
  // permissão dela) e ler os próprios pedidos.
  reader: ["products.read", "offers.read", "metrics.read", "orders.report", "approvals.request"],
  // Só a chave da API de integração: nada do painel nem do MCP (nem a fila de aprovação).
  integration: ["integration.use"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
