/**
 * English and Arabic UI strings (docs/ARCHITECTURE.md section 13, docs/DESIGN.md 12-13).
 *
 * Every UI string goes through `t()`. Plural entries use Intl.PluralRules categories, so
 * Arabic gets its zero/one/two/few/many/other forms. Numbers always use Western digits.
 */

export type Language = "en" | "ar";

export type PluralForms = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};

export type Message = string | PluralForms;

export type Vars = Record<string, string | number>;

const en = {
  "app.name": "Dar al Ilm",
  "app.nameArabic": "دار العلم",
  "app.tagline": "Your library, as a place you can walk through.",
  "app.building": "The reading hall is being built.",
  "boot.opening": "Opening the library…",
  "status.checking": "Connecting to the library service…",
  "status.connected": "Library service connected",
  "status.disconnected": "Library service not connected",
  "status.restartHint": "Run ./start.sh to restart it.",
  "library.summary": "{books} in {categories}",
  "count.books": { one: "{count} book", other: "{count} books" },
  "count.categories": { one: "{count} category", other: "{count} categories" },
  "count.pages": { one: "{count} page", other: "{count} pages" },
  "reader.loading": "Opening the book…",
  "reader.notFound": "This book is not in the library.",
  "reader.closed": "Book closed.",
  "reader.open": "Open",
  "reader.close": "Close book",
  "reader.toolbar": "Reader controls",
  "reader.previous": "Previous page",
  "reader.next": "Next page",
  "reader.position": "Position in the book",
  "reader.goToPage": "Go to page",
  "reader.pageInput": "Page number",
  "reader.pageLabel": "{pages} / {total}",
  "reader.zoomIn": "Zoom in",
  "reader.zoomOut": "Zoom out",
  "reader.resetZoom": "Reset zoom to 100%",
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof en;

const ar: Record<MessageKey, Message> = {
  "app.name": "دار العلم",
  "app.nameArabic": "دار العلم",
  "app.tagline": "مكتبتك، مكانٌ تتجوّل فيه.",
  "app.building": "قاعة القراءة قيد البناء.",
  "boot.opening": "جارٍ فتح المكتبة…",
  "status.checking": "جارٍ الاتصال بخدمة المكتبة…",
  "status.connected": "خدمة المكتبة متصلة",
  "status.disconnected": "خدمة المكتبة غير متصلة",
  "status.restartHint": "شغّل ‎./start.sh‎ لإعادة تشغيلها.",
  "library.summary": "{books} في {categories}",
  "count.books": {
    zero: "لا كتب",
    one: "كتاب واحد",
    two: "كتابان",
    few: "{count} كتب",
    many: "{count} كتابًا",
    other: "{count} كتاب",
  },
  "count.categories": {
    zero: "لا تصنيفات",
    one: "تصنيف واحد",
    two: "تصنيفان",
    few: "{count} تصنيفات",
    many: "{count} تصنيفًا",
    other: "{count} تصنيف",
  },
  "count.pages": {
    zero: "لا صفحات",
    one: "صفحة واحدة",
    two: "صفحتان",
    few: "{count} صفحات",
    many: "{count} صفحة",
    other: "{count} صفحة",
  },
  "reader.loading": "جارٍ فتح الكتاب…",
  "reader.notFound": "هذا الكتاب غير موجود في المكتبة.",
  "reader.closed": "أُغلق الكتاب.",
  "reader.open": "فتح",
  "reader.close": "إغلاق الكتاب",
  "reader.toolbar": "أدوات القراءة",
  "reader.previous": "الصفحة السابقة",
  "reader.next": "الصفحة التالية",
  "reader.position": "الموضع في الكتاب",
  "reader.goToPage": "الانتقال إلى صفحة",
  "reader.pageInput": "رقم الصفحة",
  "reader.pageLabel": "{pages} / {total}",
  "reader.zoomIn": "تكبير",
  "reader.zoomOut": "تصغير",
  "reader.resetZoom": "إعادة التكبير إلى 100%",
};

const DICTIONARIES: Record<Language, Record<MessageKey, Message>> = { en, ar };

const LOCALES: Record<Language, string> = { en: "en", ar: "ar" };

/** Key used by the inline script in layout.tsx to set the direction before first paint. */
export const LANGUAGE_STORAGE_KEY = "dar.lang";

let currentLanguage: Language = "en";

export function getLanguage(): Language {
  return currentLanguage;
}

export function direction(language: Language): "ltr" | "rtl" {
  return language === "ar" ? "rtl" : "ltr";
}

/** Western digits in both languages (docs/DESIGN.md section 8). */
export function formatNumber(value: number, language: Language = currentLanguage): string {
  return new Intl.NumberFormat(LOCALES[language], { numberingSystem: "latn" }).format(value);
}

export function pluralCategory(count: number, language: Language): Intl.LDMLPluralRule {
  return new Intl.PluralRules(LOCALES[language]).select(count);
}

function interpolate(template: string, vars: Vars, language: Language): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    return typeof value === "number" ? formatNumber(value, language) : value;
  });
}

/** Translate `key`. Plural messages need a numeric `count` in `vars`. */
export function t(key: MessageKey, vars: Vars = {}, language: Language = currentLanguage): string {
  const message = DICTIONARIES[language][key];
  if (typeof message === "string") return interpolate(message, vars, language);
  const count = vars.count;
  if (typeof count !== "number") {
    throw new Error(`Message "${key}" is a plural and needs a numeric "count".`);
  }
  const form = message[pluralCategory(count, language)] ?? message.other;
  return interpolate(form, vars, language);
}

/** Switch the UI language: sets <html lang dir> and remembers it for the next start. */
export function applyLanguage(language: Language): void {
  currentLanguage = language;
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
    document.documentElement.dir = direction(language);
  }
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable (private mode); the setting still lives in the database.
  }
}
