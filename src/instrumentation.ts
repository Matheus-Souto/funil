export async function register(): Promise<void> {
  // Só no servidor Node em execução (não no edge, nem durante `next build`).
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  // Env inválido derruba a subida (código 1, mensagem clara no log) em vez de o app subir e falhar no primeiro uso:
  // o `env` do app só é lido sob demanda, e o healthcheck passaria com a configuração quebrada.
  const { parseEnv } = await import("@/lib/env");
  let service: "app" | "card";
  try {
    service = parseEnv(process.env).SERVICE;
  } catch (e) {
    console.error(`funil: não foi possível iniciar. ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (service === "app") {
    // Conexões Asaas gravadas antes da ASAAS_SEAL_KEY passam para a chave própria (a1), que o serviço de cartão abre.
    // Falha não derruba a subida: um `v1.` continua abrindo com o SECRET no app.
    const { resealAsaasSecrets } = await import("@/lib/integrations");
    const { log } = await import("@/lib/log");
    try {
      const n = await resealAsaasSecrets();
      if (n > 0) log.info("conexões Asaas re-seladas com a ASAAS_SEAL_KEY", { count: n });
    } catch (e) {
      log.error("re-selagem das conexões Asaas falhou no boot", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const { startWorker } = await import("@/lib/jobs/worker");
  startWorker();
}
