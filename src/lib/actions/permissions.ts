export type Role = "owner" | "admin" | "support" | "traffic";

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
  | "metrics.read"
  | "connections.read"
  | "connections.write"
  | "tracking.write"
  | "team.manage"
  /** A própria conta (trocar a senha): todos os papéis. */
  | "account.self";

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
  "metrics.read",
  "connections.read",
  "connections.write",
  "tracking.write",
  "team.manage",
  "account.self",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "team.manage" && p !== "connections.write"),
  support: ["orders.read", "orders.resend", "products.read", "offers.read", "account.self"],
  // tracking.write: pixel próprio das ofertas (validado contra o token salvo pelo dono) e teste da conexão Meta.
  // Token/Pixel da loja (connections.saveMeta) exige connections.write: só o dono.
  traffic: ["metrics.read", "offers.read", "products.read", "connections.read", "tracking.write", "account.self"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
