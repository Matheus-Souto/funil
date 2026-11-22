// Papéis de uma pessoa na loja, com o rótulo e o que cada um pode (tabela 3 da spec "Equipe e convites"). Usados pela
// página no servidor e pelo painel no navegador (constantes num .ts comum, não no arquivo "use client").
export type MemberRole = "owner" | "admin" | "support" | "traffic";

export const ROLE_INFO: Record<MemberRole, { label: string; can: string; cannot: string | null }> = {
  owner: { label: "Dono", can: "Tudo, inclusive equipe, tokens MCP e conexões de pagamento.", cannot: null },
  admin: {
    label: "Administrador",
    can: "Tudo, menos equipe e conexões.",
    cannot: "Convidar, trocar papel, remover pessoas e criar tokens MCP.",
  },
  support: {
    label: "Atendimento",
    can: "Pedidos (ver e reenviar o acesso), contatos, catálogo só leitura e aprovar pela fila.",
    cannot: "Métricas, reembolso, liberar Pix, exportar e conexões.",
  },
  traffic: {
    label: "Tráfego",
    can: "Métricas, relatório de vendas sem comprador, Pixel das ofertas e catálogo só leitura.",
    cannot: "Pedidos com dados do comprador, contatos e conexões.",
  },
};

export const roleLabel = (role: string): string => ROLE_INFO[role as MemberRole]?.label ?? role;
