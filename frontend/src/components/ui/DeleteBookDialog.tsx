"use client";

/**
 * Delete book (FR-10): names the book and says that its PDF and cover leave the library folder.
 * Cancel has the focus; Delete book is the only destructive button in the app
 * (docs/DESIGN.md 10.3). On success the book leaves the shelf and the desk at once.
 */

import { useId, useRef, useState } from "react";

import * as api from "@/lib/api";
import type { Book } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLibraryStore } from "@/store/useLibraryStore";

import { FieldError, Modal, buttonClass, errorText } from "./Modal";

export function DeleteBookDialog() {
  const bookId = useLibraryStore((state) => state.deleteBookFor);
  const book = useLibraryStore((state) => state.books.find((candidate) => candidate.id === state.deleteBookFor) ?? null);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const [shown, setShown] = useState<Book | null>(book);
  if (book && book !== shown) setShown(book);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();

  const open = bookId !== null && book !== null;
  const close = () => {
    if (deleting) return;
    setError(null);
    useLibraryStore.getState().openDeleteBook(null);
  };

  if (!shown) return null;

  const confirm = async () => {
    setDeleting(true);
    setError(null);
    const store = useLibraryStore.getState();
    try {
      await api.deleteBook(shown.id);
      store.removeBook(shown.id);
      store.showToast(t("delete.deleted", {}, language));
    } catch (failure) {
      // Already gone on the server: take it off the shelf too.
      if (failure instanceof api.ApiError && failure.code === "book_not_found") {
        store.removeBook(shown.id);
        store.showToast(t("delete.deleted", {}, language));
      } else {
        setError(errorText(failure, language));
      }
    } finally {
      setDeleting(false);
    }
  };

  const footer = (
    <>
      <button ref={cancelRef} type="button" className={buttonClass.secondary} onClick={close} disabled={deleting} data-testid="delete-cancel">
        {t("action.cancel", {}, language)}
      </button>
      <button type="button" className={buttonClass.destructive} onClick={confirm} disabled={deleting} data-testid="delete-confirm">
        {t("action.deleteBook", {}, language)}
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("delete.title", {}, language)}
      footer={footer}
      width={460}
      busy={deleting}
      role="alertdialog"
      describedBy={bodyId}
      initialFocus={cancelRef}
      testId="delete-dialog"
      language={language}
      onExited={() => setShown(null)}
    >
      <div id={bodyId} className="flex items-start gap-4">
        <img
          src={api.apiUrl(shown.cover_url)}
          alt=""
          className="h-[68px] w-12 shrink-0 rounded-[4px] bg-paper object-cover shadow-[0_2px_8px_rgb(30_34_48/0.18),0_0_0_1px_rgb(30_34_48/0.08)]"
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-16 font-medium text-ink" data-testid="delete-name">
            {t("delete.body", { title: shown.title }, language)}
          </p>
          <p className="text-14 text-slate">{t("delete.detail", {}, language)}</p>
          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      </div>
    </Modal>
  );
}
