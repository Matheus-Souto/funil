import type { NextConfig } from "next";

// Sem `experimental.serverActions.bodySizeLimit`: o padrão do Next (1 MB) vale para toda server action.
// O PDF do produto (até 50 MB) entra pela rota autenticada /admin/api/products/upload, com limite por streaming.
const config: NextConfig = {
  output: "standalone",
};

export default config;
