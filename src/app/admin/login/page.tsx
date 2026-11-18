import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/stores";
import { loginAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  if (await needsSetup()) redirect("/admin/setup");
  const { erro } = await searchParams;
  return (
    <main>
      <h1>Entrar</h1>
      {erro ? <p role="alert">E-mail ou senha inválidos.</p> : null}
      <form action={loginAction}>
        <p>
          <label>
            E-mail <input name="email" type="email" autoComplete="username" required />
          </label>
        </p>
        <p>
          <label>
            Senha <input name="password" type="password" autoComplete="current-password" required />
          </label>
        </p>
        <button type="submit">Entrar</button>
      </form>
    </main>
  );
}
