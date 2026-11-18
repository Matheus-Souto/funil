import { z } from "zod";

function isHttpBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && !value.endsWith("/");
  } catch {
    return false;
  }
}

const schema = z.object({
  MODE: z.enum(["single", "multi"]).default("single"),
  BASE_URL: z.string().min(1).refine(isHttpBaseUrl, "deve ser uma URL http(s) válida, sem barra final (ex.: https://loja.example.com)"),
  PLATFORM_DOMAIN: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  OWNER_DATABASE_URL: z.string().min(1),
  SECRET: z
    .string()
    .min(32, "deve ter no mínimo 32 caracteres")
    .refine((v) => !v.toLowerCase().includes("troque"), "é um valor de exemplo; gere um segredo próprio (openssl rand -base64 48)"),
  DATA_DIR: z.string().min(1).default("./data"),
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  TURNSTILE_SECRET: z.string().min(1).optional(),
  ASAAS_BASE_URL: z.string().min(1).optional(),
  APP_DB_PASSWORD: z.string().min(1).optional(),
  // Quantos proxies reversos confiáveis ficam na frente do app (0 = nenhum). Define de onde sai o IP do cliente.
  // Obrigatória em produção, salvo BASE_URL em loopback (ver parseEnv).
  TRUST_PROXY: z.enum(["0", "1", "2", "3", "4", "5"]).default("0").transform(Number),
});

export type Env = z.infer<typeof schema>;

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** Valida um objeto de variáveis. Não lê `process.env`: facilita testar. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Variável vazia (`FOO=`) conta como ausente.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => {
      const name = i.path.join(".") || "(env)";
      const missing = i.code === "invalid_type" && cleaned[name] === undefined;
      return missing ? `${name} (faltando)` : `${name}: ${i.message}`;
    });
    throw new Error(`Variáveis de ambiente inválidas: ${problems.join("; ")}`);
  }
  if (parsed.data.MODE === "multi" && parsed.data.PLATFORM_DOMAIN === undefined) {
    throw new Error("Variáveis de ambiente inválidas: PLATFORM_DOMAIN é obrigatória com MODE=multi");
  }
  if ((parsed.data.TURNSTILE_SITE_KEY === undefined) !== (parsed.data.TURNSTILE_SECRET === undefined)) {
    throw new Error("Variáveis de ambiente inválidas: TURNSTILE_SITE_KEY e TURNSTILE_SECRET devem ser definidas juntas ou nenhuma");
  }
  if (source.NODE_ENV === "production" && parsed.data.ASAAS_BASE_URL !== undefined && !isLoopbackUrl(parsed.data.ASAAS_BASE_URL)) {
    throw new Error(
      "Variáveis de ambiente inválidas: ASAAS_BASE_URL em produção só pode apontar para loopback (127.0.0.1, localhost, ::1; uso de teste e smoke)",
    );
  }
  if (source.NODE_ENV === "production" && cleaned.TRUST_PROXY === undefined && !isLoopbackUrl(parsed.data.BASE_URL)) {
    throw new Error(
      "Variáveis de ambiente inválidas: TRUST_PROXY é obrigatória em produção (1 atrás de um proxy reverso como o Caddy; 0 sem proxy). Ela define de onde vem o IP do comprador.",
    );
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Lê `process.env` só no primeiro acesso a uma propriedade (o import nunca falha). */
export const env: Env = new Proxy({} as Env, {
  get(_t, prop) {
    cached ??= parseEnv(process.env);
    return cached[prop as keyof Env];
  },
  has(_t, prop) {
    cached ??= parseEnv(process.env);
    return prop in cached;
  },
  ownKeys() {
    cached ??= parseEnv(process.env);
    return Reflect.ownKeys(cached);
  },
  getOwnPropertyDescriptor(_t, prop) {
    cached ??= parseEnv(process.env);
    return Reflect.getOwnPropertyDescriptor(cached, prop);
  },
});
