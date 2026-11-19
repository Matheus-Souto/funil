import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { requireSecret } from "@/lib/env";

const VERSION = "v1";
const INFO = "funil:seal:v1";

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32));
}

/** AES-256-GCM com chave derivada (HKDF) de um segredo. Formato `v1.<iv>.<tag>.<ciphertext>` em base64url. */
export function createSealer(secret: string) {
  const key = deriveKey(secret);
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, tag, data].map((p, i) => (i === 0 ? p : (p as Buffer).toString("base64url"))).join(".");
    },
    open(sealed: string): string {
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Valor selado inválido");
      const [iv, tag, data] = parts.slice(1).map((p) => Buffer.from(p, "base64url"));
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Valor selado inválido");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    },
  };
}

let sealer: ReturnType<typeof createSealer> | undefined;
const defaultSealer = () => (sealer ??= createSealer(requireSecret()));

export const seal = (plain: string): string => defaultSealer().seal(plain);
export const open = (sealed: string): string => defaultSealer().open(sealed);

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const sha256Bytes = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
