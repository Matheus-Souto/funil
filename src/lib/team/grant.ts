// Quem pode dar qual papel e quando dar um papel pede a senha. Só lógica pura: vale no servidor (as ações) e no
// navegador (a página Equipe decide se mostra o campo de senha).
import { ROLE_PERMISSIONS, type Role } from "@/lib/actions/permissions";

/** O papel-alvo só tem permissões que o ator também tem. Vale ao convidar, trocar papel e remover. */
export function canGrant(actor: Role, target: Role): boolean {
  const has = new Set<string>(ROLE_PERMISSIONS[actor]);
  return ROLE_PERMISSIONS[target].every((p) => has.has(p));
}

/**
 * Dar o papel `to` a quem tem `from` (`null`: convite) pede a senha de quem dá quando é promoção a Dono ou
 * Administrador. Assim uma sessão roubada sozinha não cria um dono (que outro dono não remove) nem um administrador.
 * Rebaixar (deixar de ser dono, por exemplo) e trocar entre papéis sem esse poder não pedem.
 */
export function needsPassword(from: Role | null, to: Role): boolean {
  if (to !== "owner" && to !== "admin") return false;
  return from === null || (from !== to && canGrant(to, from));
}
