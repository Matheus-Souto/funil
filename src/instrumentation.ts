export async function register(): Promise<void> {
  // Só no servidor Node em execução (não no edge, nem durante `next build`).
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startWorker } = await import("@/lib/jobs/worker");
  startWorker();
}
