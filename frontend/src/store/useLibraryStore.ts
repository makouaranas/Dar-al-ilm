import { create } from "zustand";

import * as api from "@/lib/api";
import type { Book, Category, Settings } from "@/lib/api";
import { applyLanguage } from "@/lib/i18n";

export type Connection = "checking" | "connected" | "disconnected";

export interface ReaderState {
  activeBookId: number | null;
  /** Index into the book's spread list (lib/spreads.ts, US-06). */
  spreadIndex: number;
  /** 1 = 100 %, up to 4 = 400 %. */
  zoom: number;
  /** Page flipping is locked while zoomed in (FR-14). */
  flipLocked: boolean;
}

export interface LibraryState {
  connection: Connection;
  loaded: boolean;
  categories: Category[];
  books: Book[];
  /** Up to 3 book IDs, 1st = most recently opened. */
  currentlyReading: number[];
  settings: Settings;
  reader: ReaderState;

  fetchBootstrap: () => Promise<void>;
  setConnection: (connection: Connection) => void;
  openBook: (bookId: number, spreadIndex?: number) => void;
  closeBook: () => void;
  setSpreadIndex: (spreadIndex: number) => void;
  setZoom: (zoom: number) => void;
}

export const DEFAULT_SETTINGS: Settings = {
  ui_language: "en",
  default_direction: "LTR",
  graphics_quality: "auto",
  ambient_light: 1,
};

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

const CLOSED_READER: ReaderState = { activeBookId: null, spreadIndex: 0, zoom: 1, flipLocked: false };

export const useLibraryStore = create<LibraryState>()((set) => ({
  connection: "checking",
  loaded: false,
  categories: [],
  books: [],
  currentlyReading: [],
  settings: DEFAULT_SETTINGS,
  reader: CLOSED_READER,

  fetchBootstrap: async () => {
    try {
      const data = await api.fetchBootstrap();
      applyLanguage(data.settings.ui_language);
      set({
        connection: "connected",
        loaded: true,
        categories: [...data.categories].sort((a, b) => a.column_index - b.column_index),
        books: data.books,
        currentlyReading: data.currently_reading,
        settings: data.settings,
      });
    } catch {
      set({ connection: "disconnected" });
    }
  },

  setConnection: (connection) => set({ connection }),

  openBook: (bookId, spreadIndex = 0) =>
    set({ reader: { activeBookId: bookId, spreadIndex, zoom: 1, flipLocked: false } }),

  closeBook: () => set({ reader: CLOSED_READER }),

  setSpreadIndex: (spreadIndex) => set((state) => ({ reader: { ...state.reader, spreadIndex } })),

  setZoom: (zoom) =>
    set((state) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
      return { reader: { ...state.reader, zoom: clamped, flipLocked: clamped > MIN_ZOOM } };
    }),
}));
