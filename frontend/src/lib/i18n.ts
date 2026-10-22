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
  "search.label": "Search",
  "search.placeholder": "Search title, author or category",
  "search.noResults": 'No books match "{query}".',
  "search.results": "Search results",
  "shelf.addBook": "Add book",
  "desk.empty": "Books you open will appear here.",
  "present.open": "Open",
  "present.edit": "Edit",
  "present.delete": "Delete",
  "hint.label": "Keyboard and mouse",
  "hint.walk": "Walk",
  "hint.drag": "Drag",
  "hint.look": "Look",
  "hint.desk": "Desk",
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
  "reader.resetZoom": "Reset zoom to 100%",
  "action.cancel": "Cancel",
  "action.close": "Close",
  "action.addBook": "Add book",
  "action.saveChanges": "Save changes",
  "action.deleteBook": "Delete book",
  "action.retry": "Retry",
  "field.required": "required",
  "field.title": "Title",
  "field.author": "Author",
  "field.notes": "Notes",
  "field.category": "Category",
  "field.direction": "Reading direction",
  "field.cover": "Cover",
  "field.categoryPlaceholder": "Choose a category",
  "field.noCategories": "Create a category first.",
  "direction.LTR": "Left to right",
  "direction.RTL": "Right to left",
  "invalid.title": "Enter a title.",
  "invalid.category": "Choose a category.",
  "invalid.direction": "Choose a reading direction.",
  "add.title": "Add book",
  "add.drop": "Drop a PDF here",
  "add.choose": "or choose a file",
  "add.chooseLabel": "Choose a PDF file",
  "add.chooseAnother": "Choose another file",
  "add.uploading": "Uploading…",
  "add.reading": "Reading the PDF…",
  "add.dropAnywhere": "Drop the PDF to add it",
  "add.added": "Book added",
  "cover.page1": "Page 1",
  "cover.custom": "Custom cover",
  "cover.choose": "Choose a custom cover",
  "cover.replace": "Replace cover",
  "cover.usePage1": "Use page 1",
  "duplicate.message": 'Already in your library: "{title}".',
  "duplicate.importAnyway": "Import anyway",
  "duplicate.openExisting": "Open existing",
  "edit.title": "Edit book",
  "edit.saved": "Changes saved",
  "delete.title": "Delete book",
  "delete.body": 'Delete "{title}"?',
  "delete.detail": "Its PDF and cover will be removed from the library folder.",
  "delete.deleted": "Book deleted",
  "error.not_pdf": "This file isn't a PDF. Choose a .pdf file.",
  "error.file_too_large": "This PDF is larger than 2 GB.",
  "error.pdf_encrypted": "This PDF is password-protected. Remove the password, then add it again.",
  "error.pdf_empty": "This PDF has no pages.",
  "error.pdf_damaged": "This PDF is damaged and can't be opened.",
  "error.invalid_cover": "Use a PNG, JPEG or WebP image under 10 MB.",
  "error.upload_not_found": "This upload expired. Choose the file again.",
  "error.category_not_found": "This category no longer exists. Choose another one.",
  "error.book_not_found": "This book is no longer in the library.",
  "error.network_error": "The library service stopped. Run ./start.sh to restart it.",
  "error.other": "The library service refused the request (error {status}).",
  "action.settings": "Settings",
  "action.save": "Save",
  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.graphics": "Graphics",
  "preset.auto": "Auto",
  "preset.performance": "Performance",
  "preset.high": "High",
  "preset.autoHint": "Adapts the resolution to keep walking smooth.",
  "preset.performanceHint": "For older computers: no shadows and no edge smoothing.",
  "preset.highHint": "Sharper shadows and textures, for strong graphics cards.",
  "settings.ambient": "Ambient light",
  "settings.defaultDirection": "Default reading direction",
  "settings.defaultDirectionHint": "Used for new books whose title is not in Arabic.",
  "settings.categories": "Categories",
  "settings.saveFailed": "This setting could not be saved. Try again.",
  "category.name": "Category name",
  "category.new": "New category",
  "category.create": "Create category",
  "category.rename": "Rename",
  "category.renameLabel": "Rename {name}",
  "category.deleteLabel": "Delete {name}",
  "category.none": "No categories yet.",
  "category.created": "Category created",
  "category.renamed": "Category renamed",
  "category.deleted": "Category deleted",
  "category.deleteTitle": "Delete category",
  "category.deleteEmpty": 'Delete "{name}"?',
  "category.moveTo": "Move its books to:",
  "category.moveAndDelete": "Move books and delete",
  "category.noOther": "Create another category first, then move these books into it.",
  "invalid.categoryName": "Enter a name.",
  "error.category_name_taken": "A category with this name already exists.",
  "error.category_not_empty": '"{name}" has {books}. Move them to another category to delete it.',
  "welcome.title": "Welcome to Dar al Ilm",
  "welcome.body": "Create a category, then add your first book.",
  "welcome.action": "Create your first category",
  "welcome.suggestions": "Or start with one of these:",
  "welcome.chip.programming": "Programming",
  "welcome.chip.history": "History",
  "welcome.chip.novels": "Novels",
  "welcome.chip.arabic": "العربية",
  "welcome.addFirst": "Now add your first book: choose Add book, or drop a PDF anywhere in the hall.",
  "action.dismiss": "Dismiss",
  "graphics.software": "Graphics acceleration is off, so 3D will be slow.",
  "graphics.howTo": "How to turn it on",
  "graphics.stepsChromium": 'Chrome, Edge or Brave: open Settings, then System, turn on "Use graphics acceleration when available", and relaunch the browser.',
  "graphics.stepsFirefox": 'Firefox: open Settings, then General; under Performance, clear "Use recommended performance settings", turn on "Use hardware acceleration when available", and restart Firefox.',
  "graphics.stepsDriver": "If it is already on, update your graphics driver.",
  "error.noWebgl": "This browser can't display 3D. Open Dar al Ilm in Chrome, Edge, Brave or Firefox with graphics acceleration on.",
  "error.apiUnreachable": "The library service stopped. Run ./start.sh to restart it.",
  "status.reconnecting": "Reconnecting…",
  "status.retryIn": "Trying again in {seconds} s",
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
  "search.label": "بحث",
  "search.placeholder": "ابحث بالعنوان أو المؤلف أو التصنيف",
  "search.noResults": "لا توجد كتب تطابق «{query}».",
  "search.results": "نتائج البحث",
  "shelf.addBook": "إضافة كتاب",
  "desk.empty": "ستظهر هنا الكتب التي تفتحها.",
  "present.open": "فتح",
  "present.edit": "تعديل",
  "present.delete": "حذف",
  "hint.label": "لوحة المفاتيح والفأرة",
  "hint.walk": "المشي",
  "hint.drag": "اسحب",
  "hint.look": "النظر",
  "hint.desk": "المكتب",
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
  "reader.resetZoom": "إعادة التكبير إلى 100%",
  "action.cancel": "إلغاء",
  "action.close": "إغلاق",
  "action.addBook": "إضافة كتاب",
  "action.saveChanges": "حفظ التغييرات",
  "action.deleteBook": "حذف الكتاب",
  "action.retry": "إعادة المحاولة",
  "field.required": "مطلوب",
  "field.title": "العنوان",
  "field.author": "المؤلف",
  "field.notes": "ملاحظات",
  "field.category": "التصنيف",
  "field.direction": "اتجاه القراءة",
  "field.cover": "الغلاف",
  "field.categoryPlaceholder": "اختر تصنيفًا",
  "field.noCategories": "أنشئ تصنيفًا أولًا.",
  "direction.LTR": "من اليسار إلى اليمين",
  "direction.RTL": "من اليمين إلى اليسار",
  "invalid.title": "أدخل العنوان.",
  "invalid.category": "اختر تصنيفًا.",
  "invalid.direction": "اختر اتجاه القراءة.",
  "add.title": "إضافة كتاب",
  "add.drop": "أفلت ملف PDF هنا",
  "add.choose": "أو اختر ملفًا",
  "add.chooseLabel": "اختر ملف PDF",
  "add.chooseAnother": "اختر ملفًا آخر",
  "add.uploading": "جارٍ الرفع…",
  "add.reading": "جارٍ قراءة ملف PDF…",
  "add.dropAnywhere": "أفلت ملف PDF لإضافته",
  "add.added": "أُضيف الكتاب",
  "cover.page1": "الصفحة الأولى",
  "cover.custom": "غلاف مخصّص",
  "cover.choose": "اختر غلافًا مخصّصًا",
  "cover.replace": "استبدال الغلاف",
  "cover.usePage1": "استخدام الصفحة الأولى",
  "duplicate.message": "هذا الكتاب موجود في مكتبتك: «{title}».",
  "duplicate.importAnyway": "استيراد على أي حال",
  "duplicate.openExisting": "فتح الموجود",
  "edit.title": "تعديل الكتاب",
  "edit.saved": "حُفظت التغييرات",
  "delete.title": "حذف الكتاب",
  "delete.body": "هل تريد حذف «{title}»؟",
  "delete.detail": "سيُحذف ملف PDF والغلاف الخاصان به من مجلد المكتبة.",
  "delete.deleted": "حُذف الكتاب",
  "error.not_pdf": "هذا الملف ليس بصيغة PDF. اختر ملفًا بامتداد ‎.pdf‎.",
  "error.file_too_large": "حجم ملف PDF هذا أكبر من 2 غيغابايت.",
  "error.pdf_encrypted": "ملف PDF هذا محمي بكلمة مرور. أزل كلمة المرور ثم أضفه من جديد.",
  "error.pdf_empty": "لا يحتوي ملف PDF هذا على أي صفحة.",
  "error.pdf_damaged": "ملف PDF هذا تالف ولا يمكن فتحه.",
  "error.invalid_cover": "استخدم صورة PNG أو JPEG أو WebP أصغر من 10 ميغابايت.",
  "error.upload_not_found": "انتهت صلاحية هذا الرفع. اختر الملف من جديد.",
  "error.category_not_found": "لم يعد هذا التصنيف موجودًا. اختر تصنيفًا آخر.",
  "error.book_not_found": "لم يعد هذا الكتاب في المكتبة.",
  "error.network_error": "توقفت خدمة المكتبة. شغّل ‎./start.sh‎ لإعادة تشغيلها.",
  "error.other": "رفضت خدمة المكتبة الطلب (الخطأ {status}).",
  "action.settings": "الإعدادات",
  "action.save": "حفظ",
  "settings.title": "الإعدادات",
  "settings.language": "اللغة",
  "settings.graphics": "الرسوميات",
  "preset.auto": "تلقائي",
  "preset.performance": "الأداء",
  "preset.high": "جودة عالية",
  "preset.autoHint": "يضبط الدقة تلقائيًا ليبقى التجوّل سلسًا.",
  "preset.performanceHint": "للحواسيب الأقدم: دون ظلال ودون تنعيم للحواف.",
  "preset.highHint": "ظلال وخامات أوضح، لبطاقات الرسوميات القوية.",
  "settings.ambient": "الإضاءة المحيطة",
  "settings.defaultDirection": "اتجاه القراءة الافتراضي",
  "settings.defaultDirectionHint": "يُستخدم للكتب الجديدة التي لا يكون عنوانها بالعربية.",
  "settings.categories": "التصنيفات",
  "settings.saveFailed": "تعذّر حفظ هذا الإعداد. حاول مرة أخرى.",
  "category.name": "اسم التصنيف",
  "category.new": "تصنيف جديد",
  "category.create": "إنشاء تصنيف",
  "category.rename": "إعادة تسمية",
  "category.renameLabel": "إعادة تسمية «{name}»",
  "category.deleteLabel": "حذف «{name}»",
  "category.none": "لا توجد تصنيفات بعد.",
  "category.created": "أُنشئ التصنيف",
  "category.renamed": "أُعيدت تسمية التصنيف",
  "category.deleted": "حُذف التصنيف",
  "category.deleteTitle": "حذف التصنيف",
  "category.deleteEmpty": "هل تريد حذف «{name}»؟",
  "category.moveTo": "انقل كتبه إلى:",
  "category.moveAndDelete": "نقل الكتب والحذف",
  "category.noOther": "أنشئ تصنيفًا آخر أولًا، ثم انقل هذه الكتب إليه.",
  "invalid.categoryName": "أدخل اسمًا.",
  "error.category_name_taken": "يوجد تصنيف بهذا الاسم بالفعل.",
  "error.category_not_empty": "يحتوي «{name}» على {books}. انقلها إلى تصنيف آخر لحذفه.",
  "welcome.title": "مرحبًا بك في دار العلم",
  "welcome.body": "أنشئ تصنيفًا، ثم أضف كتابك الأول.",
  "welcome.action": "أنشئ أول تصنيف",
  "welcome.suggestions": "أو ابدأ بأحد هذه التصنيفات:",
  "welcome.chip.programming": "البرمجة",
  "welcome.chip.history": "التاريخ",
  "welcome.chip.novels": "الروايات",
  "welcome.chip.arabic": "العربية",
  "welcome.addFirst": "أضف الآن كتابك الأول: اختر «إضافة كتاب»، أو أفلت ملف PDF في أي مكان من القاعة.",
  "action.dismiss": "إخفاء",
  "graphics.software": "تسريع الرسوميات معطّل، لذا سيكون العرض ثلاثي الأبعاد بطيئًا.",
  "graphics.howTo": "كيفية تفعيله",
  "graphics.stepsChromium": "في Chrome أو Edge أو Brave: افتح الإعدادات، ثم النظام، وفعّل «استخدام تسريع الرسومات عند توفره»، ثم أعد تشغيل المتصفح.",
  "graphics.stepsFirefox": "في Firefox: افتح الإعدادات، ثم عام؛ ومن قسم الأداء ألغِ تحديد «استخدام إعدادات الأداء المستحسنة»، وفعّل «استخدام تسريع العتاد عند توفره»، ثم أعد تشغيل Firefox.",
  "graphics.stepsDriver": "إن كان مفعّلًا بالفعل، فحدِّث برنامج تشغيل بطاقة الرسوميات.",
  "error.noWebgl": "لا يستطيع هذا المتصفح عرض المحتوى ثلاثي الأبعاد. افتح دار العلم في Chrome أو Edge أو Brave أو Firefox مع تفعيل تسريع الرسوميات.",
  "error.apiUnreachable": "توقفت خدمة المكتبة. شغّل ‎./start.sh‎ لإعادة تشغيلها.",
  "status.reconnecting": "جارٍ إعادة الاتصال…",
  "status.retryIn": "محاولة جديدة بعد {seconds} ث",
};

const DICTIONARIES: Record<Language, Record<MessageKey, Message>> = { en, ar };

/** Every message per language (tests check that no English is left in the Arabic UI). */
export const MESSAGES: Readonly<Record<Language, Readonly<Record<MessageKey, Message>>>> = DICTIONARIES;

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
