import { logoutAction } from "../actions";

export const metadata = { title: "Painel" };

export default function PanelHome() {
  return (
    <main>
      <h1>Painel</h1>
      <form action={logoutAction}>
        <button type="submit">Sair</button>
      </form>
    </main>
  );
}
