/**
 * The hall-to-reader transition's state (docs/ARCHITECTURE.md section 11.6), shared by the 3D
 * scene (the flying book, the vignette, the hidden hall) and the DOM overlays (toolbar, zoom).
 */

import { create } from "zustand";

export type ReaderPhase = "closed" | "opening" | "open" | "closing";

export interface ReaderTransition {
  phase: ReaderPhase;
  bookId: number | null;
  /** The hall is hidden (visible = false) while a book is open. */
  hallVisible: boolean;
  set: (patch: Partial<Omit<ReaderTransition, "set" | "requestClose">>) => void;
  /** Close the open book (toolbar ✕ or Esc at 100 %); the scene runs the reverse transition. */
  requestClose: () => void;
}

export const useReaderTransition = create<ReaderTransition>()((set, get) => ({
  phase: "closed",
  bookId: null,
  hallVisible: true,
  set: (patch) => set(patch),
  requestClose: () => {
    if (get().phase === "open") set({ phase: "closing" });
  },
}));
