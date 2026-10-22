"use client";

/**
 * Development harness for the reader (Sprint 2): /dev/reader/?book=<id>.
 * The hall does not exist yet, so the reader is developed and tested here on its own.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

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
  const fetchBootstrap = useLibraryStore((state) => state.fetchBootstrap);
  const openBook = useLibraryStore((state) => state.openBook);
  const [bookId, setBookId] = useState<number | null>(null);

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

  useEffect(() => {
    if (book) openBook(book.id, spreadForPage(book.last_read_page, book.page_count));
    // Open once per book; later changes to the book's fields do not reopen it.
  }, [book?.id, openBook]);

  if (!book) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-ink text-16 text-paper">
        {loaded ? t("reader.notFound", {}, language) : t("reader.loading", {}, language)}
      </main>
    );
  }

  return (
    <main className="relative">
      <ReaderStage book={book} />
      <p
        className="pointer-events-none absolute start-6 top-5 text-14 text-limestone"
        dir="auto"
        data-testid="reader-title"
      >
        {book.author ? `${book.title}${/[\u0600-\u06ff]/.test(book.title) ? "، " : ", "}${book.author}` : book.title}
      </p>
    </main>
  );
}
