"use client";

// Botões do pedido (Liberar / Reenviar / Reembolsar) com os diálogos de confirmação do design (P07, P08).
// O que aparece vem de allowedOrderActions (papel + estado); o servidor confere de novo em cada ação.
import { useState } from "react";
import { brl, dateTimeSP } from "@/lib/format";
import { PIcon } from "../../../icons";
import s from "../../../panel.module.css";
import { Dialog, Live, useActionRunner } from "../../../ui";
import { refundOrderAction, releaseOrderAction, resendOrderAction } from "../../actions";

export interface OrderActionsProps {
  id: string;
  code: string;
  status: string;
  method: "pix_manual" | "pix_asaas" | "card_asaas";
  buyerName: string;
  email: string;
  amountCents: number;
  totalCents: number;
  createdAt: string;
  expiresAt: string | null;
  /** Pix manual vencido (expirado, ou pendente com a validade passada). */
  expired: boolean;
  /** Até quando o valor único de um Pix manual vencido fica reservado (48 h depois da validade). */
  reservedUntil: string | null;
  allowed: { release: boolean; resend: boolean; refund: boolean };
  /** Pix Asaas pago numa cobrança da conta Asaas anterior: a conferência é na conta antiga, não no extrato. */
  oldAsaasAccount?: boolean;
}

export function OrderActions(p: OrderActionsProps) {
  const [open, setOpen] = useState<null | "release" | "refund" | "resend">(null);
  const [checks, setChecks] = useState({ seen: false, noReceipt: false });
  const [renew, setRenew] = useState(false);
  const { pending, msg, run } = useActionRunner();
  const close = () => {
    setOpen(null);
    setChecks({ seen: false, noReceipt: false });
    setRenew(false);
  };
  const expired = p.expired;
  const created = dateTimeSP(new Date(p.createdAt));
  const reserved = p.reservedUntil ? dateTimeSP(new Date(p.reservedUntil)) : null;
  const any = p.allowed.release || p.allowed.resend || p.allowed.refund;
  if (!any) return null;

  return (
    <div className={s.stack} style={{ gap: 4, alignItems: "flex-end" }}>
      <div className={s.orderActions}>
        {p.allowed.resend ? (
          <button type="button" className={s.btn} onClick={() => setOpen("resend")}>
            <PIcon name="send" size={16} />
            Reenviar acesso
          </button>
        ) : null}
        {p.allowed.refund ? (
          <button type="button" className={`${s.btn} ${s.btnDangerGhost}`} onClick={() => setOpen("refund")}>
            <PIcon name="rotate-ccw" size={16} />
            Reembolsar
          </button>
        ) : null}
        {p.allowed.release ? (
          <div className={s.stickyAction}>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setOpen("release")}>
              <PIcon name="circle-check" size={16} />
              Liberar pedido
            </button>
          </div>
        ) : null}
      </div>
      <Live msg={open ? null : msg} />

      <Dialog
        open={open === "release"}
        onClose={close}
        title={`Liberar o pedido #${p.code}?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={close}>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnPrimary}`}
              disabled={!checks.seen || !checks.noReceipt || pending}
              onClick={async () => {
                const r = await run(() => releaseOrderAction(p.id));
                if (r.ok) close();
              }}
            >
              {pending ? "Liberando…" : "Liberar e enviar acesso"}
            </button>
          </>
        }
      >
        <p>
          {p.buyerName} recebe o acesso por e-mail na hora e a venda é enviada ao Meta. Isso não pode ser desfeito sem reembolso.
        </p>
        {p.oldAsaasAccount ? (
          <div className={s.banner} role="note">
            <PIcon name="triangle-alert" />
            <div>
              <b>Cobrança da conta Asaas anterior.</b>
              <p>Este pedido tem uma cobrança criada na conta Asaas que a loja usava antes da troca, e ela teve movimento depois. Confira nessa conta se ela foi paga.</p>
            </div>
          </div>
        ) : expired ? (
          <div className={s.banner} data-tone="danger" role="note">
            <PIcon name="triangle-alert" />
            <div>
              <b>Este Pix já expirou{p.expiresAt ? ` (${dateTimeSP(new Date(p.expiresAt))})` : ""}.</b>
              <p>
                O valor único {brl(p.amountCents)} fica reservado para este pedido só até {reserved ?? "48 h depois da validade"}. Depois disso ele pode ter
                sido usado por outro pedido: confira a data e a hora do Pix no extrato antes de liberar.
              </p>
            </div>
          </div>
        ) : null}
        <label className={s.confirmCheck}>
          <input type="checkbox" data-autofocus checked={checks.seen} onChange={(e) => setChecks({ ...checks, seen: e.target.checked })} />
          {p.oldAsaasAccount ? (
            <span>
              Conferi na conta Asaas anterior que a cobrança de <b>{brl(p.amountCents)}</b> deste pedido foi paga.
            </span>
          ) : (
            <span>
              Vi um Pix de <b>{brl(p.amountCents)}</b> no extrato do banco, recebido depois de {created}
              {expired && reserved ? ` e antes de ${reserved}` : ""}.
            </span>
          )}
        </label>
        <label className={s.confirmCheck}>
          <input type="checkbox" checked={checks.noReceipt} onChange={(e) => setChecks({ ...checks, noReceipt: e.target.checked })} />
          <span>Não estou liberando com base em comprovante enviado pelo comprador.</span>
        </label>
        {msg?.tone === "error" ? <Live msg={msg} /> : null}
      </Dialog>

      <Dialog
        open={open === "refund"}
        onClose={close}
        tone="danger"
        title={`Reembolsar ${brl(p.totalCents)} para ${p.buyerName}?`}
        footer={
          <>
            <button type="button" className={s.btn} onClick={close} data-autofocus>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnDanger}`}
              disabled={pending}
              onClick={async () => {
                const r = await run(() => refundOrderAction(p.id));
                if (r.ok) close();
              }}
            >
              {pending ? "Enviando…" : `Reembolsar ${brl(p.totalCents)}`}
            </button>
          </>
        }
      >
        <p>
          Pedido #{p.code} · {p.method === "card_asaas" ? "Cartão" : p.method === "pix_asaas" ? "Pix Asaas" : "Pix manual"}
        </p>
        <ul className={s.infoList}>
          {p.method === "pix_manual" ? (
            <li>
              <PIcon name="landmark" size={16} />
              <span>O Pix manual não passa por aqui: devolva o valor ao comprador pelo seu banco. O pedido só é marcado como reembolsado.</span>
            </li>
          ) : (
            <li>
              <PIcon name={p.method === "card_asaas" ? "credit-card" : "landmark"} size={16} />
              <span>
                O estorno é pedido ao Asaas e o pedido vira reembolsado quando o Asaas confirmar.
                {p.method === "card_asaas" ? " No cartão, o valor pode levar até 2 faturas para aparecer." : " O Asaas devolve o Pix para a conta do comprador."}
              </span>
            </li>
          )}
          <li>
            <PIcon name="lock" size={16} />
            <span>O link de download é desativado quando o reembolso se confirma.</span>
          </li>
        </ul>
        <p className={s.fieldError} style={{ marginTop: 14 }}>
          Esta ação não pode ser desfeita.
        </p>
        {msg?.tone === "error" ? <Live msg={msg} /> : null}
      </Dialog>

      <Dialog
        open={open === "resend"}
        onClose={close}
        title="Reenviar o acesso?"
        footer={
          <>
            <button type="button" className={s.btn} onClick={close}>
              Cancelar
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.btnPrimary}`}
              disabled={pending}
              onClick={async () => {
                const r = await run(() => resendOrderAction(p.id, renew));
                if (r.ok) close();
              }}
            >
              {pending ? "Enviando…" : "Reenviar acesso"}
            </button>
          </>
        }
      >
        <p>Um novo e-mail com os links de download vai para {p.email}.</p>
        <label className={s.confirmCheck}>
          <input type="checkbox" data-autofocus checked={renew} onChange={(e) => setRenew(e.target.checked)} />
          <span>Gerar links novos (os links atuais param de funcionar; validade e downloads recomeçam).</span>
        </label>
        {msg?.tone === "error" ? <Live msg={msg} /> : null}
      </Dialog>
    </div>
  );
}
