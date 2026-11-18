/**
 * Lê o corpo da requisição em streaming com teto de bytes; `null` se passar do limite (declarado ou real).
 * Ao passar do limite cancela o stream: nunca guarda mais que `maxBytes` mais um pedaço.
 */
export async function readBytesCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Lê o corpo da requisição com teto de bytes; `null` se passar do limite (declarado ou real). */
export async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBytesCapped(req, maxBytes);
  return bytes === null ? null : Buffer.from(bytes).toString("utf8");
}
