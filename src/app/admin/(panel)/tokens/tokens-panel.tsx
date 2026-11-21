"use client";

// Tokens MCP: lista, criação e revogação. O token recém-criado vive SÓ no estado deste componente (nada de cookie, URL,
// localStorage nem log): some ao sair da página ou ao clicar "Pronto". Sem regra de negócio: tudo passa pelas actions.
import { useEffect, useRef, useState } from "react";
import { Art, Badge } from "../../blocks";
import s from "../../panel.module.css";
import { CopyField, Dialog, Live, useActionRunner } from "../../ui";
import { createMcpTokenAction, revokeMcpTokenAction } from "../actions";

export interface TokenRow {
  id: string;
  name: string;
  role: string;
  last4: string;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type TokenRole = "reader" | "traffic" | "support" | "admin" | "owner";

const ROLES: Array<{ value: TokenRole; label: string; text: string }> = [
  { value: "reader", label: "Leitor", text: "lê produtos, ofertas, métricas e o relatório de vendas pagas" },
  { value: "traffic", label: "Tráfego", text: "Leitor + avisos da loja, estado das conexões (sem chaves) e configurações" },
  { value: "support", label: "Suporte", text: "consulta pedidos (comprador mascarado), produtos, ofertas e o relatório de vendas pagas" },
  { value: "admin", label: "Admin", text: "consulta tudo que o MCP oferece hoje" },
  { value: "owner", label: "Dono", text: "igual ao Admin por enquanto; prefira Admin" },
];
const ROLE_NAME = Object.fromEntries(ROLES.map((r) => [r.value, r.label])) as Record<string, string>;

interface Created {
  token: string;
  name: string;
}

export function TokensPanel({ tokens, mcpUrl }: { tokens: TokenRow[]; mcpUrl: string }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<TokenRole>("reader");
  const [created, setCreated] = useState<Created | null>(null);
  const [target, setTarget] = useState<TokenRow | null>(null);
  const create = useActionRunner();
  const revoke = useActionRunner();
  const box = useRef<HTMLDivElement>(null);
  // Abrir ou fechar o diálogo sem revogar limpa o erro da tentativa anterior.
  const openRevoke = (t: TokenRow) => {
    revoke.setMsg(null);
    setTarget(t);
  };
  const closeRevoke = () => {
    revoke.setMsg(null);
    setTarget(null);
  };

  // Leitor de tela e teclado: o foco vai para o quadro do token assim que ele aparece (é a única chance de copiá-lo).
  useEffect(() => {
    if (created) box.current?.focus();
  }, [created]);

  return (
    <>
      <div className={s.stack}>
        {created ? (
          <section className={s.card} aria-labelledby="token-novo">
            <div className={s.stack} ref={box} tabIndex={-1} style={{ outline: "none" }}>
              <h2 id="token-novo" className={s.sectionTitle}>
                Token “{created.name}” criado
              </h2>
              <p role="alert" style={{ margin: 0, fontWeight: 600 }}>
                Copie agora: o token não aparece de novo.
              </p>
              <div className={s.field}>
                <span className={s.label}>Token</span>
                <CopyField text={created.token} />
              </div>
              <div className={s.field}>
                <span className={s.label}>Endereço do MCP</span>
                <CopyField text={mcpUrl} />
                <span className={s.hint}>
                  No cliente MCP, use este endereço e o cabeçalho <code className={s.mono}>Authorization: Bearer &lt;token&gt;</code>.
                </span>
              </div>
              <div className={s.formActions}>
                <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setCreated(null)}>
                  Pronto
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <section className={s.card} aria-labelledby="token-criar">
          <form
            className={s.stack}
            onSubmit={async (e) => {
              e.preventDefault();
              // Em erro, o quadro do token anterior (se ainda aberto) continua: ele não aparece de novo.
              await create.run(() => createMcpTokenAction({ name: name.trim(), role }), {
                onOk: (d) => {
                  const data = d as { token: string; name: string };
                  setCreated({ token: data.token, name: data.name });
                  setName("");
                  setRole("reader");
                },
              });
            }}
          >
            <h2 id="token-criar" className={s.sectionTitle}>
              Criar token
            </h2>
            <label className={s.field}>
              <span className={s.label}>Nome do token</span>
              <input className={s.input} value={name} required maxLength={60} placeholder="Ex.: Claude da loja" onChange={(e) => setName(e.target.value)} />
              <span className={s.hint}>Só para você reconhecer o agente na lista.</span>
            </label>
            <fieldset className={s.field} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend className={s.label}>Papel</legend>
              {ROLES.map((r) => (
                <label key={r.value} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                  <input type="radio" name="token-role" value={r.value} checked={role === r.value} onChange={() => setRole(r.value)} style={{ marginTop: 3 }} />
                  <span>
                    <b>{r.label}</b> <span className={s.muted}>— {r.text}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className={s.formActions}>
              <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={create.pending || name.trim() === ""}>
                {create.pending ? "Criando…" : "Criar token"}
              </button>
            </div>
            <Live msg={create.msg} />
          </form>
        </section>

        <section className={s.card} aria-labelledby="token-lista">
          <h2 id="token-lista" className={s.sectionTitle}>
            Tokens da loja
          </h2>
          {tokens.length === 0 ? (
            <div className={s.emptyInline}>
              <Art name="agentes" size={88} />
              <p className={s.muted}>Nenhum token ainda. Crie um para conectar um agente de IA à loja.</p>
            </div>
          ) : (
            <div className={s.rows}>
              {tokens.map((t) => (
                <div className={s.row} key={t.id}>
                  <span>
                    <b>{t.name}</b> {t.revokedAt ? <Badge tone="neutral">Revogado</Badge> : <Badge tone="info">{ROLE_NAME[t.role] ?? t.role}</Badge>}{" "}
                    <code className={s.mono}>fnl_…{t.last4}</code>
                    <br />
                    <small className={s.muted}>
                      {t.revokedAt ? `${ROLE_NAME[t.role] ?? t.role} · ` : ""}
                      Criado em {t.createdAt}
                      {t.createdBy ? ` por ${t.createdBy}` : ""} · {t.lastUsedAt ? `último uso em ${t.lastUsedAt}` : "nunca usado"}
                      {t.revokedAt ? ` · revogado em ${t.revokedAt}` : ""}
                    </small>
                  </span>
                  {t.revokedAt ? null : (
                    <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => openRevoke(t)} aria-label={`Revogar o token ${t.name}`}>
                      Revogar
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <Live msg={target ? null : revoke.msg} />
        </section>
      </div>

      <Dialog
        open={target !== null}
        onClose={closeRevoke}
        icon="lock"
        tone="danger"
        title={`Revogar o token ${target?.name ?? ""}?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={closeRevoke} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              disabled={revoke.pending}
              onClick={async () => {
                if (!target) return;
                const r = await revoke.run(() => revokeMcpTokenAction(target.id));
                if (r.ok) setTarget(null);
              }}
            >
              {revoke.pending ? "Revogando…" : "Revogar"}
            </button>
          </>
        }
      >
        <p>O agente perde o acesso na hora.</p>
        {revoke.msg?.tone === "error" ? <Live msg={revoke.msg} /> : null}
      </Dialog>
    </>
  );
}
