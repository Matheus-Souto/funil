"use server";

import { redirect } from "next/navigation";
import { destroySession, requirePanelActor } from "@/lib/auth/session";

// Toda server action do painel começa por requirePanelActor(): o layout não protege ações (elas são endpoints POST).
export async function logoutAction(): Promise<void> {
  await requirePanelActor();
  await destroySession();
  redirect("/admin/login");
}
