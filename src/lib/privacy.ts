// Máscaras de dado pessoal do comprador: é o que pode sair do servidor para quem não deve ver o dado inteiro
// (relatório de pedidos do MCP, detalhe do painel). Nulo e vazio viram nulo.

/** "maria@gmail.com" -> "m***@gmail.com". */
export function maskEmail(v: string | null | undefined): string | null {
  if (!v) return null;
  const at = v.lastIndexOf("@");
  if (at < 1) return "***";
  return `${Array.from(v)[0]}***${v.slice(at)}`;
}

/** Provedores de e-mail comuns: só estes domínios aparecem na máscara estrita (o resto pode identificar a pessoa). */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "me.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
]);

/**
 * Máscara do MCP: "maria@gmail.com" -> "m***@gmail.com"; domínio fora da lista de provedores comuns -> "m***@***".
 * O domínio é texto do visitante: domínio próprio reidentifica a pessoa e texto livre vira injeção de prompt.
 */
export function maskEmailStrict(v: string | null | undefined): string | null {
  if (!v) return null;
  const at = v.lastIndexOf("@");
  if (at < 1) return "***";
  const domain = v.slice(at + 1).toLowerCase();
  return `${Array.from(v)[0]}***@${PUBLIC_EMAIL_DOMAINS.has(domain) ? domain : "***"}`;
}

/** "Maria Teste" -> "M***". */
export function maskName(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? `${Array.from(t)[0]}***` : null;
}

/** "(11) 98765-4321" -> "(**) *****-4321" (só os 4 últimos dígitos). */
export function maskPhone(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  return d.length < 4 ? "(**) *****-****" : `(**) *****-${d.slice(-4)}`;
}

/** "52998224725" -> "***.982.247-**" (só os dígitos do meio, para conferência com o comprador). */
export function maskCpf(cpf: string | null | undefined): string | null {
  if (!cpf) return null;
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return "***";
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

/** "52998224725" -> "***.***.***-25" (só os 2 últimos dígitos). Mais estrita que `maskCpf`; é a do MCP. */
export function maskCpfStrict(cpf: string | null | undefined): string | null {
  if (!cpf) return null;
  const d = cpf.replace(/\D/g, "");
  return d.length < 2 ? "***.***.***-**" : `***.***.***-${d.slice(-2)}`;
}
