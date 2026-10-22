"use client";

/**
 * The shared modal shell and form parts of the book modals (docs/DESIGN.md 10.1-10.3, 11, 15).
 *
 * - One limestone-glass panel over the dimmed hall: fade + scale 0.98 -> 1 in 220 ms, out in
 *   160 ms; the backdrop fades in 200 ms.
 * - Focus moves into the modal, Tab is trapped inside it, and focus returns to the element
 *   that opened it on close.
 * - Esc and a click on the backdrop close it, unless it is busy (saving).
 * - While a modal is open, the hall ignores the keyboard (`aria-modal` is checked there).
 * - Modals render into <body>, so one opened from inside another is not clipped by it.
 */

import { ChevronDown, CircleAlert, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

import { ApiError } from "@/lib/api";
import { t, type Language, type MessageKey } from "@/lib/i18n";

const IN_MS = 220;
const OUT_MS = 160;
const BACKDROP_MS = 200;

/** Open modals, innermost last: only the top one answers Esc. */
const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Panel width in CSS pixels (docs/DESIGN.md: 560 for forms). */
  width?: number;
  /** Saving: Esc, the backdrop and the close button do nothing. */
  busy?: boolean;
  /** `alertdialog` for confirmations. */
  role?: "dialog" | "alertdialog";
  /** Element to focus first (defaults to the first focusable element). */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Extra content described by the dialog (alertdialog body). */
  describedBy?: string;
  testId?: string;
  language: Language;
  /** Called after the closing animation, when the modal has left the DOM. */
  onExited?: () => void;
}

export function Modal(props: ModalProps) {
  const { open, onClose, title, children, footer, width = 560, busy = false, role = "dialog", initialFocus, describedBy, testId, language, onExited } = props;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const exitedRef = useRef(onExited);
  exitedRef.current = onExited;

  // Mount, then show on the next frames so the enter transition runs; hide, then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setShown(false);
    const timer = setTimeout(() => {
      setMounted(false);
      exitedRef.current?.();
    }, OUT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Focus in on open, back out on close.
  useEffect(() => {
    if (!mounted || !open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) (initialFocus?.current ?? focusables(panel)[0] ?? panel).focus({ preventScroll: true });
    return () => {
      const previous = restoreRef.current;
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // initialFocus is a ref: reading it once on open is intended.
  }, [mounted, open]);

  // Esc closes the top modal (capture phase, so the hall's own Esc handlers never see it).
  useEffect(() => {
    if (!mounted || !open) return;
    const token = Symbol("modal");
    stack.push(token);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || stack.at(-1) !== token) return;
      // An inline editor inside the modal (a category rename) handles its own Esc.
      if (event.target instanceof Element && event.target.closest("[data-local-escape]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!busyRef.current) closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(token), 1);
    };
  }, [mounted, open]);

  if (!mounted) return null;

  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    // Events from a modal opened inside this one reach here through the React tree: not ours.
    if (!panelRef.current.contains(event.target as Node)) return;
    const items = focusables(panelRef.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const visible = shown && open;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      style={{ opacity: visible ? 1 : 0, transition: `opacity ${visible ? BACKDROP_MS : OUT_MS}ms ${visible ? "var(--ease-enter)" : "var(--ease-exit)"}` }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      data-testid={testId ? `${testId}-backdrop` : undefined}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={trap}
        data-testid={testId}
        data-state={visible ? "open" : "closing"}
        className="panel flex max-h-[calc(100dvh-32px)] w-full flex-col rounded-panel text-ink outline-none"
        style={{
          maxWidth: width,
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1)" : "scale(0.98)",
          transition: visible
            ? `opacity ${IN_MS}ms var(--ease-enter), transform ${IN_MS}ms var(--ease-enter)`
            : `opacity ${OUT_MS}ms var(--ease-exit), transform ${OUT_MS}ms var(--ease-exit)`,
        }}
      >
        <div className="flex items-center justify-between gap-4 ps-6 pe-3 pt-4 pb-2">
          <h2 id={titleId} className={language === "ar" ? "text-21 font-bold" : "text-21 font-semibold"}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t("action.close", {}, language)}
            data-testid={testId ? `${testId}-close` : undefined}
            className="flex size-10 items-center justify-center rounded-control text-slate transition-colors duration-(--motion-fast) ease-out hover:bg-ink/6 hover:text-ink disabled:opacity-40"
          >
            <X size={20} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-6">{children}</div>
        {footer ? <div className="flex flex-wrap items-center justify-end gap-3 border-t border-ink/8 px-6 py-4">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

// --- Buttons ----------------------------------------------------------------------------------

const BUTTON = "inline-flex h-10 items-center justify-center gap-2 rounded-control px-4 text-14 font-medium transition-colors duration-(--motion-fast) ease-out disabled:cursor-not-allowed";

export const buttonClass = {
  primary: `${BUTTON} bg-lapis text-white hover:bg-[#3a5aab] disabled:bg-lapis/45`,
  secondary: `${BUTTON} border border-limestone bg-paper/60 text-ink hover:border-slate/40 disabled:opacity-50`,
  destructive: `${BUTTON} bg-rubric text-white hover:bg-[#bb4a3c] disabled:bg-rubric/45`,
  /** A quiet text action (inside drop zones and under covers). */
  link: "inline-flex items-center gap-1.5 rounded-[6px] text-14 font-medium text-lapis underline-offset-4 hover:underline disabled:opacity-50",
} as const;

// --- Fields -----------------------------------------------------------------------------------

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-12 text-rubric" data-testid="field-error">
      <CircleAlert size={14} strokeWidth={1.75} className="mt-[3px] shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function Field(props: {
  label: string;
  htmlFor?: string;
  labelId?: string;
  required?: boolean;
  error?: string | null;
  errorId?: string;
  language: Language;
  children: ReactNode;
}) {
  const { label, htmlFor, labelId, required, error, errorId, language, children } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <label id={labelId} htmlFor={htmlFor} className={language === "ar" ? "text-14 font-semibold text-ink" : "text-14 font-medium text-ink"}>
        {label}
        {required ? (
          <>
            <span className="ms-0.5 text-rubric" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> ({t("field.required", {}, language)})</span>
          </>
        ) : null}
      </label>
      {children}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/** `muted`: a select still showing its placeholder. */
export const inputClass = (invalid = false, muted = false) =>
  `w-full rounded-control border bg-paper px-3 text-16 ${muted ? "text-slate" : "text-ink"} placeholder:text-slate transition-colors duration-(--motion-fast) ease-out disabled:opacity-60 ${
    invalid ? "border-rubric/60" : "border-ink/14 hover:border-ink/24"
  }`;

export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  const { invalid, className, children, ...rest } = props;
  return (
    <div className="relative">
      <select {...rest} className={`${inputClass(invalid, rest.value === "")} h-10 appearance-none pe-9 ${className ?? ""}`}>
        {children}
      </select>
      <ChevronDown size={18} strokeWidth={1.5} className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-slate" aria-hidden="true" />
    </div>
  );
}

/** Pill group: the selected segment is ink with white text (docs/DESIGN.md 10.3). */
export function Segmented<T extends string>(props: {
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  testId?: string;
}) {
  const { value, options, onChange, labelledBy, describedBy, invalid, testId } = props;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const onKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const forward = ["ArrowRight", "ArrowDown"];
    const backward = ["ArrowLeft", "ArrowUp"];
    if (![...forward, ...backward].includes(event.key)) return;
    event.preventDefault();
    // Arrow keys follow the reading order of the UI (mirrored in Arabic).
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    let step = forward.includes(event.key) ? 1 : -1;
    if (rtl && (event.key === "ArrowLeft" || event.key === "ArrowRight")) step = -step;
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      data-testid={testId}
      className={`inline-flex w-full gap-1 rounded-[20px] border bg-paper p-1 ${invalid ? "border-rubric/60" : "border-ink/14"}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (selectedIndex < 0 && index === 0) ? 0 : -1}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`min-h-8 min-w-0 flex-1 rounded-[16px] px-2.5 py-1 text-center text-14 leading-tight font-medium text-balance transition-colors duration-(--motion-fast) ease-out ${
              selected ? "bg-ink text-white" : "text-ink hover:bg-ink/6"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Errors -----------------------------------------------------------------------------------

const ERROR_KEYS: Partial<Record<string, MessageKey>> = {
  not_pdf: "error.not_pdf",
  file_too_large: "error.file_too_large",
  pdf_encrypted: "error.pdf_encrypted",
  pdf_empty: "error.pdf_empty",
  pdf_damaged: "error.pdf_damaged",
  invalid_cover: "error.invalid_cover",
  upload_not_found: "error.upload_not_found",
  category_not_found: "error.category_not_found",
  book_not_found: "error.book_not_found",
  network_error: "error.network_error",
};

/** What happened and what to do, in the UI language (docs/DESIGN.md 12.3). */
export function errorText(error: unknown, language: Language): string {
  if (error instanceof ApiError) {
    const key = ERROR_KEYS[error.code];
    if (key) return t(key, {}, language);
    return t("error.other", { status: String(error.status) }, language);
  }
  return t("error.other", { status: "?" }, language);
}
