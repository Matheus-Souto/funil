export async function register(): Promise<void> {
  // Só no servidor Node em execução (não no edge, nem durante `next build`).
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  // Env inválido derruba a subida (código 1, mensagem clara no log) em vez de o app subir e falhar no primeiro uso:
  // o `env` do app só é lido sob demanda, e o healthcheck passaria com a configuração quebrada.
  const { parseEnv } = await import("@/lib/env");
  try {
    parseEnv(process.env);
  } catch (e) {
    console.error(`funil: não foi possível iniciar. ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const { startWorker } = await import("@/lib/jobs/worker");
  startWorker();
}
