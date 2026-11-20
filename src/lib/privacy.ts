// Máscaras de dado pessoal do comprador: é o que pode sair do servidor para quem não deve ver o dado inteiro
// (relatório de pedidos do MCP, detalhe do painel). Nulo e vazio viram nulo.

/** "maria@gmail.com" -> "m***@gmail.com". */
export function maskEmail(v: string | null | undefined): string | null {
  if (!v) return null;
  const at = v.lastIndexOf("@");
  if (at < 1) return "***";
  return `${Array.from(v)[0]}***${v.slice(at)}`;
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
