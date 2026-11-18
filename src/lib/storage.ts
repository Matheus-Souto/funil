import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { env } from "@/lib/env";

export interface Storage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  /** Leitura em fluxo, sem carregar o arquivo na memória (ex.: servir um PDF grande). `null` se não existe. */
  stream(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
  delete(key: string): Promise<void>;
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Chave relativa, sem `..`, sem caminho absoluto, sem NUL e sem barra invertida. */
export function assertSafeKey(key: string): void {
  const bad =
    key.length === 0 ||
    key.includes("\0") ||
    key.includes("\\") ||
    isAbsolute(key) ||
    key.startsWith("/") ||
    key.split("/").some((seg) => seg === ".." || seg === "." || seg === "") ||
    key.includes("..");
  if (bad) throw new Error("Chave de armazenamento inválida");
}

/** Armazenamento em disco sob `root()`. A gravação é atômica (arquivo temporário + rename). */
export function createStorage(root: () => string): Storage {
  const pathFor = (key: string): string => {
    assertSafeKey(key);
    const base = resolve(root());
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) throw new Error("Chave de armazenamento inválida");
    return full;
  };
  return {
    async put(key, data) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, data);
        await rename(tmp, path);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)));
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    async exists(key) {
      try {
        await access(pathFor(key));
        return true;
      } catch (e) {
        if (isMissing(e)) return false;
        throw e;
      }
    },
    async stream(key) {
      let fh;
      try {
        fh = await open(pathFor(key), "r");
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
      // O descritor aberto segura o arquivo lido mesmo que um `put` o troque (rename) no meio do envio.
      try {
        const { size } = await fh.stat();
        return { size, body: Readable.toWeb(fh.createReadStream()) as unknown as ReadableStream<Uint8Array> };
      } catch (e) {
        await fh.close();
        throw e;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export const storage: Storage = createStorage(() => join(env.DATA_DIR, "files"));
