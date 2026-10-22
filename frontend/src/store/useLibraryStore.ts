import { create } from "zustand";

import * as api from "@/lib/api";
import type { Book, Category, Settings, SettingsPatch } from "@/lib/api";
import { applyLanguage } from "@/lib/i18n";

export type Connection = "checking" | "connected" | "disconnected";

/** A page's rectangle on screen, in CSS pixels relative to the canvas. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReaderState {
  activeBookId: number | null;
  /** Index into the book's spread list (lib/spreads.ts, US-06). */
  spreadIndex: number;
  /** 1 = 100 %, up to 4 = 400 %. */
  zoom: number;
  /** Page flipping is locked while zoomed in (FR-14). */
  flipLocked: boolean;
}

export interface PageRects {
  left: ScreenRect | null;
  right: ScreenRect | null;
  leftPage: number | null;
  rightPage: number | null;
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
  pageRects: PageRects;
  /** The Add book modal is open (top bar, a ghost slot, or a PDF dropped on the hall). */
  addBookOpen: boolean;
  /** Category pre-selected in the Add book modal (a ghost slot's category), or null. */
  addBookFor: number | null;
  /** A PDF dropped on the hall, handed to the Add book modal. */
  addBookFile: File | null;
  /** The book lifted off its shelf and shown with Open / Edit / Delete (US-11). */
  presentedBookId: number | null;
  /** Books whose Edit or Delete modal is open. */
  editBookFor: number | null;
  deleteBookFor: number | null;
  /** A book that search just flew to: its rim pulses twice, then glows for 3 s. */
  highlight: { bookId: number; at: number } | null;
  /**
   * A book just added: it waits a little out of its slot until the camera arrives (`at` null),
   * then slides in (BookSpine).
   */
  arrival: { bookId: number; at: number | null } | null;
  /** One toast at a time (docs/DESIGN.md 10.3). */
  toast: Toast | null;
  /** The Settings modal (language, graphics, ambient light, default direction, categories). */
  settingsOpen: boolean;

  fetchBootstrap: () => Promise<void>;
  /** Replace a book after an API call and keep the Currently Reading order in sync. */
  upsertBook: (book: Book) => void;
  setPageRects: (rects: PageRects) => void;
  /** Replace or add a category after an API call (rename, create). */
  upsertCategory: (category: Category) => void;
  openAddBook: (categoryId: number | null, file?: File | null) => void;
  closeAddBook: () => void;
  /** A book created through the Add book modal: shelve it and play its arrival. */
  addBook: (book: Book) => void;
  /** Remove a deleted book from the shelves, the desk and any open state. */
  removeBook: (bookId: number) => void;
  /** The camera reached the new book: start its slide into the slot. */
  landArrival: (bookId: number) => void;
  showToast: (message: string, kind?: Toast["kind"]) => void;
  openSettings: (open: boolean) => void;
  /**
   * Apply settings at once (language and direction, preset, exposure) and save them. The
   * previous values come back if the service refuses them.
   */
  updateSettings: (patch: SettingsPatch) => Promise<void>;
  /** Apply settings without saving (the ambient light slider while it is dragged). */
  previewSettings: (patch: SettingsPatch) => void;
  /** Reload categories and books (after a category delete moved books to new shelves). */
  refreshLibrary: () => Promise<void>;
  dismissToast: () => void;
  presentBook: (bookId: number | null) => void;
  openEditBook: (bookId: number | null) => void;
  openDeleteBook: (bookId: number | null) => void;
  highlightBook: (bookId: number | null) => void;
  setConnection: (connection: Connection) => void;
  openBook: (bookId: number, spreadIndex?: number) => void;
  closeBook: () => void;
  setSpreadIndex: (spreadIndex: number) => void;
  setZoom: (zoom: number) => void;
}

export interface Toast {
  id: number;
  message: string;
  kind: "success" | "info";
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
const NO_RECTS: PageRects = { left: null, right: null, leftPage: null, rightPage: null };

/** Up to 3 most recently opened books, 1st = latest (FR-11). */
export function currentlyReadingOf(books: Book[]): number[] {
  return books
    .filter((book) => book.last_opened_at !== null)
    .sort((a, b) => (b.last_opened_at! < a.last_opened_at! ? -1 : b.last_opened_at! > a.last_opened_at! ? 1 : b.id - a.id))
    .slice(0, 3)
    .map((book) => book.id);
}

/**
 * Categories with `book_count` recounted from `books`. Returns the same array when nothing
 * changed, so bookmark saves do not re-render the hall.
 */
export function recountCategories(categories: Category[], books: Book[]): Category[] {
  const counts = new Map<number, number>();
  for (const book of books) counts.set(book.category_id, (counts.get(book.category_id) ?? 0) + 1);
  if (categories.every((category) => category.book_count === (counts.get(category.id) ?? 0))) return categories;
  return categories.map((category) => {
    const count = counts.get(category.id) ?? 0;
    return category.book_count === count ? category : { ...category, book_count: count };
  });
}

let toastId = 0;

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  connection: "checking",
  loaded: false,
  categories: [],
  books: [],
  currentlyReading: [],
  settings: DEFAULT_SETTINGS,
  reader: CLOSED_READER,
  pageRects: NO_RECTS,
  addBookOpen: false,
  addBookFor: null,
  addBookFile: null,
  presentedBookId: null,
  editBookFor: null,
  deleteBookFor: null,
  highlight: null,
  arrival: null,
  toast: null,
  settingsOpen: false,

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

  upsertBook: (book) =>
    set((state) => {
      const exists = state.books.some((candidate) => candidate.id === book.id);
      const books = exists
        ? state.books.map((candidate) => (candidate.id === book.id ? book : candidate))
        : [...state.books, book];
      return { books, currentlyReading: currentlyReadingOf(books), categories: recountCategories(state.categories, books) };
    }),

  addBook: (book) =>
    set((state) => {
      const books = [...state.books.filter((candidate) => candidate.id !== book.id), book];
      return {
        books,
        currentlyReading: currentlyReadingOf(books),
        categories: recountCategories(state.categories, books),
        arrival: { bookId: book.id, at: null },
      };
    }),

  removeBook: (bookId) =>
    set((state) => {
      const books = state.books.filter((book) => book.id !== bookId);
      return {
        books,
        currentlyReading: currentlyReadingOf(books),
        categories: recountCategories(state.categories, books),
        presentedBookId: state.presentedBookId === bookId ? null : state.presentedBookId,
        highlight: state.highlight?.bookId === bookId ? null : state.highlight,
        arrival: state.arrival?.bookId === bookId ? null : state.arrival,
        editBookFor: state.editBookFor === bookId ? null : state.editBookFor,
        deleteBookFor: state.deleteBookFor === bookId ? null : state.deleteBookFor,
      };
    }),

  landArrival: (bookId) =>
    set((state) => (state.arrival?.bookId === bookId ? { arrival: { bookId, at: performance.now() } } : {})),

  showToast: (message, kind = "success") => set({ toast: { id: (toastId += 1), message, kind } }),
  dismissToast: () => set({ toast: null }),
  openSettings: (settingsOpen) => set({ settingsOpen }),

  updateSettings: async (patch) => {
    const previous = get().settings;
    if (patch.ui_language) applyLanguage(patch.ui_language);
    set({ settings: { ...previous, ...patch } });
    try {
      const saved = await api.updateSettings(patch);
      set((state) => ({ settings: { ...state.settings, ...saved } }));
    } catch (error) {
      if (patch.ui_language) applyLanguage(previous.ui_language);
      set({ settings: previous });
      throw error;
    }
  },

  previewSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),

  refreshLibrary: async () => {
    const data = await api.fetchBootstrap();
    set({
      categories: [...data.categories].sort((a, b) => a.column_index - b.column_index),
      books: data.books,
      currentlyReading: data.currently_reading,
    });
  },

  setPageRects: (pageRects) => set({ pageRects }),

  upsertCategory: (category) =>
    set((state) => {
      const exists = state.categories.some((candidate) => candidate.id === category.id);
      const categories = exists
        ? state.categories.map((candidate) => (candidate.id === category.id ? category : candidate))
        : [...state.categories, category];
      return { categories: categories.sort((a, b) => a.column_index - b.column_index) };
    }),

  openAddBook: (categoryId, file = null) => set({ addBookOpen: true, addBookFor: categoryId, addBookFile: file }),
  closeAddBook: () => set({ addBookOpen: false, addBookFor: null, addBookFile: null }),
  presentBook: (presentedBookId) => set({ presentedBookId }),
  openEditBook: (editBookFor) => set({ editBookFor }),
  openDeleteBook: (deleteBookFor) => set({ deleteBookFor }),
  highlightBook: (bookId) => set({ highlight: bookId === null ? null : { bookId, at: performance.now() } }),

  openBook: (bookId, spreadIndex = 0) =>
    set({ reader: { activeBookId: bookId, spreadIndex, zoom: 1, flipLocked: false } }),

  closeBook: () => set({ reader: CLOSED_READER, pageRects: NO_RECTS }),

  setSpreadIndex: (spreadIndex) => set((state) => ({ reader: { ...state.reader, spreadIndex } })),

  setZoom: (zoom) =>
    set((state) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
      return { reader: { ...state.reader, zoom: clamped, flipLocked: clamped > MIN_ZOOM } };
    }),
}));
