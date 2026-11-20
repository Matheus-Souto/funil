export async function register(): Promise<void> {
  // Só no servidor Node em execução (não no edge, nem durante `next build`).
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  // Env inválido derruba a subida (código 1, mensagem clara no log) em vez de o app subir e falhar no primeiro uso:
  // o `env` do app só é lido sob demanda, e o healthcheck passaria com a configuração quebrada.
  const { parseEnv } = await import("@/lib/env");
  let parsed: ReturnType<typeof parseEnv>;
  try {
    parsed = parseEnv(process.env);
  } catch (e) {
    console.error(`funil: não foi possível iniciar. ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (parsed.SERVICE === "app") {
    // Re-sela as conexões Asaas na chave própria (com a ASAAS_SEAL_KEY) e confere se ela abre as que já estão em a1:
    // chave trocada, removida ou rollback trancaria o Asaas de todas as lojas sem aviso.
    const { prepareAsaasSealOnBoot } = await import("@/lib/integrations");
    let unreadable = 0;
    try {
      unreadable = (await prepareAsaasSealOnBoot()).unreadable;
    } catch (e) {
      // Banco fora no boot: o healthcheck acusa; a conferência fica para a próxima subida.
      const { log } = await import("@/lib/log");
      log.error("não foi possível conferir a ASAAS_SEAL_KEY no boot", { error: e });
    }
    if (unreadable > 0) {
      console.error(
        `funil: não foi possível iniciar. ASAAS_SEAL_KEY ausente ou diferente da que selou a conexão Asaas de ${unreadable} loja(s); restaure a chave correta`,
      );
      process.exit(1);
    }
  }
  const { startWorker } = await import("@/lib/jobs/worker");
  startWorker();
}
