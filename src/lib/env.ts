import { z } from "zod";

function isHttpBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && !value.endsWith("/");
  } catch {
    return false;
  }
}

/** Origem `https://host[:porta]` sem caminho, query nem barra final; `http:` só em loopback. */
function isCardOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.origin !== value) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackUrl(value));
  } catch {
    return false;
  }
}

/** Hostname puro em minúsculas (um ou mais rótulos): vira parte das origens do checkout. */
const PLATFORM_HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const schema = z.object({
  // `app` = o app Next; `card` = o serviço isolado do cartão (nunca recebe o SECRET; ver parseEnv).
  SERVICE: z.enum(["app", "card"]).default("app"),
  // 1 = o formulário do cartão é servido pelo serviço isolado (CARD_ORIGIN) em vez de pelo app.
  CARD_ISOLATED: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  CARD_ORIGIN: z.string().min(1).refine(isCardOrigin, "deve ser uma origem https://host[:porta] sem caminho, query nem barra final (http só em loopback)").optional(),
  CARD_TICKET_KEY: z.string().min(32, "deve ter no mínimo 32 caracteres (openssl rand -hex 32)").optional(),
  ASAAS_SEAL_KEY: z.string().min(32, "deve ter no mínimo 32 caracteres (openssl rand -hex 32)").optional(),
  CARD_DB_PASSWORD: z.string().min(1).optional(),
  // Porta do serviço de cartão (SERVICE=card). 0 = porta livre escolhida pelo sistema (testes do bundle em Node).
  CARD_PORT: z
    .string()
    .regex(/^\d{1,5}$/, "deve ser um número de porta (0 a 65535)")
    .default("3100")
    .transform(Number)
    .refine((n) => n <= 65535, "deve ser um número de porta (0 a 65535)"),
  MODE: z.enum(["single", "multi"]).default("single"),
  BASE_URL: z.string().min(1).refine(isHttpBaseUrl, "deve ser uma URL http(s) válida, sem barra final (ex.: https://loja.example.com)"),
  // Validada como hostname só com MODE=multi (ver parseEnv); no single é ignorada.
  PLATFORM_DOMAIN: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  // Papel dono: só migrações, CLI store-create e testes (ver requireOwnerUrl em db/client.ts). Em produção o
  // entrypoint da imagem a remove do ambiente do servidor.
  OWNER_DATABASE_URL: z.string().min(1).optional(),
  SECRET: z
    .string()
    .min(32, "deve ter no mínimo 32 caracteres")
    .refine((v) => !v.toLowerCase().includes("troque"), "é um valor de exemplo; gere um segredo próprio (openssl rand -hex 32)")
    // Obrigatório com SERVICE=app e proibido com SERVICE=card (ver parseEnv).
    .optional(),
  DATA_DIR: z.string().min(1).default("./data"),
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  TURNSTILE_SECRET: z.string().min(1).optional(),
  ASAAS_BASE_URL: z.string().min(1).optional(),
  APP_DB_PASSWORD: z.string().min(1).optional(),
  // Código exigido em /admin/setup (primeiro acesso do modo single). Na imagem Docker, o entrypoint gera um se faltar
  // e o imprime no log; em desenvolvimento e testes vem do ambiente. Sem ele, o setup pela tela fica desligado.
  SETUP_TOKEN: z.string().min(16, "deve ter no mínimo 16 caracteres (openssl rand -hex 24)").optional(),
  // Quantos proxies reversos confiáveis ficam na frente do app (0 = nenhum). Define de onde sai o IP do cliente.
  // Obrigatória em produção, salvo BASE_URL em loopback (ver parseEnv).
  TRUST_PROXY: z.enum(["0", "1", "2", "3", "4", "5"]).default("0").transform(Number),
  // Liga a rota só do smoke E2E (/api/test-only). Recusada fora de BASE_URL em loopback (ver parseEnv).
  E2E_SEED_ROUTES: z.enum(["0", "1"]).optional(),
  // Graph API do Meta falsa (smoke E2E). Recusada fora de BASE_URL em loopback, e o destino também precisa ser loopback.
  META_GRAPH_BASE_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

/** Nomes de todas as variáveis lidas pelo app (documentadas no .env.example; ver tests/deploy-config.test.ts). */
export const ENV_KEYS = Object.keys(schema.shape) as (keyof Env)[];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * URL ou host em loopback: 127.0.0.1, localhost ou ::1 (com ou sem colchetes, com ou sem esquema/porta).
 * Única implementação: usada pelo env e pela rota só do smoke.
 */
export function isLoopbackUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (LOOPBACK_HOSTS.has(v)) return true;
  for (const candidate of [v, `http://${v}`]) {
    try {
      const u = new URL(candidate);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      return LOOPBACK_HOSTS.has(u.hostname);
    } catch {
      /* tenta como host sem esquema */
    }
  }
  return false;
}

/** Valida um objeto de variáveis. Não lê `process.env`: facilita testar. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Variável vazia (`FOO=`) conta como ausente.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const isCard = cleaned.SERVICE === "card";
  const extra: string[] = [];
  if (isCard) {
    for (const k of ["SECRET", "OWNER_DATABASE_URL", "APP_DB_PASSWORD"]) {
      if (cleaned[k] !== undefined) extra.push(`${k} não pode ser passado ao serviço de cartão (SERVICE=card)`);
      delete cleaned[k];
    }
  } else if (cleaned.SECRET === undefined) {
    extra.push("SECRET (faltando)");
  }
  if (isCard || cleaned.CARD_ISOLATED === "1") {
    for (const k of ["CARD_ORIGIN", "CARD_TICKET_KEY", "ASAAS_SEAL_KEY"]) {
      if (cleaned[k] === undefined) extra.push(`${k} (faltando; obrigatória com ${isCard ? "SERVICE=card" : "CARD_ISOLATED=1"})`);
    }
  }
  // Segredos distintos: um vazamento de um não pode abrir os outros. Nunca incluir os valores na mensagem.
  const secrets = [source.CARD_TICKET_KEY, source.ASAAS_SEAL_KEY, source.SECRET].filter((v): v is string => v !== undefined && v !== "");
  if (new Set(secrets).size !== secrets.length) extra.push("CARD_TICKET_KEY, ASAAS_SEAL_KEY e SECRET precisam ser diferentes");
  if (cleaned.CARD_ORIGIN !== undefined && cleaned.BASE_URL !== undefined && isCardOrigin(cleaned.CARD_ORIGIN)) {
    let baseOrigin: string | undefined;
    try {
      baseOrigin = new URL(cleaned.BASE_URL).origin;
    } catch {
      /* BASE_URL inválida: o schema já reclama */
    }
    if (baseOrigin === cleaned.CARD_ORIGIN) extra.push("CARD_ORIGIN precisa ser um domínio diferente do checkout (ex.: https://pagar.<DOMAIN>)");
  }
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success || extra.length > 0) {
    const problems = parsed.success
      ? []
      : parsed.error.issues.map((i) => {
          const name = i.path.join(".") || "(env)";
          const missing = i.code === "invalid_type" && cleaned[name] === undefined;
          return missing ? `${name} (faltando)` : `${name}: ${i.message}`;
        });
    throw new Error(`Variáveis de ambiente inválidas: ${[...problems, ...extra].join("; ")}`);
  }
  if (parsed.data.MODE === "multi" && parsed.data.PLATFORM_DOMAIN === undefined) {
    throw new Error("Variáveis de ambiente inválidas: PLATFORM_DOMAIN é obrigatória com MODE=multi");
  }
  if (parsed.data.MODE === "multi") {
    // Antes desta validação o valor era aceito como viesse: maiúsculas e o ponto final (FQDN) viram a forma canônica,
    // em vez de impedir o boot de uma instalação que já subia. Porta, esquema e caminho continuam recusados.
    parsed.data.PLATFORM_DOMAIN = parsed.data.PLATFORM_DOMAIN!.toLowerCase().replace(/\.$/, "");
  }
  if (parsed.data.MODE === "multi" && !PLATFORM_HOSTNAME.test(parsed.data.PLATFORM_DOMAIN!)) {
    throw new Error(
      "Variáveis de ambiente inválidas: PLATFORM_DOMAIN deve ser só o hostname, sem esquema, porta nem caminho (ex.: plataforma.com.br)",
    );
  }
  if ((parsed.data.TURNSTILE_SITE_KEY === undefined) !== (parsed.data.TURNSTILE_SECRET === undefined)) {
    throw new Error("Variáveis de ambiente inválidas: TURNSTILE_SITE_KEY e TURNSTILE_SECRET devem ser definidas juntas ou nenhuma");
  }
  if (source.NODE_ENV === "production" && parsed.data.ASAAS_BASE_URL !== undefined && !isLoopbackUrl(parsed.data.ASAAS_BASE_URL)) {
    throw new Error(
      "Variáveis de ambiente inválidas: ASAAS_BASE_URL em produção só pode apontar para loopback (127.0.0.1, localhost, ::1; uso de teste e smoke)",
    );
  }
  if (parsed.data.E2E_SEED_ROUTES === "1" && !isLoopbackUrl(parsed.data.BASE_URL)) {
    throw new Error("Variáveis de ambiente inválidas: E2E_SEED_ROUTES=1 só é aceita com BASE_URL em loopback (smoke E2E local)");
  }
  if (
    parsed.data.META_GRAPH_BASE_URL !== undefined &&
    !(isLoopbackUrl(parsed.data.BASE_URL) && isLoopbackUrl(parsed.data.META_GRAPH_BASE_URL))
  ) {
    throw new Error(
      "Variáveis de ambiente inválidas: META_GRAPH_BASE_URL só é aceita com BASE_URL e destino em loopback (Meta falso do smoke E2E)",
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

/** O SECRET do app. Só o app o tem: o serviço de cartão nunca o recebe, então quem chama sem SECRET lança. */
export function requireSecret(from: { SECRET?: string } = env): string {
  const secret = from.SECRET;
  if (secret === undefined) throw new Error("SECRET não definido: o app precisa do SECRET (o serviço de cartão nunca o recebe)");
  return secret;
}

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
