// Entrada de `store.updateSettings` a partir do formulário das Configurações (puro: usado no navegador e nos testes).

export interface SettingsForm {
  name: string;
  notifyEmail: string;
  color: string;
  leadCapture: boolean;
  privacyEmail: string;
  recovery: { on: boolean; lead: boolean; pix: boolean; card: boolean };
  acceptCnpj: boolean;
}

/**
 * `acceptCnpj` só vai quando a pessoa mexeu no interruptor (difere do que a página carregou): uma aba antiga salvando
 * outra coisa (ex.: a cor) não religa nem desliga o CNPJ. Omitido, a ação mantém o valor gravado.
 */
export function settingsPayload(f: SettingsForm, saved: Pick<SettingsForm, "acceptCnpj">) {
  return {
    name: f.name.trim(),
    notifyEmail: f.notifyEmail.trim() || null,
    brandColor: f.color ? f.color.toUpperCase() : null,
    leadCapture: f.leadCapture,
    privacyEmail: f.privacyEmail.trim() || null,
    recovery: f.recovery,
    ...(f.acceptCnpj !== saved.acceptCnpj ? { acceptCnpj: f.acceptCnpj } : {}),
  };
}
