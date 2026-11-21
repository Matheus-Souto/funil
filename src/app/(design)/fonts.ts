// Fontes do sistema visual, self-hosted pelo next/font (arquivos dos pacotes `@fontsource-variable` e `geist`):
// Inter (títulos, texto, campos e valores em R$) e Geist Mono (códigos Pix).
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";

export const inter = localFont({
  src: "../../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

export const fontVariables = `${inter.variable} ${GeistMono.variable}`;
