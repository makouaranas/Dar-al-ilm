"use client";

/**
 * Toasts (docs/DESIGN.md 10.3): bottom centre above where the reader toolbar sits, on the panel
 * surface, one at a time, gone after 4 s. Success shows a verdigris check.
 */

import { CircleCheck, Info } from "lucide-react";
import { useEffect, useState } from "react";

import { useLibraryStore, type Toast as ToastData } from "@/store/useLibraryStore";

export const TOAST_MS = 4000;
const FADE_MS = 200;

export function Toast() {
  const toast = useLibraryStore((state) => state.toast);
  const dismiss = useLibraryStore((state) => state.dismissToast);
  const [shown, setShown] = useState<ToastData | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) {
      setVisible(false);
      const timer = setTimeout(() => setShown(null), FADE_MS);
      return () => clearTimeout(timer);
    }
    setShown(toast);
    const show = requestAnimationFrame(() => setVisible(true));
    const hide = setTimeout(() => dismiss(), TOAST_MS);
    return () => {
      cancelAnimationFrame(show);
      clearTimeout(hide);
    };
  }, [toast, dismiss]);

  if (!shown) return null;
  const Icon = shown.kind === "success" ? CircleCheck : Info;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[88px] z-[60] flex justify-center px-4">
      <div
        key={shown.id}
        role="status"
        aria-live="polite"
        data-testid="toast"
        className="panel flex items-center gap-2.5 rounded-full py-2.5 ps-3.5 pe-5 text-14 font-medium text-ink"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(6px)",
          transition: `opacity ${FADE_MS}ms var(--ease-enter), transform ${FADE_MS}ms var(--ease-enter)`,
        }}
      >
        <Icon size={20} strokeWidth={1.5} className={shown.kind === "success" ? "text-verdigris" : "text-slate"} aria-hidden="true" />
        <span>{shown.message}</span>
      </div>
    </div>
  );
}
