import type { ReactNode } from "react";
import { fontVariables } from "./(design)/fonts";
import "./(design)/tokens.css";

export const metadata = { title: "Funil" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={fontVariables}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
