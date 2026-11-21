import type { ReactNode } from "react";
// Tokens do Arc (componentes de src/components/arc) e o tema claro/escuro do painel. Só nas telas de /admin.
import "@/components/arc/foundation.css";
import "./theme.css";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
