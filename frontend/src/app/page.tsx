"use client";

import { useEffect } from "react";

import { t, type Language } from "@/lib/i18n";
import { installTestApi } from "@/lib/testApi";
import { useLibraryStore, type Connection } from "@/store/useLibraryStore";

import { cairo, inter } from "./fonts";

/** Placeholder home until the 3D hall arrives (US-09). */
export default function Home() {
  const connection = useLibraryStore((state) => state.connection);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const bookCount = useLibraryStore((state) => state.books.length);
  const categoryCount = useLibraryStore((state) => state.categories.length);
  const fetchBootstrap = useLibraryStore((state) => state.fetchBootstrap);

  useEffect(() => {
    installTestApi({
      getState: useLibraryStore.getState,
      fonts: { inter: inter.style.fontFamily, cairo: cairo.style.fontFamily },
    });
    void fetchBootstrap();
  }, [fetchBootstrap]);

  const arabicFirst = language === "ar";

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <section className="flex max-w-xl flex-col items-center gap-10 text-center">
        <StarMark />

        <div className="flex flex-col items-center gap-2">
          <h1
            className={arabicFirst ? "font-arabic text-48 font-bold" : "text-48 font-semibold tracking-tight"}
            lang={arabicFirst ? "ar" : "en"}
            dir={arabicFirst ? "rtl" : "ltr"}
          >
            {arabicFirst ? "دار العلم" : "Dar al Ilm"}
          </h1>
          <p
            className={arabicFirst ? "text-24 font-semibold text-slate" : "font-arabic text-30 font-bold text-slate"}
            lang={arabicFirst ? "en" : "ar"}
            dir={arabicFirst ? "ltr" : "rtl"}
          >
            {arabicFirst ? "Dar al Ilm" : "دار العلم"}
          </p>
        </div>

        <p className="text-18 text-slate">{t("app.tagline", {}, language)}</p>

        <ConnectionStatus
          connection={connection}
          language={language}
          bookCount={bookCount}
          categoryCount={categoryCount}
        />

        <p className="text-14 text-slate">{t("app.building", {}, language)}</p>
      </section>
    </main>
  );
}

function StarMark() {
  // Eight-point star: two overlapping squares in one brass outline (docs/DESIGN.md 9).
  return (
    <svg viewBox="0 0 96 96" className="size-18 text-brass" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={3} strokeLinejoin="round">
        <rect x="22" y="22" width="52" height="52" rx="1.5" />
        <rect x="22" y="22" width="52" height="52" rx="1.5" transform="rotate(45 48 48)" />
        <circle cx="48" cy="48" r="9" />
      </g>
    </svg>
  );
}

const DOT: Record<Connection, string> = {
  checking: "bg-slate",
  connected: "bg-verdigris",
  disconnected: "bg-rubric",
};

function ConnectionStatus(props: {
  connection: Connection;
  language: Language;
  bookCount: number;
  categoryCount: number;
}) {
  const { connection, language, bookCount, categoryCount } = props;
  const label = t(`status.${connection}`, {}, language);
  const detail =
    connection === "connected"
      ? t(
          "library.summary",
          {
            books: t("count.books", { count: bookCount }, language),
            categories: t("count.categories", { count: categoryCount }, language),
          },
          language,
        )
      : connection === "disconnected"
        ? t("status.restartHint", {}, language)
        : null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="api-status"
      data-state={connection}
      className="panel flex items-center gap-3 rounded-full px-5 py-2.5 text-14"
    >
      <span className={`size-2 shrink-0 rounded-full ${DOT[connection]}`} aria-hidden="true" />
      <span className="font-medium">{label}</span>
      {detail ? (
        <span className="tabular text-slate" data-testid="api-detail">
          {detail}
        </span>
      ) : null}
    </div>
  );
}
