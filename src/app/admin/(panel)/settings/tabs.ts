// Abas das Configurações (usadas pela página no servidor e pelo painel no navegador).
export const SETTINGS_TABS = [
  ["loja", "Loja"],
  ["checkout", "Checkout"],
  ["contatos", "Contatos e recuperação"],
  ["pagina", "Página de vendas"],
  ["equipe", "Equipe"],
  ["entrega", "Entrega"],
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number][0];
