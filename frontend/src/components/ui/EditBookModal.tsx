"use client";

/**
 * Edit book (FR-10): title, author, notes, reading direction and category (the book moves to
 * the first free slot of its new shelf at once), and the cover: replace it with a PNG, JPEG or
 * WebP image, or go back to the automatic Page 1 snapshot.
 */

import { ImagePlus, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import * as api from "@/lib/api";
import type { Book, BookPatch, ReadingDirection } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLibraryStore } from "@/store/useLibraryStore";

import { COVER_TYPES, CoverPreview, coverProblem, type CoverChoice } from "./AddBookModal";
import { Field, FieldError, Modal, Segmented, Select, buttonClass, errorText, inputClass } from "./Modal";

type CoverAction = { kind: "replace"; choice: CoverChoice } | { kind: "revert" } | null;

export function EditBookModal() {
  const bookId = useLibraryStore((state) => state.editBookFor);
  const book = useLibraryStore((state) => state.books.find((candidate) => candidate.id === state.editBookFor) ?? null);
  const categories = useLibraryStore((state) => state.categories);
  const language = useLibraryStore((state) => state.settings.ui_language);
  // Keep showing the last book while the modal fades out.
  const [shown, setShown] = useState<Book | null>(book);
  if (book && book !== shown) setShown(book);

  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [notes, setNotes] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [direction, setDirection] = useState<ReadingDirection>("LTR");
  const [coverAction, setCoverAction] = useState<CoverAction>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const ids = { title: useId(), author: useId(), notes: useId(), category: useId(), direction: useId(), titleError: useId() };

  const open = bookId !== null && book !== null;

  // Load the book's values each time the modal opens.
  useEffect(() => {
    if (!open || !book) return;
    setTitle(book.title);
    setAuthor(book.author ?? "");
    setNotes(book.notes ?? "");
    setCategoryId(book.category_id);
    setDirection(book.reading_direction);
    setCoverAction(null);
    setCoverError(null);
    setSaving(false);
    setSaveError(null);
    // Only on opening: later store updates of this book must not reset the form.
  }, [open, bookId]);

  useEffect(() => {
    if (coverAction?.kind !== "replace") return;
    const url = coverAction.choice.url;
    return () => URL.revokeObjectURL(url);
  }, [coverAction]);

  const close = () => {
    if (saving) return;
    useLibraryStore.getState().openEditBook(null);
  };

  const current = shown;
  if (!current) return null;

  const patch: BookPatch = {};
  if (title.trim() !== current.title) patch.title = title.trim();
  if ((author.trim() || null) !== current.author) patch.author = author.trim() || null;
  if ((notes.trim() || null) !== current.notes) patch.notes = notes.trim() || null;
  if (categoryId !== null && categoryId !== current.category_id) patch.category_id = categoryId;
  if (direction !== current.reading_direction) patch.reading_direction = direction;
  const titleValid = title.trim().length > 0;
  const dirty = Object.keys(patch).length > 0 || coverAction !== null;
  const canSave = open && dirty && titleValid && !saving && !coverError;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const store = useLibraryStore.getState();
    try {
      let saved: Book = current;
      if (Object.keys(patch).length > 0) {
        saved = await api.updateBook(current.id, patch);
        store.upsertBook(saved);
      }
      if (coverAction?.kind === "replace") saved = await api.replaceCover(current.id, coverAction.choice.file);
      else if (coverAction?.kind === "revert") saved = await api.revertCover(current.id);
      store.upsertBook(saved);
      store.openEditBook(null);
      store.showToast(t("edit.saved", {}, language));
    } catch (error) {
      if (error instanceof api.ApiError && error.code === "invalid_cover") setCoverError(errorText(error, language));
      else setSaveError(errorText(error, language));
    } finally {
      setSaving(false);
    }
  };

  const chooseCover = (file: File | undefined) => {
    if (!file) return;
    if (coverProblem(file)) {
      setCoverError(t("error.invalid_cover", {}, language));
      return;
    }
    setCoverError(null);
    setCoverAction({ kind: "replace", choice: { file, url: URL.createObjectURL(file) } });
  };

  // What the cover will be after saving.
  const willBeCustom = coverAction ? coverAction.kind === "replace" : current.cover_is_custom;
  const coverSrc =
    coverAction?.kind === "replace"
      ? coverAction.choice.url
      : coverAction?.kind === "revert"
        ? api.pageUrl(current.id, 1, "low")
        : api.apiUrl(current.cover_url);

  const footer = (
    <>
      {saveError ? (
        <div className="me-auto max-w-[300px]">
          <FieldError>{saveError}</FieldError>
        </div>
      ) : null}
      <button type="button" className={buttonClass.secondary} onClick={close} disabled={saving} data-testid="edit-cancel">
        {t("action.cancel", {}, language)}
      </button>
      <button type="submit" form="edit-book-form" className={buttonClass.primary} disabled={!canSave} data-testid="edit-submit">
        {t("action.saveChanges", {}, language)}
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("edit.title", {}, language)}
      footer={footer}
      busy={saving}
      testId="edit-modal"
      language={language}
      initialFocus={titleInput}
      onExited={() => setShown(null)}
    >
      <form id="edit-book-form" onSubmit={onSubmit} noValidate>
        <div className="grid grid-cols-[184px_minmax(0,1fr)] gap-6 max-sm:grid-cols-1">
          <div className="flex flex-col items-start gap-1.5">
            <div className="w-full">
              <CoverPreview
                src={coverSrc}
                title={title || current.title}
                ratio={current.page_height_pt / current.page_width_pt}
                custom={willBeCustom}
                language={language}
                testId="edit-cover"
              />
            </div>
            <p className="tabular text-12 text-slate">{t("count.pages", { count: current.page_count }, language)}</p>
            <input
              ref={coverInput}
              type="file"
              accept={COVER_TYPES.join(",")}
              hidden
              data-testid="edit-cover-input"
              onChange={(event) => {
                chooseCover(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <button type="button" className={buttonClass.link} onClick={() => coverInput.current?.click()} data-testid="edit-cover-replace">
              <ImagePlus size={16} strokeWidth={1.5} aria-hidden="true" />
              {t("cover.replace", {}, language)}
            </button>
            {willBeCustom ? (
              <button
                type="button"
                className={buttonClass.link}
                onClick={() => {
                  setCoverError(null);
                  setCoverAction(current.cover_is_custom ? { kind: "revert" } : null);
                }}
                data-testid="edit-cover-revert"
              >
                <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
                {t("cover.usePage1", {}, language)}
              </button>
            ) : null}
            {coverError ? <FieldError>{coverError}</FieldError> : null}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Field label={t("field.title", {}, language)} htmlFor={ids.title} required error={!titleValid ? t("invalid.title", {}, language) : null} errorId={ids.titleError} language={language}>
              <input
                ref={titleInput}
                id={ids.title}
                type="text"
                dir="auto"
                value={title}
                maxLength={300}
                required
                aria-required="true"
                aria-invalid={!titleValid}
                aria-describedby={!titleValid ? ids.titleError : undefined}
                onChange={(event) => setTitle(event.target.value)}
                className={`${inputClass(!titleValid)} h-10`}
                data-testid="edit-title"
              />
            </Field>
            <Field label={t("field.category", {}, language)} htmlFor={ids.category} required language={language}>
              <Select
                id={ids.category}
                value={categoryId ?? ""}
                required
                aria-required="true"
                onChange={(event) => setCategoryId(Number(event.target.value))}
                data-testid="edit-category"
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id} className="text-ink">
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("field.direction", {}, language)} labelId={ids.direction} required language={language}>
              <Segmented
                value={direction}
                labelledBy={ids.direction}
                options={[
                  { value: "LTR", label: t("direction.LTR", {}, language) },
                  { value: "RTL", label: t("direction.RTL", {}, language) },
                ]}
                onChange={setDirection}
                testId="edit-direction"
              />
            </Field>
            <Field label={t("field.author", {}, language)} htmlFor={ids.author} language={language}>
              <input id={ids.author} type="text" dir="auto" value={author} maxLength={200} onChange={(event) => setAuthor(event.target.value)} className={`${inputClass()} h-10`} data-testid="edit-author" />
            </Field>
            <Field label={t("field.notes", {}, language)} htmlFor={ids.notes} language={language}>
              <textarea
                id={ids.notes}
                dir="auto"
                rows={3}
                value={notes}
                maxLength={5000}
                onChange={(event) => setNotes(event.target.value)}
                className={`${inputClass()} min-h-22 resize-y py-2 leading-normal`}
                data-testid="edit-notes"
              />
            </Field>
          </div>
        </div>
      </form>
    </Modal>
  );
}
