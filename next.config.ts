import type { NextConfig } from "next";

// Sem `experimental.serverActions.bodySizeLimit`: o padrão do Next (1 MB) vale para toda server action.
// O PDF do produto (até 50 MB) entra pela rota autenticada /admin/api/products/upload, com limite por streaming.
// pdf-lib fica FORA do bundle (externo): o Worker de PDF (src/lib/pdf/sandbox.ts) faz `require("pdf-lib")` em tempo de
// execução, e só pacotes externos são copiados para .next/standalone/node_modules.
const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pdf-lib"],
  // public/t.js é embutido em páginas de vendas de outros domínios (<script src=".../t.js">): JS com tipo certo,
  // CORS aberto e cache longo (1 dia + 7 dias servindo o antigo enquanto revalida; a URL não tem versão).
  async headers() {
    return [
      // Painel e login nunca dentro de frame de outro site (clickjacking; no MODE=multi as lojas são subdomínios do
      // mesmo site, então o cookie SameSite=Lax não basta). As páginas do comprador já têm CSP própria (src/proxy.ts).
      {
        source: "/admin/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/t.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
