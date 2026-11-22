"use client";

import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { ClipboardEvent as ReactClipboardEvent, FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./money-input.module.css";

export interface MoneyInputDetails {
  currency: string;
  /** The amount in major units, such as 12.5 for $12.50. */
  major: number | null;
  /** The amount as a full currency string, such as "$12.50". */
  formatted: string;
}

export interface MoneyInputProps {
  label: string;
  hideLabel?: boolean;
  /** Amount in minor units (cents for USD, yen for JPY). `null` is empty. */
  value?: number | null;
  defaultValue?: number | null;
  onValueChange?: (value: number | null, details: MoneyInputDetails) => void;
  /** ISO 4217 code; the panel uses only "BRL" (the currency menu of the original Arc component was removed). */
  currency?: string;
  /** Lowest amount in minor units. Checked when the field loses focus. */
  min?: number;
  /** Highest amount in minor units. Typing past it is refused with a nudge. */
  max?: number;
  /** Shows the allowed range ("Até R$ …") under the field. Off by default: a technical ceiling needs no caption. */
  showRange?: boolean;
  /** Arrow keys move by this many minor units. Defaults to one major unit; Shift moves ten times as far. */
  step?: number;
  /** Formatting locale. Fixed by default so server and client render the same digits. */
  locale?: string;
  description?: string;
  /** Replaces the built-in range message. */
  error?: string;
  disabled?: boolean;
  /** Adds a hidden input carrying the amount in minor units. */
  name?: string;
  id?: string;
  className?: string;
  onBlur?: (event: ReactFocusEvent<HTMLInputElement>) => void;
}

type Source = "type" | "key" | "external";
type Part = { key: string; char: string; ghost: boolean };
type CurrencyInfo = { code: string; symbol: string; position: "prefix" | "suffix"; digits: number; full: Intl.NumberFormat };

type Bezier = [number, number, number, number];
const enterEase = [...motionTokens.ease.enter] as Bezier;
const standardEase = [...motionTokens.ease.standard] as Bezier;
const { spring, blur, duration } = motionTokens;
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** A sideways kick when a limit refuses the change: the amount strains toward the press and springs home.
 *  motion: a physical refusal cue, a little slower than interface springs so the strain reads. */
const KICK = physical(.42, 0);
const MAX_INTEGER_DIGITS = 12;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

const infoCache = new Map<string, CurrencyInfo>();
function currencyInfo(code: string, locale: string): CurrencyInfo {
  const cacheKey = `${locale}:${code}`;
  const cached = infoCache.get(cacheKey);
  if (cached) return cached;
  const full = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol", numberingSystem: "latn" });
  const parts = full.formatToParts(1);
  const symbolAt = parts.findIndex(part => part.type === "currency"), numberAt = parts.findIndex(part => part.type === "integer");
  const digits = full.resolvedOptions().maximumFractionDigits ?? 2;
  const info: CurrencyInfo = { code, symbol: parts[symbolAt]?.value ?? code, position: symbolAt < numberAt ? "prefix" : "suffix", digits, full };
  infoCache.set(cacheKey, info);
  return info;
}

function localeSymbols(locale: string) {
  const parts = new Intl.NumberFormat(locale, { numberingSystem: "latn" }).formatToParts(12345.6);
  return { group: parts.find(part => part.type === "group")?.value ?? ",", decimal: parts.find(part => part.type === "decimal")?.value ?? "." };
}

/* A draft is the amount as typed in a canonical form: digits with an optional ".", such as "1234.5". */
const pow10 = (digits: number) => 10 ** digits;
function toMinor(draft: string, digits: number): number | null {
  if (!draft) return null;
  const [whole, fraction = ""] = draft.split(".");
  return Number(whole || "0") * pow10(digits) + Number(fraction.padEnd(digits, "0").slice(0, digits) || "0");
}
function fromMinor(minor: number | null | undefined, digits: number) {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return "";
  const text = String(Math.round(Math.abs(minor))).padStart(digits + 1, "0");
  return digits ? `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}` : text;
}
/** Settles a draft the way it will be read back: fraction padded to the currency, leading zeros gone. */
function settle(draft: string, digits: number) { return draft ? fromMinor(toMinor(draft, digits), digits) : ""; }

function groupInteger(whole: string, group: string) { return whole.replace(/\B(?=(\d{3})+(?!\d))/g, group); }
function displayOf(draft: string, symbols: { group: string; decimal: string }) {
  if (!draft) return "";
  const [whole = "", fraction] = draft.split(".");
  return groupInteger(whole, symbols.group) + (fraction !== undefined ? symbols.decimal + fraction : "");
}

/** Columns keyed by place value, so 9 → 10 keeps the ones column the ones column. Missing fraction digits are ghosts that hold their width. */
function partsOf(draft: string, digits: number, symbols: { group: string; decimal: string }): Part[] {
  const [whole = "", fraction] = draft ? draft.split(".") : [];
  const parts: Part[] = [];
  const intDigits = whole || "0";
  const ghostInt = !whole;
  [...intDigits].forEach((char, index) => {
    const place = intDigits.length - 1 - index;
    parts.push({ key: `i${place}`, char, ghost: ghostInt });
    if (place > 0 && place % 3 === 0) parts.push({ key: `g${place}`, char: symbols.group, ghost: ghostInt });
  });
  if (digits) {
    parts.push({ key: "d", char: symbols.decimal, ghost: fraction === undefined });
    for (let index = 0; index < digits; index++) parts.push({ key: `f${index}`, char: fraction?.[index] ?? "0", ghost: fraction === undefined || index >= fraction.length });
  }
  return parts;
}

/* Columns open their width while the digit rises in the direction of change. Typing cuts straight to the result so the caret is never behind. */
const column: Variants = {
  enter: { width: 0, opacity: 0 },
  center: { width: "auto", opacity: 1, transition: { width: spring.morph, opacity: { duration: duration.fast } } },
  exit: { width: 0, opacity: 0, transition: { width: spring.smooth, opacity: { duration: duration.instant } } },
};
const columnCut: Variants = { enter: { width: "auto", opacity: 1 }, center: { width: "auto", opacity: 1, transition: { duration: 0 } }, exit: { width: 0, opacity: 0, transition: { duration: 0 } } };
const glyph: Variants = {
  enter: (dir: number) => ({ y: `${dir * .55}em`, opacity: 0, filter: `blur(${blur.soft}px)` }),
  center: { y: 0, opacity: 1, filter: "blur(0px)", transitionEnd: { filter: "none" }, transition: { y: spring.snappy, opacity: { duration: duration.fast, ease: enterEase }, filter: { duration: duration.exit, ease: enterEase } } },
  exit: (dir: number) => ({ y: `${dir * -.55}em`, opacity: 0, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.instant, ease: standardEase } }),
};
const glyphCut: Variants = { enter: { y: 0, opacity: 1, filter: "none" }, center: { y: 0, opacity: 1, filter: "none", transition: { duration: 0 } }, exit: { opacity: 0, transition: { duration: 0 } } };
const glyphFade: Variants = { enter: { y: 0, opacity: 0, filter: "none" }, center: { y: 0, opacity: 1, filter: "none", transition: { duration: duration.instant } }, exit: { opacity: 0, transition: { duration: 0 } } };

function Glyphs({ parts, direction, instant, reduced }: { parts: Part[]; direction: number; instant: boolean; reduced: boolean }) {
  const columnVariants = instant || reduced ? columnCut : column;
  const glyphVariants = instant ? glyphCut : reduced ? glyphFade : glyph;
  return <AnimatePresence initial={false} custom={direction}>
    {parts.map(part => <motion.span key={part.key} className={styles.column} data-ghost={part.ghost || undefined} custom={direction} variants={columnVariants} initial="enter" animate="center" exit="exit">
      <span className={styles.sizer}>{part.char}</span>
      <AnimatePresence initial={false} custom={direction}>
        <motion.span key={part.char} className={styles.glyph} custom={direction} variants={glyphVariants} initial="enter" animate="center" exit="exit">{part.char}</motion.span>
      </AnimatePresence>
    </motion.span>)}
  </AnimatePresence>;
}

/** The currency symbol swaps with a short roll while its slot springs to the new width. */
function SymbolSlot({ symbol, reduced }: { symbol: string; reduced: boolean }) {
  const sizerRef = useRef<HTMLSpanElement>(null);
  const width = useMotionValue<number | "auto">("auto");
  const measured = useRef(false);
  useLayoutEffect(() => {
    const node = sizerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!measured.current || reduced) width.jump(node.offsetWidth); else animate(width, node.offsetWidth, spring.morph);
      measured.current = true;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced, width]);
  return <motion.span className={styles.symbol} style={{ width }} aria-hidden="true">
    <span ref={sizerRef} className={styles.symbolSizer}>{symbol}</span>
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span key={symbol} className={styles.symbolGlyph} initial={reduced ? { opacity: 0 } : { opacity: 0, y: ".4em", filter: `blur(${blur.soft}px)` }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: reduced ? 0 : "-.3em", transition: { duration: duration.instant } }}
        transition={reduced ? { duration: duration.instant } : { y: spring.snappy, opacity: { duration: duration.fast }, filter: { duration: duration.exit } }}>{symbol}</motion.span>
    </AnimatePresence>
  </motion.span>;
}

const isSignificant = (char: string, decimal: string) => /\d/.test(char) || char === decimal;
function positionAfter(text: string, count: number, decimal: string) {
  if (count <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < text.length; index++) if (isSignificant(text[index]!, decimal) && ++seen === count) return index + 1;
  return text.length;
}

/**
 * A currency amount field. Digits group as they are typed without moving the caret, the missing cents wait as faint ghosts
 * so the amount never changes width when it settles, long amounts scale down to fit instead of scrolling, and arrow keys roll
 * the digits. The value comes out in minor units, so R$ 12,50 is 1250.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput({
  label, hideLabel = false, value, defaultValue = null, onValueChange, currency = "BRL", min, max, showRange = false, step: stepProp, locale = "pt-BR",
  description, error, disabled = false, name, id, className, onBlur,
}, forwardedRef) {
  const reduced = useReducedFlag();
  const uid = useId();
  const inputId = id ?? `${uid}-amount`;
  const hintId = `${inputId}-hint`, errorId = `${inputId}-error`, rangeId = `${inputId}-range`;

  const info = useMemo(() => currencyInfo(currency, locale), [currency, locale]);
  const symbols = useMemo(() => localeSymbols(locale), [locale]);
  const step = stepProp && stepProp > 0 ? stepProp : pow10(info.digits);

  const [draft, setDraft] = useState(() => fromMinor(value !== undefined ? value : defaultValue, info.digits));
  const minor = toMinor(draft, info.digits);

  const [seenValue, setSeenValue] = useState(value);
  const [source, setSource] = useState<Source>("external");
  const [direction, setDirection] = useState(1);
  if (value !== seenValue) {
    setSeenValue(value);
    if (value !== undefined && value !== minor) {
      setDraft(fromMinor(value, info.digits));
      setSource("external");
      setDirection((value ?? 0) >= (minor ?? 0) ? 1 : -1);
    }
  }

  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const [limitFlash, setLimitFlash] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);
  const pendingCaret = useRef<number | null>(null);
  const latest = useRef({ minor, draft });
  useLayoutEffect(() => { latest.current = { minor, draft }; });

  const money = useCallback((amount: number | null) => amount === null ? "" : info.full.format(amount / pow10(info.digits)), [info]);
  const display = displayOf(draft, symbols);
  const parts = useMemo(() => partsOf(draft, info.digits, symbols), [draft, info.digits, symbols]);

  /* ---------------------------------------------- Limits and feedback ---------------------------------------------- */

  const bumpX = useMotionValue(0);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  function refuse(toward: 1 | -1, limit: number) {
    if (!reduced) animate(bumpX, 0, { ...KICK, velocity: toward * 160 });
    setLimitFlash(count => count + 1);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setLimitFlash(0), 1400);
    setAnnouncement(`${toward > 0 ? "Máximo" : "Mínimo"}: ${money(limit)}`);
  }

  function emit(nextMinor: number | null, nextInfo = info) {
    onValueChange?.(nextMinor, { currency: nextInfo.code, major: nextMinor === null ? null : nextMinor / pow10(nextInfo.digits), formatted: nextMinor === null ? "" : nextInfo.full.format(nextMinor / pow10(nextInfo.digits)) });
  }

  function setAmount(nextDraft: string, nextSource: Source) {
    const nextMinor = toMinor(nextDraft, info.digits);
    setDirection((nextMinor ?? 0) >= (latest.current.minor ?? 0) ? 1 : -1);
    setSource(nextSource);
    setDraft(nextDraft);
    latest.current = { minor: nextMinor, draft: nextDraft };
    if (nextMinor !== minor) emit(nextMinor);
    if (nextSource !== "type") setAnnouncement(money(nextMinor));
  }

  /* ---------------------------------------------- Typing ---------------------------------------------- */

  /** Reads what the input holds into a draft and counts the digits and decimal before the caret, so the caret can return to the same spot. */
  function sanitize(raw: string, caret: number) {
    let out = "", before = 0, dot = false;
    for (let index = 0; index < raw.length; index++) {
      const char = raw[index]!;
      let kept = "";
      if (/\d/.test(char)) kept = char;
      else if ((char === symbols.decimal || (char === "." && symbols.group !== ".")) && info.digits > 0 && !dot) { kept = "."; dot = true; }
      if (!kept) continue;
      out += kept;
      if (index < caret) before++;
    }
    const pieces = out.split(".");
    let whole = pieces[0]!;
    const fraction = pieces[1];
    const stripped = whole.length - (whole.replace(/^0+/, "").length);
    whole = whole.replace(/^0+/, "");
    let shift = -Math.min(stripped, before);
    if (fraction !== undefined && !whole) { whole = "0"; shift += 1; }
    if (fraction === undefined && !whole && stripped) { whole = "0"; shift += 1; }
    if (fraction !== undefined && fraction.length > info.digits) return null;
    if (whole.length > MAX_INTEGER_DIGITS) return null;
    return { draft: fraction !== undefined ? `${whole}.${fraction}` : whole, before: Math.max(0, before + shift) };
  }

  function applyRaw(raw: string, caret: number) {
    const result = sanitize(raw, caret);
    // A refused keystroke keeps the caret where it was: one significant character before where the browser left it.
    if (!result) { pendingCaret.current = Math.max(0, [...raw.slice(0, caret)].filter(char => isSignificant(char, symbols.decimal) || char === ".").length - 1); rerender(); return; }
    const nextMinor = toMinor(result.draft, info.digits);
    if (max !== undefined && nextMinor !== null && nextMinor > max) {
      pendingCaret.current = Math.max(0, result.before - 1);
      refuse(1, max);
      rerender();
      return;
    }
    pendingCaret.current = result.before;
    setAmount(result.draft, "type");
  }

  useLayoutEffect(() => {
    const input = inputRef.current, count = pendingCaret.current;
    pendingCaret.current = null;
    if (!input || count === null || document.activeElement !== input) return;
    const position = positionAfter(input.value, count, symbols.decimal);
    input.setSelectionRange(position, position);
  });

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const moves: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 };
    if (event.key in moves) {
      event.preventDefault();
      const amount = moves[event.key]! * step * (event.shiftKey && Math.abs(moves[event.key]!) === 1 ? 10 : 1);
      nudge(amount, "key");
      return;
    }
    if (event.key === "Enter") { setDraft(settle(draft, info.digits)); pendingCaret.current = Number.MAX_SAFE_INTEGER; return; }
    const start = input.selectionStart ?? 0, end = input.selectionEnd ?? 0;
    if (start !== end || event.metaKey || event.ctrlKey || event.altKey) return;
    // Deleting a group separator deletes the digit before it instead of doing nothing.
    if (event.key === "Backspace" && start > 1 && input.value[start - 1] === symbols.group) { event.preventDefault(); applyRaw(input.value.slice(0, start - 2) + input.value.slice(start - 1), start - 2); }
    if (event.key === "Delete" && input.value[start] === symbols.group) { event.preventDefault(); applyRaw(input.value.slice(0, start + 1) + input.value.slice(start + 2), start); }
  }

  function onPaste(event: ReactClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text").trim();
    if (!text) return;
    event.preventDefault();
    // "$1,234.56", "1.234,56 €", "1234.5": a final separator followed by one or two digits is the decimal; the rest are groups.
    const match = /[.,](\d{1,2})\s*\D*$/.exec(text);
    const whole = (match ? text.slice(0, match.index) : text).replace(/\D/g, "");
    const pasted = match && info.digits ? `${whole}.${match[1]}` : whole;
    if (!/\d/.test(pasted)) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? 0, end = input.selectionEnd ?? 0;
    const inserted = pasted.replace(".", symbols.decimal);
    const replaceAll = start === 0 && end === input.value.length || !input.value;
    const raw = replaceAll ? inserted : input.value.slice(0, start) + inserted + input.value.slice(end);
    applyRaw(raw, replaceAll ? raw.length : start + inserted.length);
  }

  /* ---------------------------------------------- Steps ---------------------------------------------- */

  function nudge(amount: number, nextSource: Source) {
    const from = latest.current.minor ?? 0;
    const floor = min ?? 0, ceiling = max ?? Number.MAX_SAFE_INTEGER;
    let next = from + amount;
    if (next > ceiling) { if (from >= ceiling) { refuse(1, ceiling); return; } next = ceiling; refuse(1, ceiling); }
    if (next < floor) { if (from <= floor && latest.current.minor !== null) { refuse(-1, floor); return; } next = floor; }
    pendingCaret.current = Number.MAX_SAFE_INTEGER;
    setAmount(fromMinor(next, info.digits), nextSource);
  }

  /* ---------------------------------------------- Fit to width ---------------------------------------------- */

  const wrapRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const scale = useMotionValue(1);
  useLayoutEffect(() => {
    const wrap = wrapRef.current, group = groupRef.current;
    if (!wrap || !group || typeof ResizeObserver === "undefined") return;
    let first = true;
    const fit = () => {
      const natural = group.offsetWidth, room = wrap.clientWidth;
      const next = natural > 0 && room > 0 ? Math.min(1, room / natural) : 1;
      if (first || reduced) scale.jump(next); else animate(scale, next, spring.smooth);
      first = false;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(wrap); observer.observe(group);
    return () => observer.disconnect();
  }, [reduced, scale]);

  /* ---------------------------------------------- Messages ---------------------------------------------- */

  const range = !showRange ? "" : min !== undefined && max !== undefined ? `${money(min)} a ${money(max)}` : max !== undefined ? `Até ${money(max)}` : min !== undefined ? `A partir de ${money(min)}` : "";
  const outOfRange = minor !== null && ((min !== undefined && minor < min) || (max !== undefined && minor > max));
  const belowMin = minor !== null && min !== undefined && minor < min;
  const builtIn = touched && !focused && outOfRange ? belowMin ? `O mínimo é ${money(min ?? 0)}` : `O máximo é ${money(max ?? 0)}` : undefined;
  const message = error ?? builtIn;
  const invalid = !!message;
  const describedBy = [range ? rangeId : null, description ? hintId : null, message ? errorId : null].filter(Boolean).join(" ") || undefined;
  const instant = source === "type";

  return <div className={[styles.field, className].filter(Boolean).join(" ")} data-disabled={disabled || undefined}>
    <label htmlFor={inputId} className={hideLabel ? styles.srOnly : styles.label}>{label}</label>

    <div className={styles.control} data-invalid={invalid || undefined} data-focused={focused || undefined}>
      <div ref={wrapRef} className={styles.amountWrap} onMouseDown={event => { if (event.target !== inputRef.current) event.preventDefault(); }}
        onClick={event => { if (!disabled && event.target !== inputRef.current) { const input = inputRef.current; input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); } }}>
        <motion.div ref={groupRef} className={styles.group} style={{ scale, x: bumpX }}>
          {info.position === "prefix" && <SymbolSlot symbol={info.symbol} reduced={reduced} />}
          <span className={styles.number}>
            <span className={styles.mirror} aria-hidden="true" data-empty={!draft || undefined}><Glyphs parts={parts} direction={direction} instant={instant} reduced={reduced} /></span>
            <input ref={inputRef} id={inputId} className={styles.input} type="text" role="spinbutton" inputMode={info.digits ? "decimal" : "numeric"} autoComplete="off" spellCheck={false}
              value={display} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} aria-label={hideLabel ? label : undefined}
              aria-valuenow={minor === null ? undefined : minor / pow10(info.digits)} aria-valuetext={minor === null ? "Vazio" : money(minor)}
              aria-valuemin={min === undefined ? undefined : min / pow10(info.digits)} aria-valuemax={max === undefined ? undefined : max / pow10(info.digits)}
              onChange={event => applyRaw(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onKeyDown={onKeyDown} onPaste={onPaste} onFocus={() => setFocused(true)}
              onBlur={event => { setFocused(false); setTouched(true); if (draft) setDraft(settle(draft, info.digits)); onBlur?.(event); }} />
          </span>
          {info.position === "suffix" && <SymbolSlot symbol={info.symbol} reduced={reduced} />}
        </motion.div>
      </div>

    </div>

    {range && <div className={styles.toolbar}>
      <span id={rangeId} className={styles.range} data-flash={limitFlash > 0 || undefined}>{range}</span>
    </div>}

    <AnimatePresence initial={false}>
      {(message || description) && <motion.span key="message" className={styles.messageSlot} initial={reduced ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0, transition: reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.instant } } }}
        transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span key={message ?? description} id={message ? errorId : hintId} className={message ? styles.error : styles.hint} role={message ? "alert" : undefined}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, transition: { duration: duration.instant } }} transition={{ duration: reduced ? duration.instant : duration.standard, ease: enterEase }}>{message ?? description}</motion.span>
        </AnimatePresence>
      </motion.span>}
    </AnimatePresence>

    {name && <input type="hidden" name={name} value={minor ?? ""} />}
    <span className={styles.srOnly} role="status" aria-live="polite">{announcement}</span>
  </div>;
});

MoneyInput.displayName = "MoneyInput";

export default MoneyInput;
