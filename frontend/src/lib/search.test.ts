import { describe, expect, it } from "vitest";

import type { Book, Category } from "./api";
import { buildIndex, normalize, search } from "./search";

const category = (id: number, name: string): Category => ({ id, name, column_index: id, book_count: 0, created_at: "2026-01-01T00:00:00Z" });

let nextId = 1;
function book(title: string, author: string | null, categoryId: number, lastOpened: string | null = null): Book {
  return {
    id: nextId++,
    title,
    author,
    notes: null,
    category_id: categoryId,
    reading_direction: "LTR",
    page_count: 100,
    page_width_pt: 595,
    page_height_pt: 842,
    spine_color: "#335577",
    cover_url: "/api/books/1/cover",
    cover_is_custom: false,
    file_size_bytes: 1,
    file_missing: false,
    last_read_page: 1,
    last_opened_at: lastOpened,
    shelf_number: 0,
    slot_index: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("normalize", () => {
  it("folds case, Latin accents, Arabic diacritics, tatweel and letter variants", () => {
    expect(normalize("École")).toBe("ecole");
    expect(normalize("  La   Méditerranée ")).toBe("la mediterranee");
    expect(normalize("إبن")).toBe("ابن");
    expect(normalize("آداب أدب ٱلكتاب")).toBe("اداب ادب الكتاب");
    expect(normalize("مُقَدِّمَة")).toBe("مقدمه");
    expect(normalize("العـــربية")).toBe("العربيه");
    expect(normalize("مستشفى")).toBe("مستشفي");
    expect(normalize("Straße")).toBe("strasse");
    expect(normalize("ﬁle")).toBe("file"); // NFKC ligature
  });
});

describe("search", () => {
  const categories = [category(1, "Programming"), category(2, "Histoire"), category(3, "العربية")];
  const books = [
    book("Structure and Interpretation of Computer Programs", "Abelson & Sussman", 1, "2026-10-01T10:00:00Z"),
    book("Programming Pearls", "Jon Bentley", 1),
    book("The Pragmatic Programmer", "Hunt & Thomas", 1, "2026-10-02T10:00:00Z"),
    book("Histoire de la France", "Jules Michelet", 2),
    book("L'École des Annales", "Peter Burke", 2),
    book("مُقَدِّمَة ابن خلدون", "ابن خلدون", 3),
    book("كتاب الأغاني", "أبو الفرج الأصفهاني", 3),
  ];
  const index = buildIndex(books, categories);
  const titles = (query: string) => search(index, query).map((result) => result.book.title);

  it("matches across scripts and forms (spec examples)", () => {
    expect(titles("إبن")).toContain("مُقَدِّمَة ابن خلدون");
    expect(titles("ابن")).toContain("مُقَدِّمَة ابن خلدون");
    expect(titles("histoire")[0]).toBe("Histoire de la France");
    expect(titles("ecole")).toEqual(["L'École des Annales"]);
    expect(titles("مقدمة")).toEqual(["مُقَدِّمَة ابن خلدون"]);
    expect(titles("الاغاني")).toEqual(["كتاب الأغاني"]);
  });

  it("ranks title start > title word > title contains > author > category", () => {
    const results = search(index, "program");
    expect(results.map((r) => [r.book.title, r.match])).toEqual([
      ["Programming Pearls", "title-start"],
      ["The Pragmatic Programmer", "title-word"],
      ["Structure and Interpretation of Computer Programs", "title-word"],
    ]);
    expect(search(index, "michelet").map((r) => r.match)).toEqual(["author"]);
    // Category match: every Histoire book; title matches first.
    expect(search(index, "histoire").map((r) => r.match)).toEqual(["title-start", "category"]);
  });

  it("breaks ties by the most recently opened book", () => {
    const tie = buildIndex([book("Alpha", null, 1, "2026-01-01T00:00:00Z"), book("Alpha two", null, 1, "2026-05-01T00:00:00Z"), book("Alpha three", null, 1)], categories);
    expect(search(tie, "alpha").map((r) => r.book.title)).toEqual(["Alpha two", "Alpha", "Alpha three"]);
  });

  it("returns at most 8 results and nothing for an empty query", () => {
    const many = buildIndex(Array.from({ length: 20 }, (_, i) => book(`Volume ${i}`, null, 1)), categories);
    expect(search(many, "volume")).toHaveLength(8);
    expect(search(many, "   ")).toEqual([]);
    expect(search(index, "zzz")).toEqual([]);
  });
});
