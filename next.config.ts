import type { NextConfig } from "next";

// Sem `experimental.serverActions.bodySizeLimit`: o padrão do Next (1 MB) vale para toda server action.
// O PDF do produto (até 50 MB) entra pela rota autenticada /admin/api/products/upload, com limite por streaming.
// pdf-lib fica FORA do bundle (externo): o Worker de PDF (src/lib/pdf/sandbox.ts) faz `require("pdf-lib")` em tempo de
// execução, e só pacotes externos são copiados para .next/standalone/node_modules.
const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pdf-lib"],
};

export default config;
