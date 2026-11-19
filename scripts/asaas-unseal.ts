// Uso: bun run asaas:unseal (no servidor: docker compose exec app asaas-unseal)
// Rollback do cartão isolado: regrava em v1 (SECRET) as conexões Asaas que o app re-selou em a1 (ASAAS_SEAL_KEY), para
// uma imagem anterior ao isolamento abri-las sem cada vendedor colar a chave de novo. Rode com CARD_ISOLATED=0 (com 1,
// o próximo boot do app re-sela tudo em a1). Imprime só contagens; nunca chaves.
import { env } from "@/lib/env";
import { unsealAsaasSecrets } from "@/lib/integrations";

async function main(): Promise<number> {
  if (env.CARD_ISOLATED) {
    console.error("asaas:unseal: desligue o cartão isolado antes (CARD_ISOLATED=0 no .env e `docker compose up -d`); com ele ligado, o app re-sela tudo em a1 no próximo boot.");
    return 1;
  }
  if (!env.ASAAS_SEAL_KEY) {
    console.error("asaas:unseal: ASAAS_SEAL_KEY não definida; sem ela as conexões em a1 não abrem (restaure a chave usada na selagem).");
    return 1;
  }
  const r = await unsealAsaasSecrets({ secret: env.SECRET, asaasKey: env.ASAAS_SEAL_KEY });
  console.log(`Conexões Asaas regravadas em v1: ${r.unsealed}.`);
  if (r.remaining > 0) {
    console.error(`${r.remaining} conexão(ões) não puderam ser regravadas (ver log); rode de novo ou cole a chave dessas lojas em Conexões antes de voltar a imagem.`);
    return 1;
  }
  console.log("Pronto: a imagem anterior ao isolamento abre as conexões Asaas.");
  return 0;
}

process.exit(await main());
