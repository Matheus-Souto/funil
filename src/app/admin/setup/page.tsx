import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/stores";
import { setupAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configuração inicial" };

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  if (!(await needsSetup())) redirect("/admin/login");
  const { erro } = await searchParams;
  return (
    <main>
      <h1>Configuração inicial</h1>
      {erro ? <p role="alert">Confira os dados. A senha precisa ter no mínimo 10 caracteres.</p> : null}
      <form action={setupAction}>
        <p>
          <label>
            Nome da loja <input name="storeName" required maxLength={120} />
          </label>
        </p>
        <p>
          <label>
            Seu nome <input name="name" autoComplete="name" required maxLength={120} />
          </label>
        </p>
        <p>
          <label>
            E-mail <input name="email" type="email" autoComplete="username" required />
          </label>
        </p>
        <p>
          <label>
            Senha (mínimo 10 caracteres) <input name="password" type="password" autoComplete="new-password" minLength={10} required />
          </label>
        </p>
        <button type="submit">Criar loja</button>
      </form>
    </main>
  );
}
