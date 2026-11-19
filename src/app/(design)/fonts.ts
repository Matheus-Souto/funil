// Fontes do sistema visual, self-hosted pelo next/font (arquivos dos pacotes `geist` e `@fontsource-variable`):
// Bricolage Grotesque (títulos e valores em R$), Geist (texto e campos) e Geist Mono (códigos Pix).
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

export const bricolage = localFont({
  src: "../../../node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2",
  variable: "--font-bricolage",
  weight: "200 800",
  display: "swap",
});

export const fontVariables = `${GeistSans.variable} ${GeistMono.variable} ${bricolage.variable}`;
