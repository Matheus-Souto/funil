import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getPanelActor } from "@/lib/auth/session";
import { needsSetup } from "@/lib/stores";

export const dynamic = "force-dynamic";

// Protege tudo em /admin/(panel); /admin/login e /admin/setup ficam fora do grupo.
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const panel = await getPanelActor();
  if (!panel) redirect((await needsSetup()) ? "/admin/setup" : "/admin/login");
  return <>{children}</>;
}
