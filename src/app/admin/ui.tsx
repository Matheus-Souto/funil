"use client";

// Peças interativas do painel: diálogo (Arc), botão de copiar, região aria-live
// para resultados assíncronos e o "ok" dos avisos. Sem regra de negócio: tudo passa pelas server actions do painel.
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Dialog as ArcDialog, DialogContent } from "@/components/arc/dialog/dialog";
import type { ActionResult } from "./result";
import { PIcon } from "./icons";
import s from "./panel.module.css";

/**
 * Diálogo de confirmação do painel, sobre o Dialog do Arc (Radix: foco preso, Esc, foco devolvido, animação de entrada
 * e saída). O conteúdo vai num portal fora do `.root`, então leva as variáveis do tema junto (`s.themeVars`).
 */
export function Dialog({
  open,
  onClose,
  title,
  tone,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  tone?: "danger";
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <ArcDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={title}
        className={`${s.themeVars} ${s.arcDialog}`}
        aria-describedby={undefined}
        // Foco inicial no elemento marcado com data-autofocus (ex.: "Cancelar" nos diálogos de risco), não no X.
        onOpenAutoFocus={(e) => {
          const el = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-autofocus]");
          if (el) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <div className={s.dialogBody} data-tone={tone}>
          {children}
        </div>
        <div className={s.dialogActions}>{footer}</div>
      </DialogContent>
    </ArcDialog>
  );
}

/** Estado de uma chamada a server action com mensagem para a região aria-live. */
export function useActionRunner() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const router = useRouter();
  const run = useCallback(
    <T,>(fn: () => Promise<ActionResult<T>>, opts: { ok?: string | ((d: T) => string); refresh?: boolean; onOk?: (d: T) => void } = {}) =>
      new Promise<ActionResult<T>>((resolve) => {
        setMsg(null);
        start(async () => {
          const r = await fn();
          if (r.ok) {
            const text = typeof opts.ok === "function" ? opts.ok(r.data) : (opts.ok ?? r.message ?? "Salvo.");
            setMsg({ tone: "ok", text });
            opts.onOk?.(r.data);
            if (opts.refresh !== false) router.refresh();
          } else setMsg({ tone: "error", text: r.error });
          resolve(r);
        });
      }),
    [router],
  );
  return { pending, msg, setMsg, run };
}

/** Região aria-live (polite) com o resultado da última ação. */
export function Live({ msg, id }: { msg: { tone: "ok" | "error"; text: string } | null; id?: string }) {
  return (
    <p id={id} className={s.live} role="status" aria-live="polite" data-tone={msg?.tone}>
      {msg?.text ?? ""}
    </p>
  );
}

export function CopyButton({ text, label = "Copiar", copied = "Copiado!", className, small }: { text: string; label?: string; copied?: string; className?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!done) return;
    const h = window.setTimeout(() => setDone(false), 2000);
    return () => window.clearTimeout(h);
  }, [done]);
  return (
    <>
      <button
        type="button"
        className={`${s.btn} ${small ? s.btnSm : ""} ${className ?? ""}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setFailed(false);
            setDone(true);
          } catch {
            setFailed(true);
          }
        }}
      >
        <PIcon name={done ? "check" : "copy"} size={16} />
        {done ? copied : label}
      </button>
      <span className={s.srOnly} role="status" aria-live="polite">
        {done ? copied : failed ? "Não foi possível copiar. Selecione o texto e copie à mão." : ""}
      </span>
    </>
  );
}

/** Caixa com um texto (link, URL, token) e o botão de copiar. */
export function CopyField({ text, label = "Copiar", display }: { text: string; label?: string; display?: string }) {
  return (
    <div className={s.copyBox}>
      <code title={text}>{display ?? text}</code>
      <CopyButton text={text} label={label} small />
    </div>
  );
}

/** Token secreto mascarado, com Mostrar/Esconder e Copiar. */
export function SecretField({ value, label }: { value: string; label: string }) {
  const [shown, setShown] = useState(false);
  const masked = `${value.slice(0, 4)}${"•".repeat(16)}${value.slice(-4)}`;
  return (
    <div className={s.copyBox}>
      <code aria-label={label}>{shown ? value : masked}</code>
      <button type="button" className={`${s.btn} ${s.btnSm} ${s.btnGhost}`} onClick={() => setShown((v) => !v)} aria-pressed={shown}>
        <PIcon name={shown ? "eye-off" : "eye"} size={16} />
        {shown ? "Esconder" : "Mostrar"}
      </button>
      <CopyButton text={value} small />
    </div>
  );
}

/** "ok" de um aviso da loja (alerts.ack). */
export function AckButton({ onAck }: { onAck: () => Promise<ActionResult<unknown>> }) {
  const { pending, msg, run } = useActionRunner();
  return (
    <span className={s.bannerAction}>
      <button type="button" className={`${s.btn} ${s.btnSm}`} disabled={pending} onClick={() => run(onAck, { ok: "Aviso marcado como visto." })}>
        ok
      </button>
      {msg?.tone === "error" ? <Live msg={msg} /> : null}
    </span>
  );
}
