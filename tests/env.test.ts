import { requireOwnerUrl } from "@/lib/db/client";
import { cardServiceConfigured, parseEnv, requireSecret } from "@/lib/env";

const base = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://app:app@localhost:5433/funil",
  OWNER_DATABASE_URL: "postgres://owner:owner@localhost:5433/funil",
  SECRET: "s".repeat(32),
};

test("parseEnv aplica padrões e aceita opcionais", () => {
  const e = parseEnv({ ...base, ASAAS_BASE_URL: "http://localhost:4010", APP_DB_PASSWORD: "app" });
  expect(e.MODE).toBe("single");
  expect(e.DATA_DIR).toBe("./data");
  expect(e.ASAAS_BASE_URL).toBe("http://localhost:4010");
  expect(e.APP_DB_PASSWORD).toBe("app");
  expect(e.TURNSTILE_SECRET).toBeUndefined();
});

test("parseEnv lista as variáveis faltando", () => {
  expect(() => parseEnv({})).toThrow(/BASE_URL.*DATABASE_URL.*SECRET/s);
});

test("OWNER_DATABASE_URL é opcional para o app (o servidor de produção roda sem o papel dono)", () => {
  expect(parseEnv({ ...base, OWNER_DATABASE_URL: undefined, NODE_ENV: "production", TRUST_PROXY: "1" }).OWNER_DATABASE_URL).toBeUndefined();
  expect(() => requireOwnerUrl({})).toThrow("OWNER_DATABASE_URL não definida");
  expect(requireOwnerUrl({ OWNER_DATABASE_URL: base.OWNER_DATABASE_URL })).toBe(base.OWNER_DATABASE_URL);
});

test("um só comando para gerar o SECRET em todas as mensagens: openssl rand -hex 32", () => {
  expect(() => parseEnv({ ...base, SECRET: "troque-por-um-segredo-aleatorio-de-32-ou-mais-caracteres" })).toThrow("openssl rand -hex 32");
});

test("SECRET precisa de 32 caracteres", () => {
  expect(() => parseEnv({ ...base, SECRET: "curta" })).toThrow(/SECRET/);
});

test("ASAAS_BASE_URL em produção só aceita loopback", () => {
  for (const url of ["http://127.0.0.1:4010", "http://localhost:4010/x", "http://[::1]:4010"]) {
    expect(parseEnv({ ...base, NODE_ENV: "production", ASAAS_BASE_URL: url }).ASAAS_BASE_URL).toBe(url);
  }
  for (const url of ["http://x", "https://api.asaas.com", "http://127.0.0.1.evil.com", "lixo"]) {
    expect(() => parseEnv({ ...base, NODE_ENV: "production", ASAAS_BASE_URL: url })).toThrow(/ASAAS_BASE_URL.*loopback/);
  }
  expect(parseEnv({ ...base, NODE_ENV: "production" }).ASAAS_BASE_URL).toBeUndefined();
});

test("TRUST_PROXY: obrigatório em produção fora de loopback; padrão 0 em loopback e fora de produção", () => {
  const remote = { ...base, NODE_ENV: "production", BASE_URL: "https://loja.example.com" };
  expect(() => parseEnv(remote)).toThrow(/TRUST_PROXY.*obrigatória em produção/);
  expect(parseEnv({ ...remote, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
  expect(parseEnv({ ...remote, TRUST_PROXY: "0" }).TRUST_PROXY).toBe(0);
  expect(parseEnv({ ...base, NODE_ENV: "production", BASE_URL: "http://127.0.0.1:3000" }).TRUST_PROXY).toBe(0);
  expect(parseEnv({ ...base, BASE_URL: "https://loja.example.com" }).TRUST_PROXY).toBe(0);
  expect(() => parseEnv({ ...remote, TRUST_PROXY: "sim" })).toThrow(/TRUST_PROXY/);
});

test("MODE inválido falha", () => {
  expect(() => parseEnv({ ...base, MODE: "x" })).toThrow(/MODE/);
});

test("SECRET de exemplo é recusado com mensagem clara", () => {
  for (const secret of [
    "troque-por-um-segredo-aleatorio-de-32-ou-mais-caracteres",
    "TROQUE-ESTE-SEGREDO-por-um-valor-aleatorio-longo",
  ]) {
    expect(() => parseEnv({ ...base, SECRET: secret })).toThrow(/SECRET.*exemplo/);
  }
});

test(".env.example não traz um SECRET que passe na validação", async () => {
  const text = await Bun.file(new URL("../.env.example", import.meta.url)).text();
  const line = text.split("\n").find((l) => l.startsWith("SECRET="));
  const value = line?.slice("SECRET=".length).trim() ?? "";
  expect(() => parseEnv({ ...base, SECRET: value })).toThrow(/SECRET/);
});

test("MODE=multi exige PLATFORM_DOMAIN", () => {
  expect(() => parseEnv({ ...base, MODE: "multi" })).toThrow(/PLATFORM_DOMAIN/);
  expect(parseEnv({ ...base, MODE: "multi", PLATFORM_DOMAIN: "lojas.example.com" }).PLATFORM_DOMAIN).toBe("lojas.example.com");
  expect(parseEnv({ ...base, MODE: "single" }).MODE).toBe("single");
});

test("BASE_URL precisa ser URL http(s) sem barra final", () => {
  for (const url of ["localhost:3000", "ftp://x.com", "loja.example.com", "http://x.com/", "https://x.com/loja/", "lixo"]) {
    expect(() => parseEnv({ ...base, BASE_URL: url })).toThrow(/BASE_URL/);
  }
  for (const url of ["http://localhost:3000", "https://loja.example.com", "https://x.com/base"]) {
    expect(parseEnv({ ...base, BASE_URL: url }).BASE_URL).toBe(url);
  }
});

test("TURNSTILE_SITE_KEY e TURNSTILE_SECRET juntos ou nenhum", () => {
  expect(() => parseEnv({ ...base, TURNSTILE_SITE_KEY: "k" })).toThrow(/TURNSTILE/);
  expect(() => parseEnv({ ...base, TURNSTILE_SECRET: "s" })).toThrow(/TURNSTILE/);
  expect(parseEnv({ ...base, TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" }).TURNSTILE_SECRET).toBe("s");
  expect(parseEnv(base).TURNSTILE_SITE_KEY).toBeUndefined();
});

test("E2E_SEED_ROUTES=1 só com BASE_URL em loopback (rota só do smoke)", () => {
  for (const url of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"]) {
    expect(parseEnv({ ...base, NODE_ENV: "production", BASE_URL: url, E2E_SEED_ROUTES: "1" }).E2E_SEED_ROUTES).toBe("1");
  }
  for (const url of ["https://loja.example.com", "http://127.0.0.1.evil.com"]) {
    expect(() => parseEnv({ ...base, BASE_URL: url, TRUST_PROXY: "1", E2E_SEED_ROUTES: "1" })).toThrow(/E2E_SEED_ROUTES.*loopback/);
  }
  expect(parseEnv(base).E2E_SEED_ROUTES).toBeUndefined();
  expect(() => parseEnv({ ...base, E2E_SEED_ROUTES: "sim" })).toThrow(/E2E_SEED_ROUTES/);
});

test("isLoopbackUrl: 127.0.0.1, localhost e ::1 (com ou sem colchetes)", async () => {
  const { isLoopbackUrl } = await import("@/lib/env");
  for (const u of ["http://127.0.0.1:1", "http://localhost", "http://[::1]:3000", "::1", "127.0.0.1", "localhost:4010"]) expect(isLoopbackUrl(u)).toBe(true);
  for (const u of ["http://x", "https://api.asaas.com", "http://127.0.0.1.evil.com", "lixo", ""]) expect(isLoopbackUrl(u)).toBe(false);
});

test("SETUP_TOKEN: opcional para o app; se definido, 16+ caracteres", () => {
  expect(parseEnv(base).SETUP_TOKEN).toBeUndefined();
  expect(parseEnv({ ...base, SETUP_TOKEN: "a".repeat(16) }).SETUP_TOKEN).toBe("a".repeat(16));
  expect(() => parseEnv({ ...base, SETUP_TOKEN: "curto" })).toThrow(/SETUP_TOKEN/);
});

const cardKeys = {
  CARD_ORIGIN: "https://cartao.example.com",
  CARD_TICKET_KEY: "t".repeat(32),
  ASAAS_SEAL_KEY: "a".repeat(32),
};
const baseSemSecret: Record<string, string | undefined> = { ...base, SECRET: undefined };
const baseCard: Record<string, string | undefined> = { ...baseSemSecret, OWNER_DATABASE_URL: undefined };
const cardBase = { ...baseCard, SERVICE: "card", ...cardKeys };

test("SERVICE=app (padrão) sem SECRET falha", () => {
  expect(() => parseEnv(baseSemSecret)).toThrow(/SECRET/);
  expect(() => parseEnv({ ...baseSemSecret, SERVICE: "app" })).toThrow(/SECRET/);
  expect(parseEnv(base).SERVICE).toBe("app");
});

test("SERVICE inválido falha", () => {
  expect(() => parseEnv({ ...base, SERVICE: "x" })).toThrow(/SERVICE/);
});

test("SERVICE=card: aceita as variáveis do serviço, sem SECRET", () => {
  const e = parseEnv({ ...cardBase, CARD_DB_PASSWORD: "card" });
  expect(e.SERVICE).toBe("card");
  expect(e.SECRET).toBeUndefined();
  expect(e.CARD_ORIGIN).toBe(cardKeys.CARD_ORIGIN);
  expect(e.CARD_TICKET_KEY).toBe(cardKeys.CARD_TICKET_KEY);
  expect(e.ASAAS_SEAL_KEY).toBe(cardKeys.ASAAS_SEAL_KEY);
  expect(e.CARD_DB_PASSWORD).toBe("card");
});

test("CARD_PORT: padrão 3100; 0 (porta livre) e outras portas válidas; fora da faixa ou não numérica falha", () => {
  expect(parseEnv(cardBase).CARD_PORT).toBe(3100);
  expect(parseEnv({ ...cardBase, CARD_PORT: "0" }).CARD_PORT).toBe(0);
  expect(parseEnv({ ...cardBase, CARD_PORT: "8080" }).CARD_PORT).toBe(8080);
  for (const bad of ["65536", "-1", "abc", "3100x"]) expect(() => parseEnv({ ...cardBase, CARD_PORT: bad })).toThrow(/CARD_PORT/);
});

test("SERVICE=card com SECRET definido falha", () => {
  expect(() => parseEnv({ ...cardBase, SECRET: base.SECRET })).toThrow("SECRET não pode ser passado ao serviço de cartão");
});

test("SERVICE=card continua exigindo BASE_URL e DATABASE_URL", () => {
  expect(() => parseEnv({ ...cardBase, BASE_URL: undefined })).toThrow(/BASE_URL/);
  expect(() => parseEnv({ ...cardBase, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
});

test("SERVICE=card exige CARD_TICKET_KEY, ASAAS_SEAL_KEY e CARD_ORIGIN", () => {
  for (const k of Object.keys(cardKeys)) {
    expect(() => parseEnv({ ...cardBase, [k]: undefined })).toThrow(new RegExp(k));
  }
});

test("CARD_ISOLATED (obsoleta): aceita e ignorada com qualquer valor, sem efeito nem campo no env", () => {
  // O verify.sh do main ainda a passa; o isolamento é sempre ligado agora.
  for (const v of ["0", "1", "sim", ""]) {
    const e = parseEnv({ ...base, CARD_ISOLATED: v });
    expect("CARD_ISOLATED" in e).toBe(false);
    expect(e.CARD_ORIGIN).toBeUndefined();
  }
  expect(parseEnv({ ...base, CARD_ISOLATED: "1", ...cardKeys }).CARD_ORIGIN).toBe(cardKeys.CARD_ORIGIN);
});

test("app sem CARD_ORIGIN sobe (cartão indisponível); com CARD_ORIGIN, exige CARD_TICKET_KEY e ASAAS_SEAL_KEY", () => {
  expect(cardServiceConfigured(parseEnv(base))).toBe(false);
  // Chave do Asaas sozinha (conexões já seladas, cartão ainda sem domínio): sobe, e o cartão segue indisponível.
  expect(cardServiceConfigured(parseEnv({ ...base, ASAAS_SEAL_KEY: cardKeys.ASAAS_SEAL_KEY }))).toBe(false);
  expect(cardServiceConfigured(parseEnv({ ...base, ...cardKeys }))).toBe(true);
  for (const k of ["CARD_TICKET_KEY", "ASAAS_SEAL_KEY"]) {
    expect(() => parseEnv({ ...base, ...cardKeys, [k]: undefined })).toThrow(new RegExp(`${k} \\(faltando; obrigatória com CARD_ORIGIN\\)`));
  }
});

test("CARD_ORIGIN: origem https sem caminho, query nem barra final; http só em loopback", () => {
  for (const o of ["https://cartao.example.com", "https://cartao.example.com:8443", "http://localhost:3100", "http://127.0.0.1:3100"]) {
    expect(parseEnv({ ...cardBase, CARD_ORIGIN: o }).CARD_ORIGIN).toBe(o);
  }
  for (const o of [
    "https://cartao.example.com/",
    "https://cartao.example.com/pay",
    "https://cartao.example.com?x=1",
    "http://cartao.example.com",
    "http://127.0.0.1.evil.com",
    "cartao.example.com",
    "ftp://cartao.example.com",
  ]) {
    expect(() => parseEnv({ ...cardBase, CARD_ORIGIN: o })).toThrow(/CARD_ORIGIN/);
  }
});

test("CARD_TICKET_KEY e ASAAS_SEAL_KEY exigem 32 caracteres", () => {
  expect(() => parseEnv({ ...cardBase, CARD_TICKET_KEY: "curta" })).toThrow(/CARD_TICKET_KEY/);
  expect(() => parseEnv({ ...cardBase, ASAAS_SEAL_KEY: "curta" })).toThrow(/ASAAS_SEAL_KEY/);
});

test("requireSecret devolve o SECRET e lança erro claro sem ele", () => {
  expect(requireSecret({ SECRET: base.SECRET })).toBe(base.SECRET);
  expect(() => requireSecret({})).toThrow("SECRET não definido: o app precisa do SECRET (o serviço de cartão nunca o recebe)");
  expect(typeof requireSecret()).toBe("string"); // env do processo de teste (preload) define SECRET
});

test("SERVICE=card recusa OWNER_DATABASE_URL e APP_DB_PASSWORD", () => {
  expect(() => parseEnv({ ...cardBase, OWNER_DATABASE_URL: base.OWNER_DATABASE_URL })).toThrow(
    "OWNER_DATABASE_URL não pode ser passado ao serviço de cartão",
  );
  expect(() => parseEnv({ ...cardBase, APP_DB_PASSWORD: "app" })).toThrow("APP_DB_PASSWORD não pode ser passado ao serviço de cartão");
  expect(parseEnv({ ...base, ...cardKeys, CARD_ISOLATED: "1" }).OWNER_DATABASE_URL).toBe(base.OWNER_DATABASE_URL);
});

test("CARD_TICKET_KEY, ASAAS_SEAL_KEY e SECRET precisam ser diferentes, sem vazar valores", () => {
  const same = "z".repeat(32);
  const msg = "CARD_TICKET_KEY, ASAAS_SEAL_KEY e SECRET precisam ser diferentes";
  const cases = [
    { ...base, ...cardKeys, CARD_TICKET_KEY: same, ASAAS_SEAL_KEY: same },
    { ...base, ...cardKeys, CARD_TICKET_KEY: same, SECRET: same },
    { ...base, ...cardKeys, ASAAS_SEAL_KEY: same, SECRET: same },
    { ...base, CARD_TICKET_KEY: same, SECRET: same },
    { ...cardBase, CARD_TICKET_KEY: same, ASAAS_SEAL_KEY: same },
  ];
  for (const c of cases) {
    let message = "";
    try {
      parseEnv(c);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(msg);
    expect(message).not.toContain(same);
  }
  expect(parseEnv({ ...base, ...cardKeys, CARD_ISOLATED: "1" }).CARD_TICKET_KEY).toBe(cardKeys.CARD_TICKET_KEY);
});

test("CARD_ORIGIN precisa ser diferente da origem de BASE_URL", () => {
  const msg = "CARD_ORIGIN precisa ser um domínio diferente do checkout (ex.: https://pagar.<DOMAIN>)";
  expect(() => parseEnv({ ...cardBase, BASE_URL: "https://loja.example.com", CARD_ORIGIN: "https://loja.example.com" })).toThrow(msg);
  expect(() => parseEnv({ ...base, BASE_URL: "https://loja.example.com/base", TRUST_PROXY: "1", CARD_ORIGIN: "https://loja.example.com" })).toThrow(msg);
  expect(parseEnv({ ...cardBase, BASE_URL: "https://loja.example.com", CARD_ORIGIN: "https://pagar.example.com" }).CARD_ORIGIN).toBe(
    "https://pagar.example.com",
  );
});

test("PLATFORM_DOMAIN: só hostname (minúsculas, sem esquema, porta, caminho ou curinga; um ou mais rótulos)", () => {
  const multi = { ...base, MODE: "multi" };
  for (const ok of ["plataforma.com.br", "lojas.example.com", "lvh.me", "a-b.c1.io", "localhost"]) {
    expect(parseEnv({ ...multi, PLATFORM_DOMAIN: ok }).PLATFORM_DOMAIN).toBe(ok);
  }
  for (const bad of ["https://plataforma.com", "plataforma.com:8443", "Plataforma.com:8443", "plataforma.com/x", "*.plataforma.com", ".plataforma.com", "plataforma.com..", "a..com", "-a.com", "a b.com"]) {
    expect(() => parseEnv({ ...multi, PLATFORM_DOMAIN: bad })).toThrow(/PLATFORM_DOMAIN/);
  }
});

test("PLATFORM_DOMAIN no multi: normalizado (minúsculas, sem o ponto final) antes de validar; instalações que subiam continuam subindo", () => {
  const multi = { ...base, MODE: "multi" };
  expect(parseEnv({ ...multi, PLATFORM_DOMAIN: "Plataforma.COM.br" }).PLATFORM_DOMAIN).toBe("plataforma.com.br");
  expect(parseEnv({ ...multi, PLATFORM_DOMAIN: "plataforma.com.br." }).PLATFORM_DOMAIN).toBe("plataforma.com.br");
  expect(parseEnv({ ...multi, PLATFORM_DOMAIN: "Lojas.Example.com." }).PLATFORM_DOMAIN).toBe("lojas.example.com");
});

test("PLATFORM_DOMAIN é ignorado fora do MODE=multi (valor antigo malformado não impede o boot)", () => {
  expect(parseEnv({ ...base, PLATFORM_DOMAIN: "https://velho.com:8443/x" }).PLATFORM_DOMAIN).toBe("https://velho.com:8443/x");
  expect(parseEnv({ ...base, MODE: "single", PLATFORM_DOMAIN: "Velho.COM" }).MODE).toBe("single");
});
