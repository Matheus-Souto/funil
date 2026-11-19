"use client";

// Cartões de Conexões (P14). Salvar qualquer conexão é sensível: sempre passa por um diálogo de confirmação.
// Segredos nunca chegam aqui (só "configurado"); o token do webhook do Asaas aparece para quem pode alterar conexões.
import { useState, type ReactNode } from "react";
import { Badge } from "../../blocks";
import { PIcon, type PanelIconName } from "../../icons";
import s from "../../panel.module.css";
import { CopyField, Dialog, Live, SecretField, useActionRunner } from "../../ui";
import { saveAsaasAction, saveMetaAction, savePixManualAction, saveSmtpAction, testMetaAction, testSmtpAction } from "../actions";

type Runner = ReturnType<typeof useActionRunner>;

function Head({ icon, title, sub, on, onLabel }: { icon: PanelIconName; title: string; sub: string; on: boolean; onLabel?: string }) {
  return (
    <div className={s.connHead}>
      <span className={s.connIcon}>
        <PIcon name={icon} size={20} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{sub}</p>
      </div>
      <Badge tone={on ? "success" : "neutral"}>{on ? (onLabel ?? "Conectado") : "Não conectado"}</Badge>
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
function ConfirmSave({ open, onClose, title, children, run, onConfirm, label = "Salvar" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; run: Runner; onConfirm: () => void; label?: string }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="plug"
      title={title}
      footer={
        <>
          <button type="button" className={s.btn} onClick={onClose} data-autofocus>
            Cancelar
          </button>
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={onConfirm} disabled={run.pending}>
            {run.pending ? "Testando e salvando…" : label}
          </button>
        </>
      }
    >
      {children}
      {run.msg?.tone === "error" ? <Live msg={run.msg} /> : null}
    </Dialog>
  );
}

// ---- Pix manual ------------------------------------------------------------------------------------------------

export function PixManualCard({ data, canWrite }: { data: { key: string; name: string; city: string } | null; canWrite: boolean }) {
  const [editing, setEditing] = useState(!data);
  const [f, setF] = useState({ key: data?.key ?? "", name: data?.name ?? "", city: data?.city ?? "" });
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  return (
    <section className={s.card} aria-labelledby="pix-manual" id="pix-manual-card">
      <Head icon="landmark" title="Pix manual" sub="Pix direto na sua chave, liberado por você" on={Boolean(data)} />
      <span id="pix-manual" className={s.srOnly}>
        Pix manual
      </span>
      {editing && canWrite ? (
        <form
          className={s.stack}
          style={{ marginTop: 16 }}
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
        <div className={s.rows} style={{ marginTop: 12 }}>
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
    </section>
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

export function AsaasCard({
  data,
  canWrite,
}: {
  data: { env: "sandbox" | "production"; apiKey: "configured" | null; webhookUrl: string; webhookToken: string | null } | null;
  canWrite: boolean;
}) {
  const [env, setEnv] = useState<"sandbox" | "production">(data?.env ?? "sandbox");
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(!data);
  const [rotate, setRotate] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  const envLabel = (e: string) => (e === "production" ? "produção" : "sandbox");
  return (
    <section className={s.card} aria-label="Asaas" id="asaas">
      <Head icon="credit-card" title="Asaas" sub="Pix automático e cartão de crédito" on={Boolean(data)} onLabel={data ? `Conectado · ${envLabel(data.env)}` : undefined} />
      {canWrite ? (
        <form
          className={s.stack}
          style={{ marginTop: 16 }}
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
        <div className={s.rows} style={{ marginTop: 12 }}>
          <Row k="Ambiente">{envLabel(data.env)}</Row>
          <Row k="Chave de API">{data.apiKey ? <Configured /> : "—"}</Row>
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
    </section>
  );
}

// ---- SMTP -------------------------------------------------------------------------------------------------------

export function SmtpCard({
  data,
  canWrite,
  defaultTo,
}: {
  data: { host: string; port: number; secure: boolean; user: string | null; from: string; password: "configured" | null } | null;
  canWrite: boolean;
  defaultTo: string;
}) {
  const [editing, setEditing] = useState(!data);
  const [f, setF] = useState({ host: data?.host ?? "", port: String(data?.port ?? 587), secure: data?.secure ?? false, user: data?.user ?? "", password: "", from: data?.from ?? "" });
  const [to, setTo] = useState(defaultTo);
  const [confirm, setConfirm] = useState(false);
  const run = useActionRunner();
  const test = useActionRunner();
  return (
    <section className={s.card} aria-label="E-mail (SMTP)" id="smtp">
      <Head icon="mail" title="E-mail (SMTP)" sub="Envia o acesso ao comprador e o aviso de venda" on={Boolean(data)} />
      {editing && canWrite ? (
        <form
          className={s.stack}
          style={{ marginTop: 16 }}
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
        <div className={s.rows} style={{ marginTop: 12 }}>
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
    </section>
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
    <section className={s.card} aria-label="Meta" id="meta">
      <Head icon="code" title="Meta (Pixel e API de Conversões)" sub="Envia InitiateCheckout e Purchase com o mesmo event_id" on={Boolean(data)} />
      {canWrite ? (
        <form
          className={s.stack}
          style={{ marginTop: 16 }}
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
        <div className={s.rows} style={{ marginTop: 12 }}>
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
    </section>
  );
}
