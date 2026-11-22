"use client";

// Tokens MCP: botão "Novo token" (modal com nome e papel; depois de criar, o mesmo modal mostra o token uma única vez),
// tabela dos tokens e revogação. O token recém-criado vive SÓ no estado deste componente (nada de cookie, URL,
// localStorage nem log): some ao fechar o modal. Sem regra de negócio: tudo passa pelas actions.
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { SortableDataTable } from "@/components/arc/sortable-data-table/sortable-data-table";
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
  /** Carimbos para ordenar as colunas de data (o texto "dd/mm/aaaa" ordenaria pelo dia do mês). */
  createdTs: number;
  lastUsedTs: number;
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

/** Botão do topo da página e o modal de criação. */
export function NewTokenButton({ mcpUrl }: { mcpUrl: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<TokenRole>("reader");
  const [created, setCreated] = useState<Created | null>(null);
  const create = useActionRunner();
  const box = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    // O token some ao fechar: ele não aparece de novo (por isso o aviso em destaque).
    setCreated(null);
    setName("");
    setRole("reader");
    create.setMsg(null);
  };
  // Leitor de tela e teclado: o foco vai para o quadro do token assim que ele aparece (é a única chance de copiá-lo).
  useEffect(() => {
    if (created) box.current?.focus();
  }, [created]);

  return (
    <>
      <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setOpen(true)}>
        <Plus size={16} strokeWidth={2} aria-hidden="true" />
        Novo token
      </button>
      <Dialog
        open={open}
        onClose={close}
        // Com o token na tela, só "Pronto" fecha: um Esc ou clique fora sem querer perderia o token para sempre.
        dismissable={!created}
        title={created ? `Token “${created.name}” criado` : "Novo token"}
        footer={
          created ? (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={close}>
              Pronto
            </button>
          ) : (
            <>
              <button type="button" className={s.btn} onClick={close}>
                Cancelar
              </button>
              <button type="submit" form="token-form" className={`${s.btn} ${s.btnPrimary}`} disabled={create.pending || name.trim() === ""}>
                {create.pending ? "Criando…" : "Criar token"}
              </button>
            </>
          )
        }
      >
        {created ? (
          <div className={s.stack} ref={box} tabIndex={-1} style={{ outline: "none" }}>
            <p role="alert" className={s.tokenWarn}>
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
          </div>
        ) : (
          <form
            id="token-form"
            className={s.stack}
            onSubmit={async (e) => {
              e.preventDefault();
              await create.run(() => createMcpTokenAction({ name: name.trim(), role }), {
                onOk: (d) => {
                  const data = d as { token: string; name: string };
                  setCreated({ token: data.token, name: data.name });
                },
              });
            }}
          >
            <label className={s.field}>
              <span className={s.label}>Nome do token</span>
              <input className={s.input} value={name} required maxLength={60} placeholder="Ex.: Claude da loja" onChange={(e) => setName(e.target.value)} data-autofocus />
              <span className={s.hint}>Só para você reconhecer o agente na lista.</span>
            </label>
            <fieldset className={s.roleList}>
              <legend className={s.label}>Papel</legend>
              {ROLES.map((r) => (
                <label key={r.value} className={s.roleOption}>
                  <input type="radio" name="token-role" value={r.value} checked={role === r.value} onChange={() => setRole(r.value)} />
                  <span>
                    <b>{r.label}</b>
                    <small>{r.text}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <Live msg={create.msg} />
          </form>
        )}
      </Dialog>
    </>
  );
}

/** Tabela dos tokens da loja com a revogação. */
export function TokensTable({ tokens }: { tokens: TokenRow[] }) {
  const [target, setTarget] = useState<TokenRow | null>(null);
  const revoke = useActionRunner();
  // Abrir ou fechar o diálogo sem revogar limpa o erro da tentativa anterior.
  const openRevoke = (t: TokenRow) => {
    revoke.setMsg(null);
    setTarget(t);
  };
  const closeRevoke = () => {
    revoke.setMsg(null);
    setTarget(null);
  };

  return (
    <section className={`${s.card} ${s.cardFlush}`} aria-label="Tokens da loja">
      {tokens.length === 0 ? (
        <div className={s.empty}>
          <Art name="agentes" size={96} />
          <h2>Nenhum token ainda</h2>
          <p>Crie um token para conectar um agente de IA à loja.</p>
        </div>
      ) : (
        <div className={s.arcTable}>
          <SortableDataTable<TokenRow & Record<string, unknown>>
            rows={tokens as Array<TokenRow & Record<string, unknown>>}
            rowKey="id"
            caption="Tokens da loja"
            itemName={{ one: "token", other: "tokens" }}
            columns={[
              {
                key: "name",
                label: "Token",
                render: (_, t) => (
                  <span className={s.leadCell}>
                    <b>{t.name}</b>
                    <small className={s.mono}>fnl_…{t.last4}</small>
                  </span>
                ),
              },
              { key: "role", label: "Papel", render: (_, t) => (t.revokedAt ? <Badge tone="neutral">Revogado</Badge> : <Badge tone="info">{ROLE_NAME[t.role] ?? t.role}</Badge>) },
              { key: "lastUsedTs", label: "Último uso", render: (_, t) => <span className={`${s.muted} ${s.nowrap}`}>{t.revokedAt ? `revogado em ${t.revokedAt}` : (t.lastUsedAt ?? "nunca")}</span> },
              {
                key: "createdTs",
                label: "Criado",
                render: (_, t) => (
                  <span className={s.leadCell}>
                    <span className={`${s.muted} ${s.nowrap}`}>{t.createdAt}</span>
                    {t.createdBy ? <small>por {t.createdBy}</small> : null}
                  </span>
                ),
              },
              {
                key: "id",
                label: "Ações",
                sortable: false,
                render: (_, t) =>
                  t.revokedAt ? null : (
                    <button type="button" className={`${s.btn} ${s.btnSm}`} onClick={() => openRevoke(t)} aria-label={`Revogar o token ${t.name}`}>
                      Revogar
                    </button>
                  ),
              },
            ]}
          />
        </div>
      )}
      <Live msg={target ? null : revoke.msg} />
      <Dialog
        open={target !== null}
        onClose={closeRevoke}
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
    </section>
  );
}
