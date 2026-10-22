import { afterEach, describe, expect, it } from "vitest";

import { applyLanguage, direction, formatNumber, getLanguage, pluralCategory, t } from "./i18n";

afterEach(() => applyLanguage("en"));

describe("Arabic plurals", () => {
  it.each([
    [0, "zero", "لا كتب"],
    [1, "one", "كتاب واحد"],
    [2, "two", "كتابان"],
    [3, "few", "3 كتب"],
    [11, "many", "11 كتابًا"],
    [100, "other", "100 كتاب"],
  ])("%i books -> %s", (count, category, text) => {
    expect(pluralCategory(count, "ar")).toBe(category);
    expect(t("count.books", { count }, "ar")).toBe(text);
  });

  it("uses the page forms from DESIGN.md", () => {
    expect(t("count.pages", { count: 2 }, "ar")).toBe("صفحتان");
    expect(t("count.pages", { count: 7 }, "ar")).toBe("7 صفحات");
    expect(t("count.pages", { count: 342 }, "ar")).toBe("342 صفحة");
  });
});

describe("English plurals", () => {
  it.each([
    [0, "0 books"],
    [1, "1 book"],
    [2, "2 books"],
    [1234, "1,234 books"],
  ])("%i", (count, text) => {
    expect(t("count.books", { count }, "en")).toBe(text);
  });
});

describe("numbers", () => {
  it("uses Western digits in Arabic", () => {
    const formatted = formatNumber(1234567, "ar");
    expect(formatted.replace(/\D/g, "")).toBe("1234567");
    expect(/[٠-٩۰-۹]/.test(formatted)).toBe(false);
  });
});

describe("interpolation and language", () => {
  it("fills nested messages", () => {
    const books = t("count.books", { count: 40 }, "en");
    const categories = t("count.categories", { count: 4 }, "en");
    expect(t("library.summary", { books, categories }, "en")).toBe("40 books in 4 categories");
    const arBooks = t("count.books", { count: 40 }, "ar");
    const arCategories = t("count.categories", { count: 4 }, "ar");
    expect(t("library.summary", { books: arBooks, categories: arCategories }, "ar")).toBe(
      "40 كتابًا في 4 تصنيفات",
    );
  });

  it("requires a count for plural messages", () => {
    expect(() => t("count.books")).toThrow(/count/);
  });

  it("switches the current language", () => {
    expect(getLanguage()).toBe("en");
    applyLanguage("ar");
    expect(getLanguage()).toBe("ar");
    expect(t("status.connected")).toBe("خدمة المكتبة متصلة");
    expect(direction("ar")).toBe("rtl");
    expect(direction("en")).toBe("ltr");
  });
});
