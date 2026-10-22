/**
 * Automatic bookmarking (FR-15, docs/ARCHITECTURE.md section 11.5).
 *
 * The reading position is saved once it has been stable for 600 ms, so flipping through 50
 * pages sends one request, not 50. Closing the book, hiding the tab or leaving the page
 * flushes immediately; while the page unloads the request uses `keepalive`.
 */

import { useEffect, useRef } from "react";

import { saveBookmarkKeepalive, updateBook, type Book } from "./api";
import { lastReadPage, spreadForPage } from "./spreads";

export const BOOKMARK_DELAY_MS = 600;

export interface BookmarkTransport {
  save(bookId: number, page: number): Promise<unknown>;
  saveKeepalive(bookId: number, page: number): void;
}

export class BookmarkSaver {
  private readonly transport: BookmarkTransport;
  private readonly delay: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { bookId: number; page: number } | null = null;
  private lastSaved = new Map<number, number>();

  constructor(transport: BookmarkTransport, delay = BOOKMARK_DELAY_MS) {
    this.transport = transport;
    this.delay = delay;
  }

  /** The reader shows `page` of `bookId` now; save it once it stays there. */
  update(bookId: number, page: number): void {
    if (this.pending && this.pending.bookId !== bookId) this.flush();
    this.pending = { bookId, page };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
  }

  /** Save now (on close or hide). With `keepalive`, the request outlives the page. */
  flush(keepalive = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (!pending || this.lastSaved.get(pending.bookId) === pending.page) return;
    this.lastSaved.set(pending.bookId, pending.page);
    if (keepalive) this.transport.saveKeepalive(pending.bookId, pending.page);
    else void this.transport.save(pending.bookId, pending.page).catch(() => this.lastSaved.delete(pending.bookId));
  }

  /** Remember a position that is already stored (the page the book opened at). */
  markSaved(bookId: number, page: number): void {
    this.lastSaved.set(bookId, page);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/**
 * The reading session of the open book: `mark_opened` on open and on close, the debounced
 * bookmark on every spread change, and an immediate flush on close, `pagehide` and
 * `visibilitychange` (section 11.5). Every saved book is passed to `onSaved` so the store
 * (Currently Reading, last-read page) stays in sync.
 */
export function useReadingSession(book: Book | null, spreadIndex: number, onSaved: (book: Book) => void): void {
  const saver = useRef<BookmarkSaver | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const bookRef = useRef(book);
  bookRef.current = book;
  const bookId = book?.id ?? null;
  /** The page shown now, applied to the store at once on close (the save is asynchronous). */
  const position = useRef<number | null>(null);

  useEffect(() => {
    const opened = bookRef.current;
    if (bookId === null || !opened) return;
    const saved = (result: Book) => onSavedRef.current(result);
    const current = new BookmarkSaver({
      save: (id, page) => updateBook(id, { last_read_page: page }).then(saved),
      saveKeepalive: saveBookmarkKeepalive,
    });
    saver.current = current;
    // The position the book opens at is already stored.
    current.markSaved(bookId, lastReadPage(spreadForPage(opened.last_read_page, opened.page_count), opened.page_count));
    void updateBook(bookId, { mark_opened: true }).then(saved, () => undefined);

    const onPageHide = () => current.flush(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") current.flush(true);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      // Closing the book: save now, and mark it opened again so it leads the desk.
      const last = bookRef.current;
      if (last && last.id === bookId && position.current !== null && position.current !== last.last_read_page) {
        onSavedRef.current({ ...last, last_read_page: position.current });
      }
      position.current = null;
      current.flush();
      current.dispose();
      void updateBook(bookId, { mark_opened: true }).then(saved, () => undefined);
      if (saver.current === current) saver.current = null;
    };
  }, [bookId]);

  useEffect(() => {
    const current = bookRef.current;
    if (!current || !saver.current) return;
    position.current = lastReadPage(spreadIndex, current.page_count);
    saver.current.update(current.id, position.current);
  }, [spreadIndex, bookId]);
}
