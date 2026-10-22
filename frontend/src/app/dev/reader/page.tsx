"use client";

/**
 * Development harness for the reader (Sprint 2): /dev/reader/?book=<id>.
 * The hall does not exist yet, so the reader is developed and tested here on its own.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { t } from "@/lib/i18n";
import { spreadForPage } from "@/lib/spreads";
import { installTestApi } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

import { cairo, inter } from "../../fonts";

const ReaderStage = dynamic(() => import("@/components/3d/CurvedBookReader").then((module) => module.ReaderStage), {
  ssr: false,
});

export default function DevReaderPage() {
  const books = useLibraryStore((state) => state.books);
  const loaded = useLibraryStore((state) => state.loaded);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const activeBookId = useLibraryStore((state) => state.reader.activeBookId);
  const fetchBootstrap = useLibraryStore((state) => state.fetchBootstrap);
  const openBook = useLibraryStore((state) => state.openBook);
  const closeBook = useLibraryStore((state) => state.closeBook);
  const [bookId, setBookId] = useState<number | null>(null);
  const [closedByUser, setClosedByUser] = useState(false);

  useEffect(() => {
    installTestApi({
      getState: useLibraryStore.getState,
      fonts: { inter: inter.style.fontFamily, cairo: cairo.style.fontFamily },
    });
    const requested = Number(new URLSearchParams(window.location.search).get("book"));
    setBookId(Number.isInteger(requested) && requested > 0 ? requested : null);
    void fetchBootstrap();
  }, [fetchBootstrap]);

  const book = books.find((candidate) => candidate.id === bookId);

  const open = useCallback(() => {
    const current = useLibraryStore.getState().books.find((candidate) => candidate.id === bookId);
    if (current) openBook(current.id, spreadForPage(current.last_read_page, current.page_count));
  }, [bookId, openBook]);

  useEffect(() => {
    if (book) open();
    // Open once per book; later changes to the book's fields do not reopen it.
  }, [book?.id, open]);

  const close = () => {
    closeBook();
    setClosedByUser(true);
  };

  if (!book || (activeBookId !== book.id && !closedByUser)) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink text-16 text-paper">
        {loaded && !book ? t("reader.notFound", {}, language) : t("reader.loading", {}, language)}
      </main>
    );
  }

  if (activeBookId !== book.id) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-ink text-16 text-paper" data-testid="reader-closed">
        <p>{t("reader.closed", {}, language)}</p>
        <button
          type="button"
          onClick={open}
          data-testid="reader-reopen"
          className="h-10 rounded-control bg-lapis px-4 text-14 font-medium text-white transition-colors duration-(--motion-fast) ease-out hover:bg-[#3a5aab]"
        >
          {t("reader.open", {}, language)}
        </button>
      </main>
    );
  }

  return (
    <main className="relative">
      <ReaderStage book={book} onClose={close} />
    </main>
  );
}
