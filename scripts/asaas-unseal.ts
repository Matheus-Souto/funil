// Uso: bun run asaas:unseal (no servidor: docker compose exec app asaas-unseal)
// Rollback para uma imagem anterior ao cartão isolado: regrava em v1 (SECRET) as conexões Asaas que o app selou em a1
// (ASAAS_SEAL_KEY), para a imagem antiga abri-las sem cada vendedor colar a chave de novo. Esta versão re-sela tudo
// em a1 a cada boot do app: rode a CLI com o app desta versão no ar e troque a imagem logo em seguida (se o app desta
// versão reiniciar antes da troca, rode de novo). Escreve no terminal de quem roda (não no log do app); só contagens,
// nunca chaves.
import { env } from "@/lib/env";
import { unsealAsaasSecrets } from "@/lib/integrations";

async function main(): Promise<number> {
  if (!env.ASAAS_SEAL_KEY) {
    console.error("asaas:unseal: ASAAS_SEAL_KEY não definida; sem ela as conexões em a1 não abrem (restaure a chave usada na selagem).");
    return 1;
  }
  const r = await unsealAsaasSecrets({ secret: env.SECRET, asaasKey: env.ASAAS_SEAL_KEY });
  console.log(`Conexões Asaas regravadas em v1: ${r.unsealed}.`);
  if (r.remaining > 0) {
    console.error(
      `${r.remaining} conexão(ões) não puderam ser regravadas (lojas nas linhas acima, neste terminal); rode de novo ou cole a chave dessas lojas em Conexões antes de voltar a imagem.`,
    );
    return 1;
  }
  console.log("Pronto: troque a imagem agora (o próximo boot desta versão selaria tudo em a1 de novo).");
  return 0;
}

process.exit(await main());
