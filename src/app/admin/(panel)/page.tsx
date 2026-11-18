import { requirePanelActor } from "@/lib/auth/session";
import { logoutAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Painel" };

export default async function PanelHome() {
  await requirePanelActor();
  return (
    <main>
      <h1>Painel</h1>
      <form action={logoutAction}>
        <button type="submit">Sair</button>
      </form>
    </main>
  );
}
