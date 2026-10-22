"use client";

/**
 * Add book (UC-02, docs/DESIGN.md 10.2 and 12): choose or drop a PDF, watch it upload, see the
 * Page 1 cover and page count, then confirm Title, Category and Reading direction.
 *
 * - Phase 1 (`POST /api/uploads`) starts as soon as a file is chosen; errors stay inline in the
 *   drop zone. Phase 2 (`POST /api/books`) runs on Add book.
 * - Title and direction are pre-filled from the upload (Arabic titles suggest RTL); a ghost
 *   slot pre-selects its category.
 * - Closing without saving deletes the staged upload.
 * - After saving, the camera flies to the new book, which slides into its slot.
 */

import { CircleAlert, FileUp, ImagePlus, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent } from "react";

import { playerCommands } from "@/components/3d/PlayerControls";
import * as api from "@/lib/api";
import type { ReadingDirection, Upload } from "@/lib/api";
import { t, type Language } from "@/lib/i18n";
import { spreadForPage } from "@/lib/spreads";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

import { Field, FieldError, Modal, Segmented, Select, buttonClass, errorText, inputClass } from "./Modal";

/** docs/ARCHITECTURE.md 6.1: DAR_MAX_UPLOAD_MB defaults to 2 GB. */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
/** Custom covers: PNG, JPEG or WebP up to 10 MB (docs/ARCHITECTURE.md 7). */
export const MAX_COVER_BYTES = 10 * 1024 ** 2;
export const COVER_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const TITLE_MAX = 300;
const AUTHOR_MAX = 200;
const NOTES_MAX = 5000;

type Phase = "empty" | "uploading" | "reading" | "ready" | "error";

const addDebug: { phase: Phase; uploadId: string | null; progress: number } = { phase: "empty", uploadId: null, progress: 0 };
registerTestHook("addBook", () => ({ ...addDebug }));

/** A chosen custom cover with its preview URL, or an inline error. */
export interface CoverChoice {
  file: File;
  url: string;
}

/** Checks a custom cover on the client (the server checks it again). */
export function coverProblem(file: File): boolean {
  return !(COVER_TYPES as readonly string[]).includes(file.type) || file.size > MAX_COVER_BYTES;
}

/**
 * Fly to a book that was just shelved, then let it slide into its slot and glow. The shelf
 * registers the book when React commits it, so this waits a few frames for that.
 */
export function flyToNewBook(bookId: number): void {
  const started = performance.now();
  const land = () => {
    const state = useLibraryStore.getState();
    state.landArrival(bookId);
    state.highlightBook(bookId);
  };
  const attempt = () => {
    if (playerCommands.flyToBook(bookId, land)) return;
    if (performance.now() - started < 2000) requestAnimationFrame(attempt);
    else land();
  };
  requestAnimationFrame(attempt);
}

export function AddBookModal() {
  const open = useLibraryStore((state) => state.addBookOpen);
  const presetCategory = useLibraryStore((state) => state.addBookFor);
  const droppedFile = useLibraryStore((state) => state.addBookFile);
  const categories = useLibraryStore((state) => state.categories);
  const language = useLibraryStore((state) => state.settings.ui_language);

  const [phase, setPhase] = useState<Phase>("empty");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [notes, setNotes] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [direction, setDirection] = useState<ReadingDirection | null>(null);
  const [cover, setCover] = useState<CoverChoice | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [duplicateAccepted, setDuplicateAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const dropButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  /** The staged upload that closing must delete (null once saved). */
  const staged = useRef<string | null>(null);
  const abortUpload = useRef<(() => void) | null>(null);
  /** Ignores the result of an upload that was replaced or cancelled. */
  const uploadToken = useRef(0);
  const touched = useRef({ title: false, direction: false });

  const ids = {
    title: useId(),
    author: useId(),
    notes: useId(),
    category: useId(),
    direction: useId(),
    titleError: useId(),
    categoryError: useId(),
    directionError: useId(),
    status: useId(),
  };

  const releaseStaged = () => {
    const id = staged.current;
    staged.current = null;
    if (id) void api.cancelUpload(id).catch(() => undefined);
  };

  const stopUpload = () => {
    uploadToken.current += 1;
    abortUpload.current?.();
    abortUpload.current = null;
  };

  const startUpload = (file: File) => {
    stopUpload();
    releaseStaged();
    setUpload(null);
    setUploadError(null);
    setSaveError(null);
    setDuplicateAccepted(false);
    setFileName(file.name);
    if (file.size > MAX_UPLOAD_BYTES) {
      setPhase("error");
      setUploadError(t("error.file_too_large", {}, language));
      return;
    }
    setPhase("uploading");
    setProgress(0);
    const token = uploadToken.current;
    const { promise, abort } = api.uploadPdf(file, file.name, (fraction) => {
      if (token !== uploadToken.current) return;
      setProgress(fraction);
      if (fraction >= 1) setPhase("reading");
    });
    abortUpload.current = abort;
    promise.then(
      (result) => {
        if (token !== uploadToken.current) {
          void api.cancelUpload(result.upload_id).catch(() => undefined);
          return;
        }
        abortUpload.current = null;
        staged.current = result.upload_id;
        setUpload(result);
        setPhase("ready");
        if (!touched.current.title || !titleInput.current?.value.trim()) setTitle(result.suggested_title.slice(0, TITLE_MAX));
        if (!touched.current.direction) setDirection(result.suggested_direction);
      },
      (error: unknown) => {
        if (token !== uploadToken.current) return;
        abortUpload.current = null;
        setPhase("error");
        setUploadError(errorText(error, language));
      },
    );
  };

  // A fresh form each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setPhase("empty");
    setProgress(0);
    setFileName("");
    setUpload(null);
    setUploadError(null);
    setTitle("");
    setAuthor("");
    setNotes("");
    setCategoryId(presetCategory);
    setDirection(null);
    setCover(null);
    setCoverError(null);
    setDuplicateAccepted(false);
    setSaving(false);
    setSaveError(null);
    touched.current = { title: false, direction: false };
    // The preset category is read once per opening.
  }, [open]);

  // A PDF dropped on the hall (or on this modal) arrives through the store.
  useEffect(() => {
    if (!open || !droppedFile) return;
    useLibraryStore.setState({ addBookFile: null });
    startUpload(droppedFile);
  }, [open, droppedFile]);

  // Release the cover preview URL when it changes.
  useEffect(() => {
    if (!cover) return;
    return () => URL.revokeObjectURL(cover.url);
  }, [cover]);

  // Closing the page with a staged upload: the server purges it after 24 h anyway.
  useEffect(() => () => stopUpload(), []);

  addDebug.phase = phase;
  addDebug.uploadId = upload?.upload_id ?? null;
  addDebug.progress = progress;

  const close = () => {
    if (saving) return;
    stopUpload();
    releaseStaged();
    useLibraryStore.getState().closeAddBook();
  };

  const ready = phase === "ready" && upload !== null;
  const titleValid = title.trim().length > 0;
  const categoryValid = categoryId !== null && categories.some((category) => category.id === categoryId);
  const directionValid = direction !== null;
  const duplicatePending = ready && upload.duplicate_of !== null && !duplicateAccepted;
  const canSave = ready && titleValid && categoryValid && directionValid && !duplicatePending && !coverError && !saving;
  // Missing fields say so once the PDF is read, until all three are valid.
  const showInvalid = ready;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || !upload || categoryId === null || direction === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const book = await api.createBook({
        uploadId: upload.upload_id,
        title: title.trim(),
        categoryId,
        readingDirection: direction,
        author: author.trim() || undefined,
        notes: notes.trim() || undefined,
        cover: cover?.file,
      });
      staged.current = null;
      const state = useLibraryStore.getState();
      state.addBook(book);
      state.closeAddBook();
      state.showToast(t("add.added", {}, language));
      flyToNewBook(book.id);
    } catch (error) {
      if (error instanceof api.ApiError && error.code === "invalid_cover") setCoverError(errorText(error, language));
      else setSaveError(errorText(error, language));
      if (error instanceof api.ApiError && error.code === "upload_not_found") {
        staged.current = null;
        setUpload(null);
        setPhase("error");
        setUploadError(errorText(error, language));
      }
    } finally {
      setSaving(false);
    }
  };

  const openExisting = () => {
    const existing = upload?.duplicate_of;
    if (!existing) return;
    close();
    const book = useLibraryStore.getState().books.find((candidate) => candidate.id === existing.id);
    if (book) useLibraryStore.getState().openBook(book.id, spreadForPage(book.last_read_page, book.page_count));
  };

  const chooseCover = (file: File | undefined) => {
    if (!file) return;
    if (coverProblem(file)) {
      setCoverError(t("error.invalid_cover", {}, language));
      return;
    }
    setCoverError(null);
    setCover({ file, url: URL.createObjectURL(file) });
  };

  const onDragOver = (event: ReactDragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  };

  const footer = (
    <>
      {saveError ? (
        <div className="me-auto max-w-[300px]">
          <FieldError>{saveError}</FieldError>
        </div>
      ) : null}
      <button type="button" className={buttonClass.secondary} onClick={close} disabled={saving} data-testid="add-cancel">
        {t("action.cancel", {}, language)}
      </button>
      <button type="submit" form="add-book-form" className={buttonClass.primary} disabled={!canSave} data-testid="add-submit">
        {t("action.addBook", {}, language)}
      </button>
    </>
  );

  return (
    <Modal open={open} onClose={close} title={t("add.title", {}, language)} footer={footer} busy={saving} testId="add-modal" language={language} initialFocus={dropButton}>
      <form id="add-book-form" onSubmit={onSubmit} noValidate>
        {duplicatePending && upload?.duplicate_of ? (
          <div className="mb-5 flex flex-col gap-3 rounded-control border-s-[3px] border-ochre bg-limestone/70 px-4 py-3" role="status" data-testid="add-duplicate">
            <p className="flex items-start gap-2 text-14 text-ink">
              <TriangleAlert size={18} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ochre" aria-hidden="true" />
              <span>{t("duplicate.message", { title: upload.duplicate_of.title }, language)}</span>
            </p>
            <div className="flex flex-wrap gap-2 ps-6">
              <button type="button" className={buttonClass.secondary} onClick={() => setDuplicateAccepted(true)} data-testid="duplicate-import">
                {t("duplicate.importAnyway", {}, language)}
              </button>
              <button type="button" className={buttonClass.secondary} onClick={openExisting} data-testid="duplicate-open">
                {t("duplicate.openExisting", {}, language)}
              </button>
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-[184px_minmax(0,1fr)] gap-6 max-sm:grid-cols-1">
          {/* Drop zone, then the cover preview. */}
          <div
            className="flex flex-col gap-2"
            onDragOver={onDragOver}
            onDragEnter={onDragOver}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={() => setDragging(false)}
          >
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              data-testid="add-file-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) startUpload(file);
              }}
            />
            {ready && upload ? (
              <CoverPreview
                src={cover ? cover.url : api.apiUrl(upload.cover_preview_url)}
                title={title || upload.suggested_title}
                ratio={upload.page_height_pt / upload.page_width_pt}
                custom={cover !== null}
                language={language}
                dragging={dragging}
              />
            ) : (
              <DropZone
                buttonRef={dropButton}
                phase={phase}
                progress={progress}
                fileName={fileName}
                error={uploadError}
                dragging={dragging}
                language={language}
                statusId={ids.status}
                onChoose={() => fileInput.current?.click()}
              />
            )}
            {ready && upload ? (
              <div className="flex flex-col items-start gap-1.5">
                <p className="tabular text-12 text-slate" data-testid="add-page-count">
                  {t("count.pages", { count: upload.page_count }, language)}
                </p>
                <input
                  ref={coverInput}
                  type="file"
                  accept={COVER_TYPES.join(",")}
                  hidden
                  data-testid="add-cover-input"
                  onChange={(event) => {
                    chooseCover(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                {cover ? (
                  <button type="button" className={buttonClass.link} onClick={() => setCover(null)} data-testid="add-cover-reset">
                    <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
                    {t("cover.usePage1", {}, language)}
                  </button>
                ) : (
                  <button type="button" className={buttonClass.link} onClick={() => coverInput.current?.click()} data-testid="add-cover-choose">
                    <ImagePlus size={16} strokeWidth={1.5} aria-hidden="true" />
                    {t("cover.choose", {}, language)}
                  </button>
                )}
                {coverError ? <FieldError>{coverError}</FieldError> : null}
                <button type="button" className={`${buttonClass.link} text-12`} onClick={() => fileInput.current?.click()} data-testid="add-choose-another">
                  <FileUp size={14} strokeWidth={1.5} aria-hidden="true" />
                  {t("add.chooseAnother", {}, language)}
                </button>
              </div>
            ) : null}
          </div>

          {/* Fields */}
          <div className="flex min-w-0 flex-col gap-4">
            <Field label={t("field.title", {}, language)} htmlFor={ids.title} required error={showInvalid && !titleValid ? t("invalid.title", {}, language) : null} errorId={ids.titleError} language={language}>
              <input
                ref={titleInput}
                id={ids.title}
                type="text"
                dir="auto"
                value={title}
                maxLength={TITLE_MAX}
                required
                aria-required="true"
                aria-invalid={showInvalid && !titleValid}
                aria-describedby={showInvalid && !titleValid ? ids.titleError : undefined}
                onChange={(event) => {
                  touched.current.title = true;
                  setTitle(event.target.value);
                }}
                className={`${inputClass(showInvalid && !titleValid)} h-10`}
                data-testid="add-title"
              />
            </Field>

            <Field label={t("field.category", {}, language)} htmlFor={ids.category} required error={showInvalid && !categoryValid ? t("invalid.category", {}, language) : null} errorId={ids.categoryError} language={language}>
              <Select
                id={ids.category}
                value={categoryId ?? ""}
                required
                aria-required="true"
                aria-invalid={showInvalid && !categoryValid}
                aria-describedby={showInvalid && !categoryValid ? ids.categoryError : undefined}
                invalid={showInvalid && !categoryValid}
                disabled={categories.length === 0}
                onChange={(event) => setCategoryId(event.target.value === "" ? null : Number(event.target.value))}
                data-testid="add-category"
              >
                <option value="" disabled>
                  {categories.length === 0 ? t("field.noCategories", {}, language) : t("field.categoryPlaceholder", {}, language)}
                </option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id} className="text-ink">
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={t("field.direction", {}, language)} labelId={ids.direction} required error={showInvalid && !directionValid ? t("invalid.direction", {}, language) : null} errorId={ids.directionError} language={language}>
              <Segmented
                value={direction}
                labelledBy={ids.direction}
                describedBy={showInvalid && !directionValid ? ids.directionError : undefined}
                invalid={showInvalid && !directionValid}
                options={[
                  { value: "LTR", label: t("direction.LTR", {}, language) },
                  { value: "RTL", label: t("direction.RTL", {}, language) },
                ]}
                onChange={(value) => {
                  touched.current.direction = true;
                  setDirection(value);
                }}
                testId="add-direction"
              />
            </Field>

            <Field label={t("field.author", {}, language)} htmlFor={ids.author} language={language}>
              <input id={ids.author} type="text" dir="auto" value={author} maxLength={AUTHOR_MAX} onChange={(event) => setAuthor(event.target.value)} className={`${inputClass()} h-10`} data-testid="add-author" />
            </Field>

            <Field label={t("field.notes", {}, language)} htmlFor={ids.notes} language={language}>
              <textarea
                id={ids.notes}
                dir="auto"
                rows={3}
                value={notes}
                maxLength={NOTES_MAX}
                onChange={(event) => setNotes(event.target.value)}
                className={`${inputClass()} min-h-22 resize-y py-2 leading-normal`}
                data-testid="add-notes"
              />
            </Field>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function DropZone(props: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  phase: Phase;
  progress: number;
  fileName: string;
  error: string | null;
  dragging: boolean;
  language: Language;
  statusId: string;
  onChoose: () => void;
}) {
  const { buttonRef, phase, progress, fileName, error, dragging, language, statusId, onChoose } = props;
  const busy = phase === "uploading" || phase === "reading";
  const frame = `flex aspect-[184/248] w-full flex-col items-center justify-center gap-3 rounded-[12px] border-2 border-dashed p-4 text-center transition-colors duration-(--motion-fast) ease-out ${
    dragging ? "border-lapis bg-lapis/8" : phase === "error" ? "border-rubric/40 bg-paper/70" : "border-ink/16 bg-paper/70"
  }`;

  if (busy) {
    const percent = Math.round(progress * 100);
    return (
      <div className={frame} data-testid="add-dropzone" data-phase={phase} role="status" aria-live="polite" id={statusId}>
        <FileUp size={28} strokeWidth={1.25} className="text-slate" aria-hidden="true" />
        <p className="w-full truncate text-12 text-slate" dir="auto" title={fileName}>
          {fileName}
        </p>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-limestone"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={phase === "reading" ? 100 : percent}
          aria-label={t(phase === "reading" ? "add.reading" : "add.uploading", {}, language)}
        >
          <div className="h-full rounded-full bg-lapis transition-[width] duration-(--motion-base) ease-out" style={{ width: `${phase === "reading" ? 100 : Math.max(4, percent)}%` }} />
        </div>
        <p className="text-14 font-medium text-ink">
          {phase === "reading" ? t("add.reading", {}, language) : <span className="tabular">{t("add.uploading", {}, language)} {percent}%</span>}
        </p>
      </div>
    );
  }

  if (phase === "error" && error) {
    return (
      <div className={frame} data-testid="add-dropzone" data-phase="error">
        <CircleAlert size={28} strokeWidth={1.25} className="text-rubric" aria-hidden="true" />
        <p className="text-14 text-ink" role="alert" data-testid="add-upload-error">
          {error}
        </p>
        <button ref={buttonRef} type="button" className={buttonClass.link} onClick={onChoose} data-testid="add-choose">
          {t("add.chooseAnother", {}, language)}
        </button>
      </div>
    );
  }

  return (
    <div className={frame} data-testid="add-dropzone" data-phase="empty">
      <FileUp size={32} strokeWidth={1.25} className={dragging ? "text-lapis" : "text-slate"} aria-hidden="true" />
      <p className="text-14 font-medium text-ink">{t("add.drop", {}, language)}</p>
      <button ref={buttonRef} type="button" className={buttonClass.link} onClick={onChoose} aria-label={t("add.chooseLabel", {}, language)} data-testid="add-choose">
        {t("add.choose", {}, language)}
      </button>
      <p className="text-12 text-slate">PDF</p>
    </div>
  );
}

/** The cover as it will look: paper-coloured with the title until the image loads. */
export function CoverPreview(props: { src: string | null; title: string; ratio: number; custom: boolean; language: Language; dragging?: boolean; testId?: string }) {
  const { src, title, ratio, custom, language, dragging = false, testId = "add-cover" } = props;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);
  const aspect = Math.min(1.6, Math.max(1.1, ratio || 1.414));
  return (
    <figure className="flex flex-col gap-1.5" data-testid={testId} data-custom={custom} data-loaded={loaded}>
      <div
        className={`relative w-full overflow-hidden rounded-[6px] bg-paper shadow-[0_6px_18px_rgb(30_34_48/0.18),0_0_0_1px_rgb(30_34_48/0.08)] transition-shadow duration-(--motion-fast) ${
          dragging ? "ring-2 ring-lapis ring-offset-2" : ""
        }`}
        style={{ aspectRatio: `1 / ${aspect}` }}
      >
        {!loaded ? (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-14 font-semibold text-slate" dir="auto">
            {title}
          </p>
        ) : null}
        {src && !failed ? (
          // A plain <img>: covers come from the local API already sized (static export, no loader).
          <img
            src={src}
            alt=""
            className="absolute inset-0 size-full object-cover transition-opacity duration-(--motion-base) ease-out"
            style={{ opacity: loaded ? 1 : 0 }}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : null}
      </div>
      <figcaption className="text-12 text-slate">{custom ? t("cover.custom", {}, language) : t("cover.page1", {}, language)}</figcaption>
    </figure>
  );
}
