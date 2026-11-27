"use client";

// Conexões (P14): cada integração é uma linha (logo, nome, status) e o botão abre um modal com o formulário. Salvar
// qualquer conexão é sensível: sempre passa por um diálogo de confirmação. Segredos nunca chegam aqui (só
// "configurado"); o token do webhook do Asaas aparece para quem pode alterar conexões.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mail, Plug } from "lucide-react";
import { Dialog as ArcDialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Badge } from "../../blocks";
import { CONNECTION_BRANDS } from "../../brand-icons";
import { PIcon } from "../../icons";
import s from "../../panel.module.css";
import { CopyField, Dialog, Live, SecretField, useActionRunner } from "../../ui";
import {
  createIntegrationKeyAction,
  revokeIntegrationKeyAction,
  rotateAppWebhookSecretAction,
  saveAppWebhookAction,
  testAppWebhookAction,
  saveAsaasAction,
  saveMetaAction,
  savePixManualAction,
  saveResendAction,
  saveSmtpAction,
  saveTelegramAction,
  setEmailProviderAction,
  testMetaAction,
  testResendAction,
  removeTelegramAction,
  testSmtpAction,
  testTelegramAction,
} from "../actions";

type Runner = ReturnType<typeof useActionRunner>;

type Logo = keyof typeof CONNECTION_BRANDS | "smtp" | "app";

/** Logo da integração (Simple Icons; SMTP e o app da loja são genéricos). */
function ConnLogo({ name }: { name: Logo }) {
  if (name === "smtp" || name === "app") {
    const Icon = name === "smtp" ? Mail : Plug;
    return (
      <span className={s.connLogo}>
        <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
      </span>
    );
  }
  const b = CONNECTION_BRANDS[name];
  // Logo preto (Resend) segue a cor do texto, para aparecer no tema escuro; o Asaas usa o ícone deles (A branco no azul).
  const color = b.hex === "#000000" ? "var(--color-text)" : b.hex;
  const style = name === "asaas" ? { color: "#fff", background: b.hex } : { color, background: `color-mix(in srgb, ${color} 12%, transparent)` };
  return (
    <span className={s.connLogo} style={style}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={b.path} />
      </svg>
    </span>
  );
}

/**
 * Linha de uma conexão: logo, nome, resumo, status e o botão que abre o modal com o formulário (`children`). O `id`
 * fica no modal, para os testes acharem os campos de cada conexão.
 */
function ConnItem({
  id,
  logo,
  name,
  title,
  sub,
  summary,
  on,
  onLabel,
  warn = false,
  canWrite,
  locked = false,
  onClosed,
  children,
}: {
  id: string;
  logo: Logo;
  name: string;
  title: string;
  sub: string;
  summary?: string | null;
  on: boolean;
  onLabel?: string;
  warn?: boolean;
  canWrite: boolean;
  /** true: Esc, clique fora e X não fecham o modal (ex.: um segredo na tela que não aparece de novo). */
  locked?: boolean;
  /** Chamado quando o modal fecha (ex.: esquecer um segredo mostrado). */
  onClosed?: () => void;
  children: ReactNode;
}) {
  // Link direto (ex.: /admin/connections#meta, dos Primeiros passos) já abre o modal dessa conexão. O portal do modal
  // só monta no cliente, então abrir no primeiro render não muda o HTML do servidor.
  const [open, setOpen] = useState(() => typeof window !== "undefined" && window.location.hash === `#${id}`);
  const action = canWrite ? (on ? "Configurar" : "Conectar") : "Ver";
  return (
    <div className={s.connRow}>
      <ConnLogo name={logo} />
      <div className={s.connRowText}>
        <b>{name}</b>
        <small>{on && summary ? summary : sub}</small>
      </div>
      <Badge tone={on ? (warn ? "warning" : "success") : "neutral"}>{on ? (onLabel ?? "Conectado") : "Não conectado"}</Badge>
      <button type="button" className={`${s.btn} ${s.btnSm} ${canWrite && !on ? s.btnPrimary : ""}`} onClick={() => setOpen(true)} aria-label={`${action} ${name}`}>
        {action}
      </button>
      <ArcDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && locked) return;
          setOpen(next);
          if (!next) onClosed?.();
        }}
      >
        <DialogContent
          id={id}
          title={title}
          description={sub}
          className={`${s.themeVars} ${s.connDialog}`}
          showClose={!locked}
          onEscapeKeyDown={(e) => locked && e.preventDefault()}
          onPointerDownOutside={(e) => locked && e.preventDefault()}
        >
          {children}
        </DialogContent>
      </ArcDialog>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className={s.row}>
      <span>{k}</span>
      <span>{children}</span>
    </div>
  );
}

const Configured = () => (
  <span style={{ color: "var(--color-success)", display: "inline-flex", gap: 6, alignItems: "center" }}>
    <PIcon name="lock" size={14} />
    configurado
  </span>
);

/** Diálogo de confirmação comum a todo "Salvar" de conexão. */
function ConfirmSave({ open, onClose, title, children, run, onConfirm, label = "Salvar", pendingLabel = "Testando e salvando…" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; run: Runner; onConfirm: () => void; label?: string; pendingLabel?: string }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className={s.btn} onClick={onClose} data-autofocus>
            Cancelar
          </button>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={onConfirm} disabled={run.pending}>
            {run.pending ? pendingLabel : label}
          </button>
        </>
      }
    >
      {children}
      {run.msg?.tone === "error" ? <Live msg={run.msg} /> : null}
    </Dialog>
  );
}

type EmailProvider = "smtp" | "resend";
const PROVIDER_LABEL: Record<EmailProvider, string> = { smtp: "SMTP", resend: "Resend" };

/** Selo do cartão de e-mail: o ativo só fica verde quando consegue enviar; ativo inutilizável vira aviso. */
const providerBadge = (active: boolean, usable: boolean) =>
  active ? (usable ? { onLabel: "Ativo" } : { onLabel: "Ativo, com problema", warn: true }) : { onLabel: "Conectado" };

/**
 * Troca o provedor de e-mail ativo da loja. O botão só aparece para quem pode alterar conexões, com o provedor já configurado e
 * ainda inativo (`show`). O componente fica montado mesmo sem o botão: a troca deu certo justamente quando o provedor vira o
 * ativo e o botão some, e a mensagem de sucesso precisa sobreviver a esse refresh.
 */
function UseProvider({ provider, show }: { provider: EmailProvider; show: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  const label = PROVIDER_LABEL[provider];
  return (
    <>
      {show ? (
        <button type="button" className={s.btn} onClick={() => setConfirm(true)}>
          Usar este provedor
        </button>
      ) : null}
      <div style={{ width: "100%" }}>
        <Live msg={confirm ? null : run.msg} />
      </div>
      <ConfirmSave
        open={show && confirm}
        onClose={() => setConfirm(false)}
        title={`Enviar e-mails pelo ${label}?`}
        run={run}
        label="Usar este provedor"
        pendingLabel="Trocando…"
        onConfirm={async () => {
          const r = await run.run(() => setEmailProviderAction(provider));
          if (r.ok) setConfirm(false);
        }}
      >
        <p>Os e-mails de acesso e os avisos de venda passam a sair pelo {label}.</p>
      </ConfirmSave>
    </>
  );
}

// ---- Pix manual ------------------------------------------------------------------------------------------------

export function PixManualCard({ data, canWrite }: { data: { key: string; name: string; city: string } | null; canWrite: boolean }) {
  const [editing, setEditing] = useState(!data);
  const [f, setF] = useState({ key: data?.key ?? "", name: data?.name ?? "", city: data?.city ?? "" });
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  return (
    <ConnItem id="pix-manual-card" logo="pix" name="Pix manual" title="Pix manual" sub="Pix direto na sua chave, liberado por você" summary={data?.key} on={Boolean(data)} canWrite={canWrite}>
      {editing && canWrite ? (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          <div className={s.field}>
            <label className={s.field}>
            <span className={s.label}>Chave Pix</span>
            <input className={s.input} value={f.key} required maxLength={100} onChange={(e) => setF({ ...f, key: e.target.value })} />
            </label>
            <span className={s.hint}>CPF, CNPJ, e-mail, celular (+5511999999999) ou chave aleatória.</span>
          </div>
          <div className={s.grid2}>
            <div className={s.field}>
              <label className={s.field}>
              <span className={s.label}>Nome do recebedor</span>
              <input className={s.input} value={f.name} required maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </label>
              <span className={s.hint}>Como aparece no app do banco.</span>
            </div>
            <div className={s.field}>
              <label className={s.field}>
              <span className={s.label}>Cidade</span>
              <input className={s.input} value={f.city} required maxLength={100} onChange={(e) => setF({ ...f, city: e.target.value })} />
              </label>
              <span className={s.hint}>Exigida pelo padrão do Pix.</span>
            </div>
          </div>
          <div className={s.banner} data-tone="info">
            <PIcon name="info" />
            <div>Cada pedido recebe um valor com centavos diferentes (ex.: R$ 9,93) para você achar no extrato. Pedidos não pagos expiram em 24 h.</div>
          </div>
          <div className={s.formActions}>
            {data ? (
              <button type="button" className={s.btn} onClick={() => setEditing(false)}>
                Cancelar
              </button>
            ) : null}
            <button type="submit" className={`${s.btn} ${s.btnPrimary}`}>
              Salvar chave Pix
            </button>
          </div>
        </form>
      ) : data ? (
        <div className={s.rows}>
          <Row k="Chave Pix">{data.key}</Row>
          <Row k="Nome do recebedor">{data.name}</Row>
          <Row k="Cidade">{data.city}</Row>
          <Row k="Validade do pedido">24 horas</Row>
        </div>
      ) : (
        <p className={s.muted}>Ainda não configurado.</p>
      )}
      {canWrite && data && !editing ? (
        <div className={s.cardFoot}>
          <Live msg={run.msg} />
          <button type="button" className={s.btn} onClick={() => setEditing(true)}>
            Editar
          </button>
        </div>
      ) : (
        <Live msg={editing ? null : run.msg} />
      )}
      <ConfirmSave
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Salvar esta chave Pix?"
        run={run}
        label="Salvar chave"
        onConfirm={async () => {
          const r = await run.run(() => savePixManualAction(f));
          if (r.ok) {
            setConfirm(false);
            setEditing(false);
          }
        }}
      >
        <p>
          Todo Pix manual novo vai para <b>{f.key}</b> ({f.name}). Confira a chave: um erro aqui manda o dinheiro dos compradores para outra conta.
        </p>
      </ConfirmSave>
    </ConnItem>
  );
}

// ---- Asaas ------------------------------------------------------------------------------------------------------

const ASAAS_EVENTS = [
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_REFUND_IN_PROGRESS",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
];

const UNREADABLE_KEY = "A chave salva não pode ser lida; informe a chave de API de novo.";

export function AsaasCard({
  data,
  canWrite,
}: {
  data: { env: "sandbox" | "production"; apiKey: "configured" | "unreadable" | null; webhookUrl: string; webhookToken: string | null } | null;
  canWrite: boolean;
}) {
  const unreadable = data?.apiKey === "unreadable";
  const [env, setEnv] = useState<"sandbox" | "production">(data?.env ?? "sandbox");
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(!data || unreadable);
  const [rotate, setRotate] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  const envLabel = (e: string) => (e === "production" ? "produção" : "sandbox");
  return (
    <ConnItem id="asaas" logo="asaas" name="Asaas" title="Asaas" sub="Pix automático e cartão de crédito" on={Boolean(data)} onLabel={data ? `Conectado · ${envLabel(data.env)}` : undefined} canWrite={canWrite}>
      {canWrite ? (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            if (apiKey.trim().length < 8) {
              run.setMsg({ tone: "error", text: "Cole a chave de API do Asaas." });
              return;
            }
            setConfirm(true);
          }}
        >
          <div className={s.field} role="radiogroup" aria-label="Ambiente do Asaas">
            <span className={s.label}>Ambiente</span>
            <div className={s.segment} style={{ alignSelf: "flex-start" }}>
              <label>
                <input type="radio" name="asaas-env" checked={env === "sandbox"} onChange={() => setEnv("sandbox")} />
                Sandbox (testes)
              </label>
              <label>
                <input type="radio" name="asaas-env" checked={env === "production"} onChange={() => setEnv("production")} />
                Produção
              </label>
            </div>
          </div>
          {replacing || !data || env !== data.env ? (
            <div className={s.field}>
              <label className={s.field}>
              <span className={s.label}>Chave de API</span>
              <input className={`${s.input} ${s.mono}`} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="$aact_…" />
              </label>
              {unreadable ? <span className={s.hint}>{UNREADABLE_KEY}</span> : null}
              <span className={s.hint}>No Asaas: Integrações → Chaves de API. A chave é testada antes de salvar.</span>
            </div>
          ) : (
            <div className={s.row} style={{ borderBottom: 0 }}>
              <span>Chave de API</span>
              <span>
                <Configured />{" "}
                <button type="button" className={s.linkBtn} onClick={() => setReplacing(true)}>
                  Substituir
                </button>
              </span>
            </div>
          )}
          {data ? (
            <label className={s.switch} style={{ fontWeight: 500 }}>
              <input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} />
              Gerar um token de webhook novo (o atual para de valer)
            </label>
          ) : null}
          {replacing || !data || env !== data.env || rotate ? (
            <div className={s.formActions}>
              <button type="submit" className={`${s.btn} ${s.btnPrimary}`}>
                {data ? "Salvar" : "Conectar Asaas"}
              </button>
            </div>
          ) : null}
        </form>
      ) : data ? (
        <div className={s.rows}>
          <Row k="Ambiente">{envLabel(data.env)}</Row>
          <Row k="Chave de API">{unreadable ? UNREADABLE_KEY : data.apiKey ? <Configured /> : "—"}</Row>
        </div>
      ) : (
        <p className={s.muted}>Ainda não conectado.</p>
      )}

      {data ? (
        <div className={s.card} style={{ marginTop: 16, background: "var(--color-bg)" }}>
          <h3 className={s.h2} style={{ marginBottom: 12 }}>
            Cole no Asaas: Integrações → Webhooks
          </h3>
          <div className={s.stack} style={{ gap: 10 }}>
            <div className={s.field}>
              <span className={s.label}>URL do webhook</span>
              <CopyField text={data.webhookUrl} />
            </div>
            <div className={s.field}>
              <span className={s.label}>Token de autenticação</span>
              {data.webhookToken ? <SecretField value={data.webhookToken} label="Token de autenticação do webhook" /> : <Configured />}
            </div>
            <details>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Como configurar no Asaas</summary>
              <ol className={s.checklist}>
                <li>No Asaas ({envLabel(data.env)}), abra Integrações → Webhooks → Adicionar.</li>
                <li>Cole a URL e o token acima. Versão da API: v3. Tipo de envio: sequencial.</li>
                <li>
                  Em eventos de cobrança, marque pelo menos: <span className={s.mono}>{ASAAS_EVENTS.join(", ")}</span>.
                </li>
                <li>Deixe o webhook ativo e a fila de sincronização ligada.</li>
                <li>
                  Se o Asaas pausar a fila (falhas seguidas, por exemplo chave recusada), corrija aqui e depois <b>reative a fila</b> em Integrações →
                  Webhooks: o Asaas só reenvia os pagamentos pendentes depois disso.
                </li>
              </ol>
            </details>
            <p className={s.hint} style={{ margin: 0 }}>
              Por segurança, cada aviso do Asaas é conferido na API antes de mudar o pedido.
            </p>
          </div>
        </div>
      ) : null}
      <Live msg={confirm ? null : run.msg} />
      <ConfirmSave
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Conectar o Asaas em ${envLabel(env)}?`}
        run={run}
        label="Testar e salvar"
        onConfirm={async () => {
          const r = await run.run(() => saveAsaasAction({ env, apiKey: apiKey.trim(), ...(rotate ? { rotateWebhookToken: true } : {}) }));
          if (r.ok) {
            setConfirm(false);
            setApiKey("");
            setReplacing(false);
            setRotate(false);
          }
        }}
      >
        <p>
          Os pagamentos pelo Asaas vão para esta conta. A chave é testada no Asaas antes de salvar. Se for outra conta, as cobranças abertas da conta anterior
          são descartadas.{rotate ? " O token do webhook muda: atualize-o no Asaas." : ""}
        </p>
      </ConfirmSave>
    </ConnItem>
  );
}

// ---- SMTP -------------------------------------------------------------------------------------------------------

export function SmtpCard({
  data,
  canWrite,
  defaultTo,
  active,
  usable,
}: {
  data: { host: string; port: number; secure: boolean; user: string | null; from: string; password: "configured" | null } | null;
  canWrite: boolean;
  defaultTo: string;
  active: boolean;
  /** O provedor ativo consegue enviar (`connectionsStatus.emailUsable`). */
  usable: boolean;
}) {
  const [editing, setEditing] = useState(!data);
  const [f, setF] = useState({ host: data?.host ?? "", port: String(data?.port ?? 587), secure: data?.secure ?? false, user: data?.user ?? "", password: "", from: data?.from ?? "" });
  const [to, setTo] = useState(defaultTo);
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  const test = useActionRunner();
  return (
    <ConnItem id="smtp" logo="smtp" name="SMTP" title="E-mail (SMTP)" sub="Envia o acesso ao comprador e o aviso de venda" summary={data?.from} on={Boolean(data)} {...providerBadge(active, usable)} canWrite={canWrite}>
      {editing && canWrite ? (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          <div className={s.formGrid}>
            <label className={s.field}>
              <span className={s.label}>Servidor</span>
              <input className={`${s.input} ${s.mono}`} value={f.host} required onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp-relay.brevo.com" />
            </label>
            <label className={s.field}>
              <span className={s.label}>Porta</span>
              <input className={s.input} value={f.port} required inputMode="numeric" onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, "") })} />
            </label>
          </div>
          <label className={s.switch} style={{ fontWeight: 500 }}>
            <input type="checkbox" checked={f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} />
            Conexão SSL/TLS direta (porta 465)
          </label>
          <div className={s.grid2}>
            <label className={s.field}>
              <span className={s.label}>Usuário</span>
              <input className={s.input} value={f.user} autoComplete="off" onChange={(e) => setF({ ...f, user: e.target.value })} />
            </label>
            <label className={s.field}>
              <span className={s.label}>Senha</span>
              <input
                className={s.input}
                type="password"
                autoComplete="new-password"
                value={f.password}
                placeholder={data?.password ? "configurado: deixe em branco para manter" : ""}
                onChange={(e) => setF({ ...f, password: e.target.value })}
              />
            </label>
          </div>
          <label className={s.field}>
            <span className={s.label}>Remetente (e-mail)</span>
            <input className={s.input} type="email" value={f.from} required onChange={(e) => setF({ ...f, from: e.target.value })} />
          </label>
          <div className={s.formActions}>
            {data ? (
              <button type="button" className={s.btn} onClick={() => setEditing(false)}>
                Cancelar
              </button>
            ) : null}
            <button type="submit" className={`${s.btn} ${s.btnPrimary}`}>
              Testar e salvar
            </button>
          </div>
        </form>
      ) : data ? (
        <div className={s.rows}>
          <Row k="Servidor">
            <span className={s.mono}>
              {data.host}:{data.port}
            </span>
          </Row>
          <Row k="Usuário">{data.user ?? "—"}</Row>
          <Row k="Senha">{data.password ? <Configured /> : "—"}</Row>
          <Row k="Remetente">{data.from}</Row>
        </div>
      ) : (
        <p className={s.muted}>Ainda não configurado.</p>
      )}
      <Live msg={confirm ? null : run.msg} />
      {canWrite && data ? (
        <div className={s.cardFoot}>
          <form
            style={{ display: "flex", gap: 8, flex: 1, flexWrap: "wrap", alignItems: "center" }}
            onSubmit={(e) => {
              e.preventDefault();
              void test.run(() => testSmtpAction(to.trim()), { refresh: false });
            }}
          >
            <label className={s.srOnly} htmlFor="smtp-test-to">
              Enviar e-mail de teste para
            </label>
            <input id="smtp-test-to" className={s.input} style={{ flex: "1 1 180px", minHeight: 36 }} type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
            <button type="submit" className={s.btn} disabled={test.pending}>
              {test.pending ? "Enviando…" : "Enviar teste"}
            </button>
          </form>
          {!editing ? (
            <button type="button" className={s.btn} onClick={() => setEditing(true)}>
              Editar
            </button>
          ) : null}
          <UseProvider provider="smtp" show={!active} />
          <div style={{ width: "100%" }}>
            <Live msg={test.msg} />
          </div>
        </div>
      ) : null}
      <ConfirmSave
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Salvar o SMTP da loja?"
        run={run}
        label="Testar e salvar"
        onConfirm={async () => {
          const r = await run.run(() =>
            saveSmtpAction({
              host: f.host.trim(),
              port: Number(f.port),
              secure: f.secure,
              ...(f.user.trim() ? { user: f.user.trim() } : {}),
              ...(f.password ? { password: f.password } : {}),
              from: f.from.trim(),
            }),
          );
          if (r.ok) {
            setConfirm(false);
            setEditing(false);
            setF((x) => ({ ...x, password: "" }));
          }
        }}
      >
        <p>
          Os e-mails de acesso e os avisos de venda passam a sair por <b>{f.host}</b> com o remetente <b>{f.from}</b>. A conexão é testada antes de salvar.
        </p>
      </ConfirmSave>
    </ConnItem>
  );
}

// ---- Resend -----------------------------------------------------------------------------------------------------

type ResendData = {
  fromEmail: string;
  fromName: string | null;
  /** `configured` para quem não tem connections.write (os finais só vão para quem pode alterar a conexão). */
  apiKey: { last4: string } | "configured" | "unreadable" | null;
  webhookSecret: { last4: string } | "configured" | null;
  webhookUrl: string;
};

const RESEND_EVENTS = "email.delivered, email.bounced e email.complained";
const last4Of = (v: { last4: string } | "configured" | "unreadable" | null | undefined) => (typeof v === "object" && v !== null ? v.last4 : null);

/** Cada loja usa a própria conta do Resend. Chave e segredo do webhook nunca voltam do servidor: só os 4 últimos caracteres. */
export function ResendCard({
  data,
  canWrite,
  defaultTo,
  storeName,
  active,
  usable,
}: {
  data: ResendData | null;
  canWrite: boolean;
  defaultTo: string;
  storeName: string;
  active: boolean;
  /** O provedor ativo consegue enviar (`connectionsStatus.emailUsable`). */
  usable: boolean;
}) {
  const [editing, setEditing] = useState(!data);
  const [f, setF] = useState({ fromEmail: data?.fromEmail ?? "", fromName: data?.fromName ?? "", apiKey: "", webhookSecret: "" });
  const [to, setTo] = useState(defaultTo);
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  const test = useActionRunner();
  const keyLast4 = last4Of(data?.apiKey);
  const needsKey = !data || data.apiKey === null || data.apiKey === "unreadable";
  const keep = (last4: string | null) => (last4 ? `configurado (final ${last4}): deixe em branco para manter` : "");
  return (
    <ConnItem id="resend" logo="resend" name="Resend" title="E-mail (Resend)" sub="Envia o acesso ao comprador e o aviso de venda pela sua conta do Resend" summary={data?.fromEmail} on={Boolean(data)} {...providerBadge(active, usable)} canWrite={canWrite}>
      {editing && canWrite ? (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          <div className={s.grid2}>
            <label className={s.field}>
              <span className={s.label}>Remetente (e-mail)</span>
              <input className={s.input} type="email" value={f.fromEmail} required onChange={(e) => setF({ ...f, fromEmail: e.target.value })} placeholder="vendas@seudominio.com.br" />
            </label>
            <label className={s.field}>
              <span className={s.label}>Nome do remetente (opcional)</span>
              <input className={s.input} value={f.fromName} maxLength={100} onChange={(e) => setF({ ...f, fromName: e.target.value })} placeholder={storeName} />
            </label>
          </div>
          <label className={s.field}>
            <span className={s.label}>Chave de API</span>
            <input
              className={`${s.input} ${s.mono}`}
              type="password"
              autoComplete="new-password"
              value={f.apiKey}
              required={needsKey}
              placeholder={keep(keyLast4) || "re_…"}
              onChange={(e) => setF({ ...f, apiKey: e.target.value })}
            />
            {data?.apiKey === "unreadable" ? <span className={s.hint}>A chave salva não pode ser lida: cole a chave de novo.</span> : null}
            <span className={s.hint}>No Resend: API Keys → Create API Key, com permissão só de envio.</span>
          </label>
          <label className={s.field}>
            <span className={s.label}>Segredo do webhook</span>
            <input
              className={`${s.input} ${s.mono}`}
              type="password"
              autoComplete="new-password"
              value={f.webhookSecret}
              placeholder={keep(last4Of(data?.webhookSecret)) || "whsec_…"}
              onChange={(e) => setF({ ...f, webhookSecret: e.target.value })}
            />
            <span className={s.hint}>Opcional, mas sem ele o painel não recebe a entrega nem a devolução dos e-mails.</span>
          </label>
          <div className={s.formActions}>
            {data ? (
              <button type="button" className={s.btn} onClick={() => setEditing(false)}>
                Cancelar
              </button>
            ) : null}
            <button type="submit" className={`${s.btn} ${s.btnPrimary}`}>
              Salvar
            </button>
          </div>
        </form>
      ) : data ? (
        <div className={s.rows}>
          <Row k="Remetente">{data.fromName ? `${data.fromName} <${data.fromEmail}>` : data.fromEmail}</Row>
          <Row k="Chave">
            {data.apiKey === "unreadable" ? "ilegível: cole a chave de novo" : data.apiKey === "configured" ? <Configured /> : data.apiKey ? `final ${data.apiKey.last4}` : "—"}
          </Row>
          <Row k="Webhook">{data.webhookSecret === "configured" ? <Configured /> : data.webhookSecret ? `final ${data.webhookSecret.last4}` : "não configurado"}</Row>
        </div>
      ) : (
        <p className={s.muted}>Ainda não configurado.</p>
      )}
      {data && canWrite ? (
        <div className={s.card} style={{ marginTop: 16, background: "var(--color-bg)" }}>
          <h3 className={s.h2} style={{ marginBottom: 12 }}>
            Cole no Resend: Webhooks
          </h3>
          <div className={s.stack} style={{ gap: 10 }}>
            <div className={s.field}>
              <span className={s.label}>URL do webhook</span>
              <CopyField text={data.webhookUrl} />
            </div>
            <p className={s.hint} style={{ margin: 0 }}>
              No Resend, crie um webhook com os eventos {RESEND_EVENTS} apontando para este endereço e cole aqui o segredo (whsec_…).
            </p>
          </div>
        </div>
      ) : null}
      <Live msg={confirm ? null : run.msg} />
      {canWrite && data ? (
        <div className={s.cardFoot}>
          <form
            style={{ display: "flex", gap: 8, flex: 1, flexWrap: "wrap", alignItems: "center" }}
            onSubmit={(e) => {
              e.preventDefault();
              void test.run(() => testResendAction(to.trim()), { refresh: false });
            }}
          >
            <label className={s.srOnly} htmlFor="resend-test-to">
              Enviar e-mail de teste para
            </label>
            <input id="resend-test-to" className={s.input} style={{ flex: "1 1 180px", minHeight: 36 }} type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
            <button type="submit" className={s.btn} disabled={test.pending || data.apiKey === "unreadable"}>
              {test.pending ? "Enviando…" : "Enviar teste"}
            </button>
          </form>
          {!editing ? (
            <button type="button" className={s.btn} onClick={() => setEditing(true)}>
              Editar
            </button>
          ) : null}
          <UseProvider provider="resend" show={!active && data.apiKey !== "unreadable"} />
          <div style={{ width: "100%" }}>
            <Live msg={test.msg} />
          </div>
        </div>
      ) : null}
      <ConfirmSave
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Salvar o Resend da loja?"
        run={run}
        label="Salvar"
        pendingLabel="Salvando…"
        onConfirm={async () => {
          const r = await run.run(() =>
            saveResendAction({
              fromEmail: f.fromEmail.trim(),
              fromName: f.fromName.trim(),
              ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}),
              ...(f.webhookSecret.trim() ? { webhookSecret: f.webhookSecret.trim() } : {}),
            }),
          );
          if (r.ok) {
            setConfirm(false);
            setEditing(false);
            setF((x) => ({ ...x, apiKey: "", webhookSecret: "" }));
          }
        }}
      >
        <p>
          Os e-mails enviados pelo Resend saem da sua conta, com o remetente <b>{f.fromEmail}</b>. O domínio do remetente precisa estar verificado no Resend.
          Salvar não troca o provedor ativo: use <b>Usar este provedor</b> para isso.
        </p>
      </ConfirmSave>
    </ConnItem>
  );
}

// ---- Telegram ---------------------------------------------------------------------------------------------------

type TelegramData = {
  chatId: string;
  botUsername: string | null;
  token: { last4: string } | "configured" | "unreadable";
  events: { sale: boolean; pixGenerated: boolean; cardDeclined: boolean; abandoned: boolean; leadAbandoned: boolean };
  abandonAfterMinutes: number;
};

// Mesmos limites de `saveTelegram` (o servidor valida de novo); o módulo dele usa o banco e não vai ao navegador.
const MIN_ABANDON = 10;
const MAX_ABANDON = 1440;

const TELEGRAM_EVENT_OPTIONS = [
  { key: "sale", label: "Venda aprovada" },
  { key: "pixGenerated", label: "Pix gerado" },
  { key: "cardDeclined", label: "Cartão recusado" },
  { key: "abandoned", label: "Carrinho abandonado" },
  { key: "leadAbandoned", label: "Abandono antes do pagamento" },
] as const;

/** Cada loja usa o próprio bot. O token nunca volta do servidor: só os 4 últimos caracteres (ou "configurado"). */
export function TelegramCard({ data, canWrite }: { data: TelegramData | null; canWrite: boolean }) {
  const [editing, setEditing] = useState(!data);
  const [f, setF] = useState({
    token: "",
    chatId: data?.chatId ?? "",
    events: data?.events ?? { sale: true, pixGenerated: false, cardDeclined: false, abandoned: false, leadAbandoned: false },
    minutes: String(data?.abandonAfterMinutes ?? 30),
  });
  const [confirm, setConfirm] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  // O hook só zera a mensagem do próprio runner: guardamos qual ação rodou por último e mostramos a dela.
  const [last, setLast] = useState<"save" | "drop">("save");
  const run = useActionRunner();
  const test = useActionRunner();
  const drop = useActionRunner();
  const tokenLast4 = last4Of(data?.token);
  const needsToken = !data || data.token === "unreadable";
  const enabled = data ? TELEGRAM_EVENT_OPTIONS.filter((o) => data.events[o.key]).map((o) => o.label) : [];
  return (
    <ConnItem id="telegram" logo="telegram" name="Telegram" title="Avisos no Telegram" sub="Envia os avisos da loja ao grupo da equipe pelo seu próprio bot" summary={enabled.length ? `Avisa: ${enabled.join(", ").toLowerCase()}` : null} on={Boolean(data)} canWrite={canWrite}>
      {editing && canWrite ? (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            setConfirm(true);
          }}
        >
          <p className={s.hint} style={{ margin: 0 }}>
            Crie um bot no @BotFather, adicione-o ao grupo da equipe e cole aqui o token. O chat id de um grupo é um número negativo
            (supergrupos começam com -100): para vê-lo, adicione o @RawDataBot ao grupo, copie o id e remova esse bot em seguida. Se o grupo
            virar supergrupo, o id muda e é preciso salvar o novo. As mensagens levam só a oferta, o valor, a forma de pagamento e o código do
            pedido (ou o código do contato, no abandono antes do pagamento): nenhum dado do comprador.
          </p>
          <label className={s.field}>
            <span className={s.label}>Token do bot</span>
            <input
              className={`${s.input} ${s.mono}`}
              type="password"
              autoComplete="new-password"
              value={f.token}
              required={needsToken}
              placeholder={tokenLast4 ? `configurado (final ${tokenLast4}): deixe em branco para manter` : data?.token === "configured" ? "configurado: deixe em branco para manter" : ""}
              onChange={(e) => setF({ ...f, token: e.target.value })}
            />
            {data?.token === "unreadable" ? <span className={s.hint}>O token salvo não pode ser lido: cole o token de novo.</span> : null}
          </label>
          <label className={s.field}>
            <span className={s.label}>Chat id</span>
            <input className={`${s.input} ${s.mono}`} value={f.chatId} required onChange={(e) => setF({ ...f, chatId: e.target.value })} placeholder="-100… ou -…" />
          </label>
          <fieldset className={s.field} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className={s.label}>Avisar quando</legend>
            <div className={s.stack} style={{ gap: 8 }}>
              {TELEGRAM_EVENT_OPTIONS.map((o) => (
                <label key={o.key} className={s.switch} style={{ fontWeight: 500 }}>
                  <input type="checkbox" checked={f.events[o.key]} onChange={(e) => setF({ ...f, events: { ...f.events, [o.key]: e.target.checked } })} />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
          {f.events.abandoned || f.events.leadAbandoned ? (
            <label className={s.field}>
              <span className={s.label}>Avisar abandono depois de (minutos)</span>
              <input
                className={s.input}
                type="number"
                inputMode="numeric"
                min={MIN_ABANDON}
                max={MAX_ABANDON}
                step={1}
                required
                value={f.minutes}
                onChange={(e) => setF({ ...f, minutes: e.target.value })}
              />
              <span className={s.hint}>De {MIN_ABANDON} a {MAX_ABANDON} minutos.</span>
            </label>
          ) : null}
          <div className={s.formActions}>
            {data ? (
              <button type="button" className={s.btn} onClick={() => setEditing(false)}>
                Cancelar
              </button>
            ) : null}
            <button type="submit" className={`${s.btn} ${s.btnPrimary}`}>
              Salvar
            </button>
          </div>
        </form>
      ) : data ? (
        <div className={s.rows}>
          <Row k="Bot">{data.botUsername ? `@${data.botUsername}` : "—"}</Row>
          <Row k="Chat">{data.chatId}</Row>
          <Row k="Token">
            {data.token === "unreadable" ? "ilegível: cole o token de novo" : data.token === "configured" ? <Configured /> : `final ${data.token.last4}`}
          </Row>
          <Row k="Avisos">{enabled.length > 0 ? enabled.join(", ") : "nenhum ligado"}</Row>
          {data.events.abandoned || data.events.leadAbandoned ? <Row k="Abandono">depois de {data.abandonAfterMinutes} min</Row> : null}
        </div>
      ) : (
        <p className={s.muted}>Ainda não configurado.</p>
      )}
      <Live msg={confirm || disconnect ? null : (last === "drop" ? drop.msg : run.msg)} />
      {canWrite && data ? (
        <div className={s.cardFoot}>
          <button type="button" className={s.btn} disabled={test.pending || data.token === "unreadable"} onClick={() => void test.run(() => testTelegramAction(), { refresh: false })}>
            {test.pending ? "Enviando…" : "Enviar teste"}
          </button>
          {!editing ? (
            <button type="button" className={s.btn} onClick={() => setEditing(true)}>
              Editar
            </button>
          ) : null}
          <button type="button" className={`${s.btn} ${s.btnDangerGhost}`} onClick={() => setDisconnect(true)}>
            Desconectar
          </button>
          <div style={{ width: "100%" }}>
            <Live msg={test.msg} />
          </div>
        </div>
      ) : null}
      <ConfirmSave
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Salvar o Telegram da loja?"
        run={run}
        label="Salvar"
        pendingLabel="Salvando…"
        onConfirm={async () => {
          setLast("save");
          const r = await run.run(() =>
            saveTelegramAction({
              chatId: f.chatId.trim(),
              ...(f.token.trim() ? { token: f.token.trim() } : {}),
              events: f.events,
              ...(f.events.abandoned || f.events.leadAbandoned ? { abandonAfterMinutes: Number(f.minutes) } : {}),
            }),
          );
          if (r.ok) {
            setConfirm(false);
            setEditing(false);
            setF((x) => ({ ...x, token: "" }));
          }
        }}
      >
        <p>
          Os avisos passam a ir para o chat <b>{f.chatId}</b> pelo bot. O token é conferido no Telegram antes de salvar.
        </p>
      </ConfirmSave>
      <ConfirmSave
        open={disconnect}
        onClose={() => setDisconnect(false)}
        title="Desconectar o Telegram? Os avisos deixam de ser enviados."
        run={drop}
        label="Desconectar"
        pendingLabel="Desconectando…"
        onConfirm={async () => {
          setLast("drop");
          const r = await drop.run(() => removeTelegramAction());
          if (r.ok) {
            setDisconnect(false);
            setEditing(true);
            setF({ token: "", chatId: "", events: { sale: true, pixGenerated: false, cardDeclined: false, abandoned: false, leadAbandoned: false }, minutes: "30" });
          }
        }}
      >
        <p>Você pode conectar de novo quando quiser, com o mesmo bot ou outro.</p>
      </ConfirmSave>
    </ConnItem>
  );
}

// ---- Meta -------------------------------------------------------------------------------------------------------

/** `canWrite`: trocar Pixel/token da loja (connections.write, só o dono). `canTest`: só testar a conexão (tracking.write). */
export function MetaCard({
  data,
  canWrite,
  canTest = false,
}: {
  data: { pixelId: string; testEventCode: string | null; accessToken: "configured" | null } | null;
  canWrite: boolean;
  canTest?: boolean;
}) {
  const [f, setF] = useState({ pixelId: data?.pixelId ?? "", token: "", testCode: data?.testEventCode ?? "" });
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  const test = useActionRunner();
  return (
    <ConnItem id="meta" logo="meta" name="Meta" title="Meta (Pixel e API de Conversões)" sub="Envia InitiateCheckout e Purchase com o mesmo event_id" summary={data ? `Pixel ${data.pixelId}` : null} on={Boolean(data)} canWrite={canWrite}>
      {canWrite ? (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            if (!/^\d{5,20}$/.test(f.pixelId.trim())) {
              run.setMsg({ tone: "error", text: "Pixel ID: só números (5 a 20)." });
              return;
            }
            setConfirm(true);
          }}
        >
          <div className={s.field}>
            <label className={s.field}>
            <span className={s.label}>Pixel ID</span>
            <input className={`${s.input} ${s.mono}`} value={f.pixelId} inputMode="numeric" onChange={(e) => setF({ ...f, pixelId: e.target.value.trim() })} />
            </label>
            <span className={s.hint}>Use o mesmo Pixel ID de antes para não perder o aprendizado.</span>
          </div>
          <label className={s.field}>
            <span className={s.label}>Token da API de Conversões</span>
            <input
              className={`${s.input} ${s.mono}`}
              type="password"
              autoComplete="off"
              value={f.token}
              placeholder={data?.accessToken ? "configurado: deixe em branco para manter" : "Cole o token gerado no Gerenciador de Eventos"}
              onChange={(e) => setF({ ...f, token: e.target.value })}
            />
          </label>
          <div className={s.field}>
            <label className={s.field}>
            <span className={s.label}>Código de teste (opcional)</span>
            <input className={`${s.input} ${s.mono}`} value={f.testCode} onChange={(e) => setF({ ...f, testCode: e.target.value.trim() })} placeholder="TEST12345" />
            </label>
            <span className={s.hint}>Só para conferir eventos em “Testar eventos”. Apague depois.</span>
          </div>
          <div className={s.cardFoot}>
            <span>{data?.accessToken ? <Configured /> : <span className={s.muted}>Token ainda não salvo</span>}</span>
            <div className={s.headActions}>
              {data?.accessToken ? (
                <button type="button" className={s.btn} disabled={test.pending} onClick={() => test.run(() => testMetaAction(), { refresh: false })}>
                  {test.pending ? "Testando…" : "Testar"}
                </button>
              ) : null}
              <button type="submit" className={`${s.btn} ${s.btnPrimary}`}>
                Salvar
              </button>
            </div>
            <div style={{ width: "100%" }}>
              <Live msg={test.msg ?? (confirm ? null : run.msg)} />
            </div>
          </div>
        </form>
      ) : data ? (
        <div className={s.rows}>
          <Row k="Pixel ID">
            <span className={s.mono}>{data.pixelId}</span>
          </Row>
          <Row k="Token">{data.accessToken ? <Configured /> : "—"}</Row>
          <p className={s.muted} style={{ margin: 0 }}>
            Só o dono da loja troca o Pixel e o token da loja.
          </p>
          {canTest && data.accessToken ? (
            <div className={s.headActions}>
              <button type="button" className={s.btn} disabled={test.pending} onClick={() => test.run(() => testMetaAction(), { refresh: false })}>
                {test.pending ? "Testando…" : "Testar"}
              </button>
              <Live msg={test.msg} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className={s.muted}>Ainda não conectado.</p>
      )}
      <ConfirmSave
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Salvar a conexão com o Meta?"
        run={run}
        label={f.token || data?.accessToken ? "Testar e salvar" : "Salvar"}
        onConfirm={async () => {
          const r = await run.run(() =>
            saveMetaAction({ pixelId: f.pixelId.trim(), ...(f.token.trim() ? { accessToken: f.token.trim() } : {}), ...(f.testCode ? { testEventCode: f.testCode } : {}) }),
          );
          if (r.ok) {
            setConfirm(false);
            setF((x) => ({ ...x, token: "" }));
          }
        }}
      >
        <p>
          As vendas da loja passam a ser enviadas ao Pixel <b className={s.mono}>{f.pixelId}</b>
          {f.token || data?.accessToken ? " (o token é conferido no Meta antes de salvar)" : ""}.
        </p>
      </ConfirmSave>
    </ConnItem>
  );
}

// ---- App (integração) -------------------------------------------------------------------------------------------

export interface AppConnectionData {
  /** `null` para quem não vê a URL (token MCP); no painel, a URL salva. */
  url: string | null;
  returnHosts: string[];
  publicOrigin: string | null;
  secret: "configured" | "unreadable" | null;
}

export interface IntegrationKeyRow {
  id: string;
  name: string;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Segredo ou chave que acabou de aparecer: vive só no estado do cartão e some ao fechar o modal ou em "Já copiei". */
type Reveal = { kind: "secret" | "key"; title: string; value: string };

const hostsText = (hosts: string[]) => hosts.join("\n");
const hostsOf = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((h) => h.trim())
    .filter(Boolean);
const hostOfUrl = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * Cartão do app com conta de usuário (§7.6): o webhook que recebe os avisos de pagamento, os hosts para onde o checkout
 * pode voltar, a origem pública do app (evento de início de teste no Meta), o segredo da assinatura e as chaves da API
 * de integração. O segredo e a chave aparecem uma única vez (no estado deste componente, nunca em URL, cookie ou
 * armazenamento); depois só "configurado". Os runners ficam montados fora dos ramos condicionais: a mensagem de sucesso
 * sobrevive ao refresh que muda o estado do cartão (padrão do `UseProvider`).
 */
export function AppCard({
  data,
  canWrite,
  canManageKeys,
  keys,
  apiBaseUrl,
}: {
  data: AppConnectionData | null;
  canWrite: boolean;
  /** Criar, listar e revogar chaves (team.manage, só o dono). */
  canManageKeys: boolean;
  keys: IntegrationKeyRow[];
  apiBaseUrl: string;
}) {
  const configured = Boolean(data?.url);
  const [editing, setEditing] = useState(!configured);
  const [f, setF] = useState({ url: data?.url ?? "", hosts: hostsText(data?.returnHosts ?? []), origin: data?.publicOrigin ?? "" });
  const [confirm, setConfirm] = useState<"save" | "rotate" | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [keyName, setKeyName] = useState("");
  const [revoking, setRevoking] = useState<IntegrationKeyRow | null>(null);
  const save = useActionRunner();
  const rotate = useActionRunner();
  const test = useActionRunner();
  const keyRun = useActionRunner();
  const revoke = useActionRunner();
  const [last, setLast] = useState<"save" | "rotate">("save");
  const revealBox = useRef<HTMLDivElement>(null);
  // Leitor de tela e teclado: o foco vai para o quadro assim que o segredo ou a chave aparece (é a única chance de copiar).
  useEffect(() => {
    if (reveal) revealBox.current?.focus();
  }, [reveal]);
  const active = keys.filter((k) => !k.revokedAt);
  const unreadable = data?.secret === "unreadable";

  return (
    <ConnItem
      id="app"
      logo="app"
      name="App (integração)"
      title="App (integração)"
      sub="Cobra o app com conta de usuário e avisa o app de cada pagamento"
      summary={hostOfUrl(data?.url ?? null)}
      on={configured}
      onLabel={unreadable ? "Segredo ilegível" : "Conectado"}
      warn={unreadable}
      canWrite={canWrite}
      locked={reveal !== null}
      onClosed={() => setReveal(null)}
    >
      {reveal ? (
        <div className={`${s.stack} ${s.connReveal}`} ref={revealBox} tabIndex={-1}>
          <p role="alert" className={s.tokenWarn}>
            Copie agora: {reveal.kind === "secret" ? "o segredo" : "a chave"} não aparece de novo.
          </p>
          <div className={s.field}>
            <span className={s.label}>{reveal.title}</span>
            <CopyField text={reveal.value} />
            {reveal.kind === "secret" ? (
              <span className={s.hint}>
                Guarde no app: ele confere o cabeçalho <code className={s.mono}>Funil-Assinatura</code> de cada aviso com este segredo.
              </span>
            ) : (
              <span className={s.hint}>
                O app chama <code className={s.mono}>{apiBaseUrl}</code> com o cabeçalho <code className={s.mono}>Authorization: Bearer &lt;chave&gt;</code>.
              </span>
            )}
          </div>
          <div className={s.formActions}>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setReveal(null)}>
              Já copiei
            </button>
          </div>
        </div>
      ) : null}

      <h3 className={`${s.h2} ${s.connSubhead}`}>
        Webhook do app
      </h3>
      {editing && canWrite ? (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            // https, host público e sem credencial: conferidos no servidor, com a mesma regra do envio.
            setConfirm("save");
          }}
        >
          <div className={s.field}>
            <label className={s.field}>
              <span className={s.label}>URL do webhook</span>
              <input
                className={`${s.input} ${s.mono}`}
                type="url"
                inputMode="url"
                autoComplete="off"
                value={f.url}
                required
                maxLength={2000}
                placeholder="https://seu-app.com.br/api/funil/webhook"
                onChange={(e) => setF({ ...f, url: e.target.value })}
              />
            </label>
            <span className={s.hint}>Recebe pagamento confirmado, reembolso e contestação. Só https, em endereço público.</span>
          </div>
          <div className={s.field}>
            <label className={s.field}>
              <span className={s.label}>Hosts de retorno</span>
              <textarea
                className={`${s.input} ${s.mono}`}
                rows={3}
                value={f.hosts}
                placeholder={"app.exemplo.com.br"}
                onChange={(e) => setF({ ...f, hosts: e.target.value })}
              />
            </label>
            <span className={s.hint}>Para onde o checkout pode voltar depois do pagamento. Um por linha, só o nome (sem https://). Até 10.</span>
          </div>
          <div className={s.field}>
            <label className={s.field}>
              <span className={s.label}>Endereço público do app (opcional)</span>
              <input
                className={`${s.input} ${s.mono}`}
                type="url"
                inputMode="url"
                autoComplete="off"
                value={f.origin}
                placeholder="https://app.exemplo.com.br"
                onChange={(e) => setF({ ...f, origin: e.target.value })}
              />
            </label>
            <span className={s.hint}>Onde a pessoa se cadastra. Vai ao Meta como página do evento de início do teste.</span>
          </div>
          <div className={s.formActions}>
            {configured ? (
              <button type="button" className={s.btn} onClick={() => setEditing(false)}>
                Cancelar
              </button>
            ) : null}
            <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={reveal !== null}>
              {configured ? "Salvar alterações" : "Salvar webhook"}
            </button>
          </div>
        </form>
      ) : configured && data ? (
        <div className={`${s.rows} ${s.factRows}`}>
          <Row k="URL do webhook">
            <span className={s.mono}>{data.url}</span>
          </Row>
          <Row k="Hosts de retorno">{data.returnHosts.length > 0 ? <span className={s.mono}>{data.returnHosts.join(", ")}</span> : "nenhum"}</Row>
          <Row k="Endereço público">{data.publicOrigin ? <span className={s.mono}>{data.publicOrigin}</span> : "o da loja"}</Row>
          <Row k="Segredo da assinatura">{unreadable ? "ilegível: gere um segredo novo" : data.secret ? <Configured /> : "—"}</Row>
        </div>
      ) : (
        <p className={s.muted}>Ainda não configurado.</p>
      )}
      <Live msg={confirm ? null : last === "rotate" ? rotate.msg : save.msg} />
      {canWrite && configured ? (
        <div className={s.cardFoot}>
          <button type="button" className={s.btn} disabled={test.pending || unreadable} onClick={() => void test.run(() => testAppWebhookAction(), { refresh: false })}>
            {test.pending ? "Enviando…" : "Enviar teste"}
          </button>
          {!editing ? (
            <button type="button" className={s.btn} onClick={() => setEditing(true)}>
              Editar
            </button>
          ) : null}
          <button type="button" className={s.btn} disabled={reveal !== null} onClick={() => setConfirm("rotate")}>
            Gerar segredo novo
          </button>
          <div className={s.connFull}>
            <Live msg={test.msg} />
          </div>
        </div>
      ) : null}

      <div className={`${s.card} ${s.connInset}`}>
        <h3 className={`${s.h2} ${s.connSubhead}`}>
          Chaves da API
        </h3>
        {canManageKeys ? (
          <div className={`${s.stack} ${s.connInsetStack}`}>
            {active.length > 0 ? (
              <div className={`${s.rows} ${s.factRows}`}>
                {active.map((k) => (
                  <div key={k.id} className={s.row}>
                    <span>
                      {k.name} <span className={s.mono}>…{k.last4}</span>
                    </span>
                    <span className={s.headActions}>
                      <small className={s.muted}>{k.lastUsedAt ? `usada em ${k.lastUsedAt}` : `criada em ${k.createdAt}, nunca usada`}</small>
                      <button type="button" className={s.linkBtn} onClick={() => setRevoking(k)} aria-label={`Revogar a chave ${k.name}`}>
                        Revogar
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className={s.connNote}>
                Nenhuma chave ativa. O app precisa de uma para registrar testes e criar pagamentos.
              </p>
            )}
            <form
              className={s.headActions}
              onSubmit={async (e) => {
                e.preventDefault();
                await keyRun.run(() => createIntegrationKeyAction(keyName.trim()), {
                  onOk: (d) => {
                    const created = d as { token: string; name: string };
                    setReveal({ kind: "key", title: `Chave “${created.name}”`, value: created.token });
                    setKeyName("");
                  },
                });
              }}
            >
              <label className={s.srOnly} htmlFor="app-key-name">
                Nome da chave
              </label>
              <input
                id="app-key-name"
                className={`${s.input} ${s.connKeyInput}`}
                value={keyName}
                required
                maxLength={60}
                placeholder="Nome da chave (ex.: PeticionaAqui produção)"
                onChange={(e) => setKeyName(e.target.value)}
              />
              {/* Com um segredo ou chave na tela, outro "copie agora" o apagaria antes de ser copiado. */}
              <button type="submit" className={s.btn} disabled={keyRun.pending || keyName.trim() === "" || reveal !== null}>
                {keyRun.pending ? "Criando…" : "Criar chave"}
              </button>
            </form>
            <Live msg={revoking ? null : (revoke.msg ?? keyRun.msg)} />
          </div>
        ) : (
          <p className={s.connNote}>
            Só o dono da loja cria e revoga as chaves da API.
          </p>
        )}
      </div>

      <ConfirmSave
        open={confirm === "save"}
        onClose={() => setConfirm(null)}
        title="Salvar o webhook do app?"
        run={save}
        label="Salvar"
        pendingLabel="Salvando…"
        onConfirm={async () => {
          setLast("save");
          const r = await save.run(() =>
            saveAppWebhookAction({ url: f.url.trim(), returnHosts: hostsOf(f.hosts), publicOrigin: f.origin.trim() ? f.origin.trim() : null }),
          );
          if (r.ok) {
            setConfirm(null);
            setEditing(false);
            const out = r.data as { returnHosts: string[]; publicOrigin: string | null; secret?: string };
            setF((x) => ({ ...x, hosts: hostsText(out.returnHosts), origin: out.publicOrigin ?? "" }));
            if (out.secret) setReveal({ kind: "secret", title: "Segredo da assinatura", value: out.secret });
          }
        }}
      >
        <p>
          Os avisos de pagamento da loja passam a ir para <b className={s.mono}>{hostOfUrl(f.url.trim()) ?? f.url.trim()}</b>, assinados com o segredo.
          {configured ? "" : " O segredo aparece uma única vez, logo depois de salvar."}
        </p>
      </ConfirmSave>
      <ConfirmSave
        open={confirm === "rotate"}
        onClose={() => setConfirm(null)}
        title="Gerar um segredo novo?"
        run={rotate}
        label="Gerar segredo novo"
        pendingLabel="Gerando…"
        onConfirm={async () => {
          setLast("rotate");
          const r = await rotate.run(() => rotateAppWebhookSecretAction());
          if (r.ok) {
            setConfirm(null);
            setReveal({ kind: "secret", title: "Segredo da assinatura", value: (r.data as { secret: string }).secret });
          }
        }}
      >
        <p>O segredo atual para de valer na hora: os avisos seguintes só conferem com o novo. Atualize o app logo em seguida.</p>
      </ConfirmSave>
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        tone="danger"
        title={`Revogar a chave “${revoking?.name ?? ""}”?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={() => setRevoking(null)} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              disabled={revoke.pending}
              onClick={async () => {
                if (!revoking) return;
                const r = await revoke.run(() => revokeIntegrationKeyAction(revoking.id));
                if (r.ok) setRevoking(null);
              }}
            >
              {revoke.pending ? "Revogando…" : "Revogar chave"}
            </button>
          </>
        }
      >
        <p>O app que usa esta chave deixa de registrar testes e criar pagamentos na hora.</p>
        {revoke.msg?.tone === "error" ? <Live msg={revoke.msg} /> : null}
      </Dialog>
    </ConnItem>
  );
}
