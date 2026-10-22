import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKMARK_DELAY_MS, BookmarkSaver } from "./bookmark";

function setup() {
  const save = vi.fn((_bookId: number, _page: number) => Promise.resolve());
  const saveKeepalive = vi.fn();
  return { saver: new BookmarkSaver({ save, saveKeepalive }), save, saveKeepalive };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BookmarkSaver", () => {
  it("saves once the position has been stable for 600 ms", () => {
    const { saver, save } = setup();
    for (let page = 2; page <= 100; page += 2) {
      saver.update(1, page);
      vi.advanceTimersByTime(100);
    }
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BOOKMARK_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(1, 100);
  });

  it("flushes immediately on close, and with keepalive when the page hides", () => {
    const { saver, save, saveKeepalive } = setup();
    saver.update(1, 40);
    saver.flush();
    expect(save).toHaveBeenCalledWith(1, 40);
    saver.update(1, 42);
    saver.flush(true);
    expect(saveKeepalive).toHaveBeenCalledWith(1, 42);
    vi.advanceTimersByTime(BOOKMARK_DELAY_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not resend a position that is already stored", () => {
    const { saver, save } = setup();
    saver.markSaved(1, 57);
    saver.update(1, 57);
    vi.advanceTimersByTime(BOOKMARK_DELAY_MS);
    expect(save).not.toHaveBeenCalled();
    saver.update(1, 58);
    vi.advanceTimersByTime(BOOKMARK_DELAY_MS);
    expect(save).toHaveBeenCalledWith(1, 58);
  });

  it("saves the previous book before switching books", () => {
    const { saver, save } = setup();
    saver.update(1, 10);
    saver.update(2, 20);
    expect(save).toHaveBeenCalledWith(1, 10);
    vi.advanceTimersByTime(BOOKMARK_DELAY_MS);
    expect(save).toHaveBeenCalledWith(2, 20);
  });

  it("dispose() drops a pending save", () => {
    const { saver, save } = setup();
    saver.update(1, 10);
    saver.dispose();
    vi.advanceTimersByTime(BOOKMARK_DELAY_MS);
    expect(save).not.toHaveBeenCalled();
  });
});
