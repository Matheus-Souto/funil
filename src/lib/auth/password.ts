import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { ActionError } from "@/lib/actions/core";

// scrypt do Node (o app roda em Node, não em Bun): N=2^15, r=8, p=1, sal 16 B, chave 64 B.
const N = 2 ** 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAXMEM = 128 * 1024 * 1024; // N*r*128 = 32 MiB; folga para o limite padrão de 32 MiB não estourar
const MIN_LENGTH = 10;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const opts: ScryptOptions = { N: n, r, p, maxmem: MAXMEM };
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** Formato `scrypt$N$r$p$<sal b64url>$<hash b64url>`. Exige no mínimo 10 caracteres. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_LENGTH) {
    throw new ActionError("invalid_input", `A senha precisa ter no mínimo ${MIN_LENGTH} caracteres`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  // Só aceita os parâmetros que nós geramos (evita custo controlado por dado do banco).
  if (n !== N || r !== R || p !== P) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, salt, N, R, P);
  return timingSafeEqual(actual, expected);
}
