/**
 * Client-side search over the bootstrap data (docs/ARCHITECTURE.md section 12): instant for
 * thousands of books, forgiving of case, Latin accents, Arabic diacritics, tatweel and the
 * usual letter variants.
 */

import type { Book, Category } from "@/lib/api";

const LATIN_MARKS = /[̀-ͯ]/g;
const ARABIC_MARKS = /[ً-ٰٟـ]/g;

/**
 * NFKC, case-folded, Latin accents stripped (é -> e), Arabic diacritics and tatweel stripped,
 * alef forms unified (أ إ آ ٱ -> ا), ى -> ي, ة -> ه, whitespace collapsed.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(LATIN_MARKS, "")
    .normalize("NFC")
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

export type MatchKind = "title-start" | "title-word" | "title" | "author" | "category";

export interface SearchResult {
  book: Book;
  category: Category | undefined;
  match: MatchKind;
}

const RANK: Record<MatchKind, number> = { "title-start": 0, "title-word": 1, title: 2, author: 3, category: 4 };

export const MAX_RESULTS = 8;

interface Indexed {
  book: Book;
  category: Category | undefined;
  title: string;
  words: string[];
  author: string;
  categoryName: string;
}

/** Normalized fields, computed once per library change. */
export function buildIndex(books: readonly Book[], categories: readonly Category[]): Indexed[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return books.map((book) => {
    const category = byId.get(book.category_id);
    const title = normalize(book.title);
    return {
      book,
      category,
      title,
      words: title.split(/[\s\-–—:،,.;()]+/).filter(Boolean),
      author: normalize(book.author ?? ""),
      categoryName: normalize(category?.name ?? ""),
    };
  });
}

/**
 * Ranked results: title starts with the query > a title word starts with it > the title
 * contains it > the author matches > the category matches. Ties: most recently opened first.
 */
export function search(index: readonly Indexed[], query: string, limit = MAX_RESULTS): SearchResult[] {
  const q = normalize(query);
  if (!q) return [];
  const results: SearchResult[] = [];
  for (const entry of index) {
    let match: MatchKind | null = null;
    if (entry.title.startsWith(q)) match = "title-start";
    else if (entry.words.some((word) => word.startsWith(q))) match = "title-word";
    else if (entry.title.includes(q)) match = "title";
    else if (entry.author.includes(q)) match = "author";
    else if (entry.categoryName.includes(q)) match = "category";
    if (match) results.push({ book: entry.book, category: entry.category, match });
  }
  const opened = (book: Book) => (book.last_opened_at ? Date.parse(book.last_opened_at) : -Infinity);
  results.sort(
    (a, b) =>
      RANK[a.match] - RANK[b.match] ||
      opened(b.book) - opened(a.book) ||
      a.book.title.localeCompare(b.book.title) ||
      a.book.id - b.book.id,
  );
  return results.slice(0, limit);
}
