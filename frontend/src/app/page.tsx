"use client";

/**
 * The library: the walkable 3D hall with its floating overlays (docs/DESIGN.md section 10.2).
 * The logo sits at the top start, the key hint at the bottom start, the service status at the
 * bottom end; F2 opens the debug overlay.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { hallMotion } from "@/components/3d/PlayerControls";
import { DebugHud } from "@/components/ui/DebugHud";
import { setCanvasFonts } from "@/lib/canvasText";
import { t, type Language } from "@/lib/i18n";
import { installTestApi } from "@/lib/testApi";
import { useLibraryStore, type Connection } from "@/store/useLibraryStore";

import { cairo, inter } from "./fonts";

const LibraryCanvas = dynamic(() => import("@/components/3d/LibraryCanvas").then((module) => module.LibraryCanvas), {
  ssr: false,
});

const HINT_STORAGE_KEY = "dar.hint.walked";
const HINT_IDLE_MS = 30_000;

export default function Home() {
  const connection = useLibraryStore((state) => state.connection);
  const loaded = useLibraryStore((state) => state.loaded);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const bookCount = useLibraryStore((state) => state.books.length);
  const categoryCount = useLibraryStore((state) => state.categories.length);
  const fetchBootstrap = useLibraryStore((state) => state.fetchBootstrap);

  useEffect(() => {
    setCanvasFonts(inter.style.fontFamily, cairo.style.fontFamily);
    installTestApi({
      getState: useLibraryStore.getState,
      fonts: { inter: inter.style.fontFamily, cairo: cairo.style.fontFamily },
    });
    void fetchBootstrap();
  }, [fetchBootstrap]);

  const dimmed = useDimWhileWalking();
  const hint = useKeyHint();

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink">
      {loaded ? <LibraryCanvas /> : null}

      <header
        className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5 transition-opacity duration-(--motion-base) ease-enter"
        style={{ opacity: dimmed ? 0.4 : 1 }}
        data-testid="top-bar"
      >
        <Logo language={language} />
      </header>

      {hint ? <KeyHint language={language} /> : null}

      <div className="absolute end-5 bottom-5">
        <ConnectionStatus connection={connection} language={language} bookCount={bookCount} categoryCount={categoryCount} />
      </div>

      <DebugHud />
    </main>
  );
}

/** Top elements fade to 40 % while walking and return when the mouse moves near the top. */
function useDimWhileWalking(): boolean {
  const [dimmed, setDimmed] = useState(false);
  useEffect(() => {
    const unsubscribe = hallMotion.subscribe((moving) => {
      if (moving) setDimmed(true);
    });
    const onMove = (event: MouseEvent) => {
      if (event.clientY < 96) setDimmed(false);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      unsubscribe();
      window.removeEventListener("mousemove", onMove);
    };
  }, []);
  return dimmed;
}

/**
 * The key hint shows on first launch and after 30 s without input in the entrance zone; it
 * hides once the user has walked.
 */
function useKeyHint(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let walked = false;
    try {
      walked = globalThis.localStorage?.getItem(HINT_STORAGE_KEY) === "1";
    } catch {
      walked = false;
    }
    setVisible(!walked);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (hallMotion.position.z < 8) setVisible(true);
      }, HINT_IDLE_MS);
    };
    const unsubscribe = hallMotion.subscribe((moving) => {
      if (!moving) return;
      setVisible(false);
      try {
        globalThis.localStorage?.setItem(HINT_STORAGE_KEY, "1");
      } catch {
        // Storage can be unavailable: the hint then shows again next launch.
      }
      arm();
    });
    const events = ["keydown", "pointerdown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, arm);
    arm();
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, arm);
    };
  }, []);
  return visible;
}

function Kbd({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <kbd
      aria-label={label}
      className="inline-flex h-7 min-w-7 items-center justify-center rounded-[6px] border border-ink/12 bg-paper px-1.5 font-sans text-12 font-medium text-ink shadow-[0_1px_0_rgb(30_34_48/0.12)]"
    >
      {children}
    </kbd>
  );
}

function KeyHint({ language }: { language: Language }) {
  return (
    <div
      className="panel pointer-events-none absolute start-5 bottom-5 flex items-center gap-5 rounded-full px-4 py-2 text-14 text-ink"
      role="note"
      aria-label={t("hint.label", {}, language)}
      data-testid="key-hint"
    >
      <span className="flex items-center gap-1.5">
        <span className="flex gap-1" dir="ltr">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd>
        </span>
        <span className="ms-1">{t("hint.walk", {}, language)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>{t("hint.drag", {}, language)}</Kbd>
        <span>{t("hint.look", {}, language)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>
          <bdi dir="ltr">Home</bdi>
        </Kbd>
        <span>{t("hint.desk", {}, language)}</span>
      </span>
    </div>
  );
}

function Logo({ language }: { language: Language }) {
  const arabicFirst = language === "ar";
  return (
    <div className="panel pointer-events-auto flex items-center gap-3 rounded-full py-2 ps-2.5 pe-5" data-testid="logo">
      <StarMark />
      <div className="flex items-baseline gap-2.5">
        <h1
          className={arabicFirst ? "font-arabic text-18 leading-none font-bold" : "text-18 leading-none font-semibold"}
          lang={arabicFirst ? "ar" : "en"}
          dir={arabicFirst ? "rtl" : "ltr"}
        >
          {arabicFirst ? "دار العلم" : "Dar al Ilm"}
        </h1>
        <span
          className={arabicFirst ? "text-14 leading-none font-semibold text-slate" : "font-arabic text-16 leading-none font-bold text-slate"}
          lang={arabicFirst ? "en" : "ar"}
          dir={arabicFirst ? "ltr" : "rtl"}
        >
          {arabicFirst ? "Dar al Ilm" : "دار العلم"}
        </span>
      </div>
    </div>
  );
}

function StarMark() {
  // Eight-point star: two overlapping squares in one brass outline (docs/DESIGN.md 9).
  return (
    <svg viewBox="0 0 96 96" className="size-7 text-brass" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={5} strokeLinejoin="round">
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

function ConnectionStatus(props: { connection: Connection; language: Language; bookCount: number; categoryCount: number }) {
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
      className="panel flex items-center gap-3 rounded-full px-4 py-2 text-12"
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
