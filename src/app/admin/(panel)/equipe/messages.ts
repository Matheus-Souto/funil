// Mensagens do resultado do envio do convite. Montadas na tela (a resposta da server action não traz o e-mail do convidado).
export const inviteSentText = (email: string) => `Convite enviado para ${email}`;

export const notSentText = (prefix: "Convite criado" | "Link novo criado", reason: string | undefined) =>
  `${prefix}, mas o e-mail não saiu: ${(reason ?? "o provedor não respondeu").replace(/[.\s]+$/, "")}. Confira Conexões e clique em Reenviar.`;
