import type { HTMLAttributes } from "react";
import styles from "./avatar.module.css";

// Painel: só as iniciais. Nas telas que o usam o nome já está escrito ao lado, então o avatar é decorativo
// (aria-hidden) e o leitor de tela não repete o nome. Sem foto nem status: o painel não usa (e o ArcProvider, que
// trocava o <img>, saiu).
export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> { name: string; size?: "sm" | "md" | "lg" | "xl" }
export function Avatar({ name, size = "md", className, ...props }: AvatarProps) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join("");
  return <span {...props} className={[styles.avatar, styles[size], className].filter(Boolean).join(" ")} aria-hidden="true">{initials}</span>;
}
