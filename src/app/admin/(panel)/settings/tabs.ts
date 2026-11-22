// Abas das Configurações (usadas pela página no servidor e pelo painel no navegador). A equipe tem página própria
// (/admin/equipe); o link antigo `?aba=equipe` redireciona para lá.
export const SETTINGS_TABS = [
  ["loja", "Loja"],
  ["checkout", "Checkout"],
  ["contatos", "Contatos e recuperação"],
  ["pagina", "Página de vendas"],
  ["entrega", "Entrega"],
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number][0];
