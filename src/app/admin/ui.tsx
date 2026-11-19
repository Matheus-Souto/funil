"use client";

// Peças interativas do painel: diálogo acessível (foco preso, Esc, foco devolvido), botão de copiar, região aria-live
// para resultados assíncronos e o "ok" dos avisos. Sem regra de negócio: tudo passa pelas server actions do painel.
import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "./result";
import { PIcon, type PanelIconName } from "./icons";
import s from "./panel.module.css";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  icon,
  tone,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: PanelIconName;
  tone?: "danger";
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const box = ref.current!;
    const first = box.querySelector<HTMLElement>("[data-autofocus]") ?? box.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const a = items[0]!;
      const z = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === a || !box.contains(document.activeElement))) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button type="button" className={`${s.iconBtn} ${s.dialogClose}`} onClick={onClose} aria-label="Fechar">
          <PIcon name="x" />
        </button>
        {icon ? (
          <div className={s.dialogIcon} data-tone={tone}>
            <PIcon name={icon} size={20} />
          </div>
        ) : null}
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className={s.dialogActions}>{footer}</div>
      </div>
    </div>
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
