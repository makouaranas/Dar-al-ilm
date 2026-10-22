"use client";

/**
 * Reader controls (docs/DESIGN.md section 10.2, docs/ARCHITECTURE.md sections 11.3-11.4).
 *
 * A close button with the title at the top, and one floating pill at the bottom centre:
 * previous / next, a page slider with a live page tooltip, the current pages (click to type
 * a page number), and zoom controls. Both hide after 2.5 s without mouse movement.
 *
 * The page navigation (previous, slider, next) follows the open book's reading direction, so
 * it always matches the arrow keys and the side of the page that turns; the zoom controls
 * follow the UI language.
 */

import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import type { Book } from "@/lib/api";
import { formatNumber, t } from "@/lib/i18n";
import { getSpread, spreadCount, spreadForPage, spreadPages } from "@/lib/spreads";
import { MAX_ZOOM, MIN_ZOOM, useLibraryStore } from "@/store/useLibraryStore";

import { zoomCommands } from "./ZoomOverlay";

export const TOOLBAR_HIDE_MS = 2500;

function pagesLabel(spreadIndex: number, book: Book): string {
  const pages = spreadPages(getSpread(spreadIndex, book.page_count, book.reading_direction));
  // Page numbers are not grouped ("1160", not "1,160").
  return pages.map((page) => String(page)).join("–");
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
  testId,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink transition-colors duration-(--motion-fast) ease-out hover:bg-ink/8 disabled:text-slate/50 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

export interface ReaderToolbarProps {
  book: Book;
  onClose: () => void;
  /** Turn one page forward or back in reading order (the reader queues it). */
  onTurn: (forward: boolean) => void;
}

export function ReaderToolbar({ book, onClose, onTurn }: ReaderToolbarProps) {
  const language = useLibraryStore((state) => state.settings.ui_language);
  const spreadIndex = useLibraryStore((state) => state.reader.spreadIndex);
  const zoom = useLibraryStore((state) => state.reader.zoom);
  const flipLocked = useLibraryStore((state) => state.reader.flipLocked);
  const setSpreadIndex = useLibraryStore((state) => state.setSpreadIndex);

  const lastSpread = spreadCount(book.page_count) - 1;
  const rtl = book.reading_direction === "RTL";

  // --- Auto-hide ---------------------------------------------------------------------------
  const [awake, setAwake] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sliding, setSliding] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const pinned = hovered || focused || sliding !== null || editing;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      setAwake(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setAwake(false), TOOLBAR_HIDE_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("pointerdown", wake);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("pointerdown", wake);
    };
  }, []);
  const visible = awake || pinned;
  const fade = `transition-[opacity,translate] duration-(--motion-base) ease-enter ${
    visible ? "opacity-100" : "pointer-events-none opacity-0"
  }`;

  // --- Slider ------------------------------------------------------------------------------
  const sliderRef = useRef<HTMLInputElement>(null);
  const sliderValue = sliding ?? spreadIndex;
  useEffect(() => {
    // Jump when the slider is released (the native "change" event), not on every step.
    const slider = sliderRef.current;
    if (!slider) return;
    const onChange = () => {
      setSpreadIndex(Number(slider.value));
      setSliding(null);
    };
    slider.addEventListener("change", onChange);
    return () => slider.removeEventListener("change", onChange);
  }, [setSpreadIndex]);
  const fraction = lastSpread > 0 ? sliderValue / lastSpread : 0;

  // --- Page input --------------------------------------------------------------------------
  const [draft, setDraft] = useState("");
  const startEditing = () => {
    const first = spreadPages(getSpread(spreadIndex, book.page_count, book.reading_direction))[0] ?? 1;
    setDraft(String(first));
    setEditing(true);
  };
  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      const page = Number.parseInt(draft, 10);
      if (Number.isFinite(page)) {
        setSpreadIndex(spreadForPage(Math.min(Math.max(1, page), book.page_count), book.page_count));
      }
      setEditing(false);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setEditing(false);
    }
  };

  const title = book.author
    ? `${book.title}${/[؀-ۿ]/.test(book.title) ? "، " : ", "}${book.author}`
    : book.title;
  const PreviousIcon = rtl ? ChevronRight : ChevronLeft;
  const NextIcon = rtl ? ChevronLeft : ChevronRight;

  return (
    <>
      <div className={`absolute start-5 top-5 flex max-w-[70%] items-center gap-3 ${fade}`} data-testid="reader-topbar">
        <button
          type="button"
          aria-label={t("reader.close", {}, language)}
          title={t("reader.close", {}, language)}
          data-testid="reader-close"
          onClick={onClose}
          className="panel inline-flex size-10 shrink-0 items-center justify-center rounded-full text-ink transition-colors duration-(--motion-fast) ease-out hover:bg-paper"
        >
          <X size={20} strokeWidth={1.5} />
        </button>
        <p className="truncate text-14 text-limestone" dir="auto" data-testid="reader-title">
          {title}
        </p>
      </div>

      <div
        role="toolbar"
        aria-label={t("reader.toolbar", {}, language)}
        data-testid="reader-toolbar"
        data-visible={visible}
        className={`panel absolute bottom-6 left-1/2 flex h-13 -translate-x-1/2 items-center gap-1 rounded-full px-2 text-ink ${fade} ${
          visible ? "translate-y-0" : "translate-y-1"
        }`}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <div className="flex items-center gap-1" dir={rtl ? "rtl" : "ltr"} data-testid="reader-nav">
          <IconButton
            label={t("reader.previous", {}, language)}
            testId="reader-previous"
            disabled={flipLocked || spreadIndex <= 0}
            onClick={() => onTurn(false)}
          >
            <PreviousIcon size={20} strokeWidth={1.5} />
          </IconButton>

          <div className="relative mx-2 flex w-40 items-center sm:w-56">
            {sliding !== null && (
              <span
                className="panel tabular pointer-events-none absolute -top-11 rounded-full px-3 py-1 text-12 whitespace-nowrap text-ink"
                style={{ insetInlineStart: `calc(${fraction * 100}% - ${fraction * 14}px + 7px)`, translate: rtl ? "50% 0" : "-50% 0" }}
                data-testid="reader-slider-tooltip"
              >
                <bdi dir="ltr">{pagesLabel(sliding, book)}</bdi>
              </span>
            )}
            <input
              ref={sliderRef}
              type="range"
              min={0}
              max={lastSpread}
              step={1}
              value={sliderValue}
              disabled={flipLocked}
              aria-label={t("reader.position", {}, language)}
              aria-valuetext={pagesLabel(sliderValue, book)}
              data-testid="reader-slider"
              onChange={(event) => setSliding(Number(event.target.value))}
              className="h-5 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-default [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-lapis [&::-moz-range-track]:h-0.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:[background:var(--track)] [&::-webkit-slider-runnable-track]:h-0.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:[background:var(--track)] [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-lapis [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgb(30_34_48/0.35)]"
              style={
                {
                  "--fill": `${fraction * 100}%`,
                  "--track": `linear-gradient(to ${rtl ? "left" : "right"}, var(--lapis) var(--fill), rgb(30 34 48 / 0.16) var(--fill))`,
                } as CSSProperties
              }
            />
          </div>

          {editing ? (
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              aria-label={t("reader.pageInput", {}, language)}
              data-testid="reader-page-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={onInputKey}
              onBlur={() => setEditing(false)}
              onFocus={(event) => event.currentTarget.select()}
              dir="ltr"
              className="tabular h-8 w-16 rounded-control border border-ink/14 bg-paper px-2 text-center text-14 text-ink"
            />
          ) : (
            <button
              type="button"
              data-testid="reader-pages"
              aria-label={t("reader.goToPage", {}, language)}
              title={t("reader.goToPage", {}, language)}
              onClick={startEditing}
              className="tabular h-8 rounded-control px-2 text-14 whitespace-nowrap text-ink transition-colors duration-(--motion-fast) ease-out hover:bg-ink/8"
            >
              <bdi dir="ltr">
                {t("reader.pageLabel", { pages: pagesLabel(spreadIndex, book), total: String(book.page_count) }, language)}
              </bdi>
            </button>
          )}

          <IconButton
            label={t("reader.next", {}, language)}
            testId="reader-next"
            disabled={flipLocked || spreadIndex >= lastSpread}
            onClick={() => onTurn(true)}
          >
            <NextIcon size={20} strokeWidth={1.5} />
          </IconButton>
        </div>

        <span className="mx-2 h-6 w-px bg-ink/12" aria-hidden />

        <div className="flex items-center gap-1" data-testid="reader-zoom">
          <IconButton
            label={t("reader.zoomOut", {}, language)}
            testId="reader-zoom-out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomCommands.step(-1)}
          >
            <Minus size={20} strokeWidth={1.5} />
          </IconButton>
          <button
            type="button"
            data-testid="reader-zoom-reset"
            aria-label={t("reader.resetZoom", {}, language)}
            title={t("reader.resetZoom", {}, language)}
            onClick={() => zoomCommands.reset()}
            className="tabular h-8 min-w-14 rounded-control px-2 text-14 text-ink transition-colors duration-(--motion-fast) ease-out hover:bg-ink/8"
          >
            <bdi dir="ltr">{`${formatNumber(Math.round(zoom * 100))}%`}</bdi>
          </button>
          <IconButton
            label={t("reader.zoomIn", {}, language)}
            testId="reader-zoom-in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomCommands.step(1)}
          >
            <Plus size={20} strokeWidth={1.5} />
          </IconButton>
        </div>
      </div>
    </>
  );
}
