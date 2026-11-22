import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { fontVariables } from "./(design)/fonts";
import "./(design)/tokens.css";

export const metadata = { title: "Funil" };

/** Tema escolhido no painel (cookie `funil-theme`). Sem cookie: segue o sistema. Só o painel reage a ele. */
async function savedTheme(): Promise<"light" | "dark" | undefined> {
  const v = (await cookies()).get("funil-theme")?.value;
  return v === "light" || v === "dark" ? v : undefined;
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={fontVariables} data-theme={await savedTheme()}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
