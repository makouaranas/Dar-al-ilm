"use client";

/**
 * Categories in Settings (UC-01): create, rename inline, and delete. A category that still has
 * books can only go once its books move to another category (`DELETE ...?move_to=`); the books
 * take the first free slots there and the hall closes the gap. Plaques follow every change live.
 */

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import * as api from "@/lib/api";
import type { Category } from "@/lib/api";
import { t, type Language } from "@/lib/i18n";
import { useLibraryStore } from "@/store/useLibraryStore";

import { FieldError, Modal, Select, buttonClass, errorText, inputClass } from "./Modal";

/** docs/ARCHITECTURE.md 5: category names are 1-40 characters. */
export const CATEGORY_NAME_MAX = 40;

const ICON_BUTTON =
  "flex size-9 items-center justify-center rounded-control text-slate transition-colors duration-(--motion-fast) ease-out hover:bg-ink/6 hover:text-ink disabled:opacity-40";

function categoryError(error: unknown, language: Language): string {
  if (error instanceof api.ApiError && error.code === "category_name_taken") return t("error.category_name_taken", {}, language);
  return errorText(error, language);
}

/** Creates a category and shows it in the hall at once. Throws ApiError on failure. */
export async function createCategoryNamed(name: string, language: Language): Promise<Category> {
  const category = await api.createCategory(name);
  const store = useLibraryStore.getState();
  store.upsertCategory(category);
  store.showToast(t("category.created", {}, language));
  return category;
}

export function CategoryManager({ language }: { language: Language }) {
  const categories = useLibraryStore((state) => state.categories);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ id: number; name: string; error: string | null; saving: boolean } | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const newId = useId();
  const newErrorId = useId();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      setCreateError(t("invalid.categoryName", {}, language));
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await createCategoryNamed(name, language);
      setNewName("");
    } catch (error) {
      setCreateError(categoryError(error, language));
    } finally {
      setCreating(false);
    }
  };

  const rename = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    const current = categories.find((category) => category.id === editing.id);
    if (!name) {
      setEditing({ ...editing, error: t("invalid.categoryName", {}, language) });
      return;
    }
    if (current && name === current.name) {
      setEditing(null);
      return;
    }
    setEditing({ ...editing, saving: true, error: null });
    try {
      const saved = await api.renameCategory(editing.id, name);
      const store = useLibraryStore.getState();
      store.upsertCategory(saved);
      store.showToast(t("category.renamed", {}, language));
      setEditing(null);
    } catch (error) {
      setEditing({ ...editing, saving: false, error: categoryError(error, language) });
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="category-manager">
      {categories.length === 0 ? (
        <p className="text-14 text-slate">{t("category.none", {}, language)}</p>
      ) : (
        <ul className="flex flex-col rounded-control border border-ink/10 bg-paper/60" data-testid="category-list">
          {categories.map((category) => (
            <li key={category.id} className="border-b border-ink/8 px-3 py-2 last:border-b-0" data-testid="category-row" data-id={category.id}>
              {editing?.id === category.id ? (
                <RenameRow
                  value={editing.name}
                  error={editing.error}
                  saving={editing.saving}
                  language={language}
                  onChange={(name) => setEditing({ ...editing, name, error: null })}
                  onSave={rename}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex min-h-9 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-16 text-ink" dir="auto" data-testid="category-name">
                    {category.name}
                  </span>
                  <span className="tabular shrink-0 text-12 text-slate">{t("count.books", { count: category.book_count }, language)}</span>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={t("category.renameLabel", { name: category.name }, language)}
                    onClick={() => setEditing({ id: category.id, name: category.name, error: null, saving: false })}
                    data-testid="category-rename"
                  >
                    <Pencil size={18} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`${ICON_BUTTON} hover:text-rubric`}
                    aria-label={t("category.deleteLabel", { name: category.name }, language)}
                    onClick={() => setDeleting(category)}
                    data-testid="category-delete"
                  >
                    <Trash2 size={18} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="flex flex-col gap-1.5" onSubmit={create} noValidate>
        <label htmlFor={newId} className={language === "ar" ? "text-14 font-semibold" : "text-14 font-medium"}>
          {t("category.new", {}, language)}
        </label>
        <div className="flex gap-2">
          <input
            id={newId}
            type="text"
            dir="auto"
            value={newName}
            maxLength={CATEGORY_NAME_MAX}
            placeholder={t("category.name", {}, language)}
            aria-invalid={createError !== null}
            aria-describedby={createError ? newErrorId : undefined}
            onChange={(event) => {
              setNewName(event.target.value);
              setCreateError(null);
            }}
            className={`${inputClass(createError !== null)} h-10 min-w-0 flex-1`}
            data-testid="category-new-name"
          />
          <button type="submit" className={buttonClass.secondary} disabled={creating} data-testid="category-create">
            <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
            {t("category.create", {}, language)}
          </button>
        </div>
        {createError ? <FieldError id={newErrorId}>{createError}</FieldError> : null}
      </form>

      <DeleteCategoryDialog category={deleting} onClose={() => setDeleting(null)} language={language} />
    </div>
  );
}

function RenameRow(props: {
  value: string;
  error: string | null;
  saving: boolean;
  language: Language;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { value, error, saving, language, onChange, onSave, onCancel } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="flex flex-col gap-1.5 py-1" data-local-escape>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          dir="auto"
          value={value}
          maxLength={CATEGORY_NAME_MAX}
          aria-label={t("category.name", {}, language)}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSave();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          className={`${inputClass(error !== null)} h-9 min-w-0 flex-1`}
          data-testid="category-rename-input"
        />
        <button type="button" className={`${buttonClass.primary} h-9 px-3`} onClick={onSave} disabled={saving} data-testid="category-rename-save">
          {t("action.save", {}, language)}
        </button>
        <button type="button" className={`${buttonClass.secondary} h-9 px-3`} onClick={onCancel} disabled={saving}>
          {t("action.cancel", {}, language)}
        </button>
      </div>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

function DeleteCategoryDialog({ category, onClose, language }: { category: Category | null; onClose: () => void; language: Language }) {
  const categories = useLibraryStore((state) => state.categories);
  // Keep the last category on screen while the dialog fades out.
  const [shown, setShown] = useState<Category | null>(category);
  if (category && category !== shown) setShown(category);
  const [moveTo, setMoveTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const selectId = useId();
  const others = shown ? categories.filter((candidate) => candidate.id !== shown.id) : [];

  useEffect(() => {
    if (!category) return;
    setMoveTo(categories.find((candidate) => candidate.id !== category.id)?.id ?? null);
    setError(null);
    setBusy(false);
    // Chosen once per opening.
  }, [category]);

  if (!shown) return null;
  const hasBooks = shown.book_count > 0;
  const canDelete = !busy && (!hasBooks || moveTo !== null);

  const confirm = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteCategory(shown.id, hasBooks ? moveTo ?? undefined : undefined);
      const store = useLibraryStore.getState();
      await store.refreshLibrary();
      store.showToast(t("category.deleted", {}, language));
      onClose();
    } catch (failure) {
      setError(errorText(failure, language));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <button ref={cancelRef} type="button" className={buttonClass.secondary} onClick={onClose} disabled={busy} data-testid="category-delete-cancel">
        {t("action.cancel", {}, language)}
      </button>
      <button type="button" className={buttonClass.destructive} onClick={confirm} disabled={!canDelete} data-testid="category-delete-confirm">
        {hasBooks ? t("category.moveAndDelete", {}, language) : t("category.deleteTitle", {}, language)}
      </button>
    </>
  );

  return (
    <Modal
      open={category !== null}
      onClose={onClose}
      title={t("category.deleteTitle", {}, language)}
      footer={footer}
      width={460}
      busy={busy}
      role="alertdialog"
      describedBy={bodyId}
      initialFocus={cancelRef}
      testId="category-delete-dialog"
      language={language}
      onExited={() => setShown(null)}
    >
      <div id={bodyId} className="flex flex-col gap-4">
        {hasBooks ? (
          <p className="rounded-control border-s-[3px] border-ochre bg-limestone/70 px-4 py-3 text-14 text-ink" data-testid="category-not-empty">
            {t("error.category_not_empty", { name: shown.name, books: t("count.books", { count: shown.book_count }, language) }, language)}
          </p>
        ) : (
          <p className="text-16 text-ink">{t("category.deleteEmpty", { name: shown.name }, language)}</p>
        )}
        {hasBooks ? (
          others.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={selectId} className={language === "ar" ? "text-14 font-semibold" : "text-14 font-medium"}>
                {t("category.moveTo", {}, language)}
              </label>
              <Select id={selectId} value={moveTo ?? ""} onChange={(event) => setMoveTo(Number(event.target.value))} data-testid="category-move-to">
                {others.map((candidate) => (
                  <option key={candidate.id} value={candidate.id} className="text-ink">
                    {candidate.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <FieldError>{t("category.noOther", {}, language)}</FieldError>
          )
        ) : null}
        {error ? <FieldError>{error}</FieldError> : null}
      </div>
    </Modal>
  );
}
