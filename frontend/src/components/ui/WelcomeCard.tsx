"use client";

/**
 * First launch (UC-05, docs/DESIGN.md 12.2). With no categories, a card over the empty hall
 * creates the first one, typed or from a suggestion chip. Once a category exists and no book
 * does yet, a short hint points to Add book instead.
 */

import { Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import * as api from "@/lib/api";
import { t, type MessageKey } from "@/lib/i18n";
import { useLibraryStore } from "@/store/useLibraryStore";

import { CATEGORY_NAME_MAX, createCategoryNamed } from "./CategoryManager";
import { FieldError, buttonClass, errorText, inputClass } from "./Modal";

const CHIPS: MessageKey[] = ["welcome.chip.programming", "welcome.chip.history", "welcome.chip.novels", "welcome.chip.arabic"];

export function WelcomeCard() {
  const loaded = useLibraryStore((state) => state.loaded);
  const categoryCount = useLibraryStore((state) => state.categories.length);
  const bookCount = useLibraryStore((state) => state.books.length);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const titleId = useId();

  if (!loaded) return null;

  if (categoryCount > 0) {
    if (bookCount > 0) return null;
    return (
      <div className="pointer-events-none absolute inset-x-0 top-[84px] z-30 flex justify-center px-4">
        <div className="panel pointer-events-auto flex max-w-[560px] items-center gap-4 rounded-panel py-3 ps-5 pe-3" role="note" data-testid="add-first-hint">
          <p className="text-14 text-ink">{t("welcome.addFirst", {}, language)}</p>
          <button type="button" className={`${buttonClass.primary} shrink-0`} onClick={() => useLibraryStore.getState().openAddBook(null)} data-testid="add-first-button">
            <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
            {t("action.addBook", {}, language)}
          </button>
        </div>
      </div>
    );
  }

  const create = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(t("invalid.categoryName", {}, language));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createCategoryNamed(trimmed, language);
    } catch (failure) {
      setError(failure instanceof api.ApiError && failure.code === "category_name_taken" ? t("error.category_name_taken", {}, language) : errorText(failure, language));
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void create(name);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4">
      <section className="panel pointer-events-auto flex w-full max-w-[480px] flex-col gap-5 rounded-panel p-7" aria-labelledby={titleId} data-testid="welcome-card">
        <div className="flex flex-col gap-2">
          <h2 id={titleId} className={language === "ar" ? "text-24 font-bold" : "text-24 font-semibold"}>
            {t("welcome.title", {}, language)}
          </h2>
          <p className="text-16 text-slate">{t("welcome.body", {}, language)}</p>
        </div>
        <form className="flex flex-col gap-1.5" onSubmit={onSubmit} noValidate>
          <label htmlFor={inputId} className={language === "ar" ? "text-14 font-semibold" : "text-14 font-medium"}>
            {t("category.name", {}, language)}
          </label>
          <input
            id={inputId}
            type="text"
            dir="auto"
            value={name}
            maxLength={CATEGORY_NAME_MAX}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            className={`${inputClass(error !== null)} h-10`}
            data-testid="welcome-name"
          />
          {error ? <FieldError id={errorId}>{error}</FieldError> : null}
          <button type="submit" className={`${buttonClass.primary} mt-2`} disabled={busy} data-testid="welcome-create">
            {t("welcome.action", {}, language)}
          </button>
        </form>
        <div className="flex flex-col gap-2.5">
          <p className="text-14 text-slate">{t("welcome.suggestions", {}, language)}</p>
          <div className="flex flex-wrap gap-2">
            {CHIPS.map((key) => (
              <button
                key={key}
                type="button"
                disabled={busy}
                onClick={() => void create(t(key, {}, language))}
                className="h-9 rounded-full border border-ink/14 bg-paper px-4 text-14 font-medium text-ink transition-colors duration-(--motion-fast) ease-out hover:border-lapis/50 hover:text-lapis disabled:opacity-50"
                data-testid="welcome-chip"
              >
                {t(key, {}, language)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
