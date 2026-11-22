"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./dialog.module.css";

/** Mirrors the open state so the content can stay mounted while it animates out, and retarget mid-flight if it is reopened or closed early. */
const OpenContext = createContext<boolean | null>(null);
/** One dialog in the nesting tree: its close, and the dialogs opened from it that are open right now (in opening order). */
interface Nesting { close: () => void; openChildren: Set<Nesting> }
/** This dialog and the dialog it was opened from (portals keep React context, so nesting is known). */
const CloseContext = createContext<{ self: Nesting; parent: Nesting | null } | null>(null);

/** The dialog on top of this one: its most recently opened open child, followed down to the last level. */
function topmostChild(node: Nesting): Nesting | null {
  let top: Nesting | null = null;
  for (let next = [...node.openChildren].at(-1); next; next = [...next.openChildren].at(-1)) top = next;
  return top;
}

export function Dialog({ open: openProp, defaultOpen = false, onOpenChange, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const setOpen = useCallback((next: boolean) => { if (openProp === undefined) setUncontrolled(next); onOpenChange?.(next); }, [openProp, onOpenChange]);
  const latest = useRef(setOpen);
  useLayoutEffect(() => { latest.current = setOpen; }, [setOpen]);
  const [self] = useState<Nesting>(() => ({ close: () => latest.current(false), openChildren: new Set() }));
  const outer = useContext(CloseContext);
  const parent = outer?.self ?? null;
  // Registered in a layout effect, so it is in place before the dialog paints. Radix only learns about a new layer in a
  // passive effect, after paint: an Escape pressed in that gap goes to the dialog underneath, which must close this one.
  useLayoutEffect(() => {
    if (!open || !parent) return;
    parent.openChildren.add(self);
    return () => { parent.openChildren.delete(self); };
  }, [open, parent, self]);
  const nesting = useMemo(() => ({ self, parent }), [self, parent]);
  return <CloseContext.Provider value={nesting}><OpenContext.Provider value={open}><DialogPrimitive.Root {...props} open={open} onOpenChange={setOpen}/></OpenContext.Provider></CloseContext.Provider>;
}

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  title: string;
  description?: string;
  children: ReactNode;
  /** false esconde o X (diálogo que só fecha pelo botão do rodapé). */
  showClose?: boolean;
}

const fade: Transition = { duration: motionTokens.duration.instant };
const leave: Transition = { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] };

/** When the title or description changes while open, the new copy rises in and the old copy leaves upward. */
function SwapText({ text }: { text: string }) {
  const reduced = useReducedMotion();
  return <AnimatePresence mode="popLayout" initial={false}>
    <motion.span key={text} className={styles.swap} initial={reduced ? false : { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }} transition={{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>{text}</motion.span>
  </AnimatePresence>;
}

export function DialogContent({ title, description, children, className, onPointerDownOutside, onEscapeKeyDown, showClose = true, ...props }: DialogContentProps) {
  const open = useContext(OpenContext);
  const nesting = useContext(CloseContext);
  const escape: DialogContentProps["onEscapeKeyDown"] = event => {
    onEscapeKeyDown?.(event);
    if (event.defaultPrevented || !nesting) return;
    // A dialog opened on top owns this press, even when Radix handed it here because the new layer is not registered yet.
    const top = topmostChild(nesting.self);
    if (top) { event.preventDefault(); top.close(); return; }
    // While this dialog animates out it is still the top layer, so Radix hands it the next Escape. That press is meant for
    // the dialog underneath (a confirm closing on top of a form): pass it down. Only when the exit began before this key:
    // the press that closes the dialog must not close the one below too. The leaving copy is frozen with the props of its
    // last open render, so the current state is read through the ref below, not the closure.
    if (change.current.open === false && change.current.at < event.timeStamp) { event.preventDefault(); nesting.parent?.close(); }
  };
  const reduced = useReducedMotion();
  // When the open state last changed. Radix waits for the click before treating a press as outside, and a press on the trigger
  // while the dialog leaves reopens it first, so that press must not close it again.
  const change = useRef({ open, at: 0 });
  useLayoutEffect(() => { change.current = { open, at: performance.now() }; }, [open]);
  const pressOutside: DialogContentProps["onPointerDownOutside"] = event => {
    onPointerDownOutside?.(event);
    if (open !== null && (!change.current.open || event.detail.originalEvent.timeStamp < change.current.at)) event.preventDefault();
  };
  const classes = [styles.content, className].filter(Boolean).join(" ");
  const inner = <>
    <div className={styles.header}><div><DialogPrimitive.Title className={styles.title}><SwapText text={title}/></DialogPrimitive.Title>{description ? <DialogPrimitive.Description className={styles.description}><SwapText text={description}/></DialogPrimitive.Description> : null}</div>{showClose ? <DialogPrimitive.Close className={styles.close} aria-label="Fechar"><X size={16} strokeWidth={1.75} aria-hidden="true"/></DialogPrimitive.Close> : null}</div>
    <div className={styles.body}>{children}</div>
  </>;
  // Under a bare Radix root the open state is unknown here, so CSS keyframes keyed off data-state animate the layers instead.
  if (open === null) return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={`${styles.overlay} ${styles.keyframes}`}/>
    <DialogPrimitive.Content {...props} onPointerDownOutside={pressOutside} onEscapeKeyDown={escape} className={`${classes} ${styles.keyframes}`}>{inner}</DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
  // The overlay fades while the dialog rises 8px and scales up on a spring. Closing is shorter and quieter, and starts from wherever the entrance is.
  return <AnimatePresence>
    {open && <DialogPrimitive.Portal key="dialog" forceMount>
      <DialogPrimitive.Overlay asChild forceMount><motion.div className={styles.overlay} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: reduced ? fade : leave }} transition={reduced ? fade : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}/></DialogPrimitive.Overlay>
      <DialogPrimitive.Content {...props} onPointerDownOutside={pressOutside} onEscapeKeyDown={escape} asChild forceMount>
        <motion.div className={classes} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 0, transition: fade } : { opacity: 0, y: 4, scale: .98, transition: leave }} transition={reduced ? fade : { default: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] } }}>{inner}</motion.div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>}
  </AnimatePresence>;
}
