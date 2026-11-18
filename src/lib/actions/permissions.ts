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
  | "team.manage";

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
  "team.manage",
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "team.manage" && p !== "connections.write"),
  support: ["orders.read", "orders.resend", "products.read", "offers.read"],
  traffic: ["metrics.read", "offers.read", "products.read", "connections.read"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
