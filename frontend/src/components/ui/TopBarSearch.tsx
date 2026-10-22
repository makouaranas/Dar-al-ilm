"use client";

/**
 * The search pill (docs/DESIGN.md section 10.3, docs/ARCHITECTURE.md section 12).
 *
 * `/` focuses it; results filter as you type (title, author, category, forgiving of case,
 * accents and Arabic diacritics); arrow keys move through up to 8 results; Enter or a click
 * flies the camera to the book, which then glows; Esc clears and closes.
 */

import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { playerCommands } from "@/components/3d/PlayerControls";
import { apiUrl } from "@/lib/api";
import { t } from "@/lib/i18n";
import { buildIndex, search, type SearchResult } from "@/lib/search";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

const searchDebug: { lastChosen: { id: number; at: number; flying: boolean } | null } = { lastChosen: null };

function isTypingElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function TopBarSearch() {
  const books = useLibraryStore((state) => state.books);
  const categories = useLibraryStore((state) => state.categories);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const index = useMemo(() => buildIndex(books, categories), [books, categories]);
  const results = useMemo(() => search(index, query), [index, query]);
  const showPanel = open && query.trim().length > 0;

  useEffect(() => setActive(0), [query]);

  // "/" focuses the field unless the user is typing somewhere else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || isTypingElsewhere(event.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (result: SearchResult | undefined) => {
    if (!result) return;
    setOpen(false);
    inputRef.current?.blur();
    const flying = playerCommands.flyToBook(result.book.id);
    searchDebug.lastChosen = { id: result.book.id, at: performance.now(), flying };
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      setOpen(true);
      setActive((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  useEffect(() => {
    registerTestHook("search", () => ({ ...searchDebug, results: results.map((r) => ({ id: r.book.id, title: r.book.title, match: r.match })) }));
  }, [results]);

  const activeId = showPanel && results[active] ? `${listId}-${results[active].book.id}` : undefined;

  return (
    <div className="pointer-events-auto relative w-[min(520px,calc(100vw-2rem))]" data-testid="search">
      <label className="panel flex h-11 items-center gap-2.5 rounded-full ps-4 pe-2 text-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-lapis">
        <Search size={20} strokeWidth={1.5} className="shrink-0 text-slate" aria-hidden="true" />
        <span className="sr-only">{t("search.label", {}, language)}</span>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          value={query}
          placeholder={t("search.placeholder", {}, language)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          data-testid="search-input"
          className="h-full min-w-0 flex-1 bg-transparent text-16 text-ink outline-none placeholder:text-slate [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-[6px] border border-ink/12 bg-paper px-1.5 font-sans text-12 text-slate" aria-hidden="true">
          /
        </kbd>
      </label>

      {showPanel ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t("search.results", {}, language)}
          className="panel absolute inset-x-0 top-[calc(100%+8px)] max-h-[70vh] overflow-y-auto rounded-panel p-1.5"
          data-testid="search-results"
        >
          {results.length === 0 ? (
            <p className="px-3 py-3 text-14 text-slate" data-testid="search-empty">
              {t("search.noResults", { query: query.trim() }, language)}
            </p>
          ) : (
            results.map((result, i) => (
              <div
                key={result.book.id}
                id={`${listId}-${result.book.id}`}
                role="option"
                aria-selected={i === active}
                data-testid="search-result"
                data-book={result.book.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(result)}
                className={`flex cursor-pointer items-center gap-3 rounded-control px-2 py-1.5 transition-colors duration-(--motion-fast) ease-out ${
                  i === active ? "bg-lapis/10" : ""
                }`}
              >
                <img
                  src={apiUrl(result.book.cover_url)}
                  alt=""
                  width={40}
                  height={56}
                  loading="lazy"
                  className="h-14 w-10 shrink-0 rounded-[4px] bg-paper object-cover shadow-[0_1px_3px_rgb(30_34_48/0.2)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-14 font-medium text-ink" dir="auto">
                    {result.book.title}
                  </p>
                  <p className="truncate text-12 text-slate" dir="auto">
                    {[result.book.author, result.category?.name].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
