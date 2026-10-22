# DESIGN.md — Dar al Ilm (دار العلم) Design Direction

Approved direction (decision D59): **a neutral, modern library hall with Arabic design accents.**
This file governs the look and feel of every 3D scene and UI overlay. Engineering rules live in
`docs/ARCHITECTURE.md`; when the two meet (budgets, idle rendering), the engineering rule wins
and the design adapts.

---

## 1. Concept: "Light through geometry"

A contemporary public reading hall: pale limestone, light ash wood, clean planes, generous
height and quiet. Arabic design lives in the light and the details, not in costume:
daylight falls through mashrabiya screens and draws eight-point stars across the floor; brass
plaques carry the category names; a clean pointed arch frames the entrance.

The hall should feel bright, calm and contemporary on first sight, and reveal its Arabic soul
the longer you look.

### Principles

1. **One signature, everything else quiet.** The memorable element is patterned daylight on the
   stone floor. Architecture, UI and motion stay restrained around it.
2. **Geometry with purpose.** The eight-point star (khatam) and mashrabiya lattice appear in
   exactly five places: the floor light pattern, the entrance floor medallion, the plaque
   borders, the logo, and the loading mark. Nowhere else.
3. **Books are the colour.** Architecture stays neutral so the books' spines provide the colour,
   as in a real library.
4. **Modern, not themed.** No ornate arabesque on every surface, no gold-and-emerald clichés, no
   faux-antique textures. Clean forms with one or two crafted details each.
5. **Still when idle.** Atmosphere comes from light and material, never from looping animation
   (the scene renders zero frames when nothing moves).

---

## 2. The Hall

| Element | Design |
|---|---|
| Entrance | A tall, clean pointed arch in smooth plaster, no ornament. In the floor just inside, an eight-point star medallion inlaid in lapis stone and brass. |
| Nave | Central aisle with large-format pale limestone tiles and thin brass inlay lines running along its length. Ceiling 6 m with long skylight slots screened by mashrabiya lattices. |
| Signature light | Daylight through the ceiling lattice casts a soft eight-point-star pattern along the nave floor (a static light-map texture, see `docs/ARCHITECTURE.md` §10.6). |
| Bays | Side aisles off the nave, one per category, lined with ash bookcases facing each other. Bay openings stay simple and rectangular so the books dominate. |
| Columns | Slim limestone columns at the nave edge, one per bay, with a simplified stepped capital inspired by muqarnas (three plain steps, no carving). |
| Plaques | Brushed brass blade signs hanging from the column capital on two thin rods, perpendicular to the nave so they are readable while walking. Category name engraved; a thin etched band of interlaced lines borders the plate. Double-sided. |
| Bookcases | Light ash, slim profiles, a darker walnut edge on each shelf, brass bookends. End panels carry a small mashrabiya insert. |
| Entrance desk | A long, low ash desk with a brass edge strip and three angled book stands. A single brass pendant above it with a perforated star-pattern shade. |
| End wall | A shallow arched niche with a reading bench, lit by a warm wall-washer. |
| Empty hall | With no categories: the entrance, the desk, the floor light and one softly lit empty bay outline waiting to be filled. |

---

## 3. Lighting

| Light | Colour | Role |
|---|---|---|
| Skylight daylight (key) | Neutral-cool, about 5000 K | Even, soft light down the nave; produces the floor pattern (static light map). |
| Pendant lamps | Warm, about 2700 K | Small warm pools over the desk and bay entrances; emissive shade + additive halo sprite, no post-processing. |
| Wall-washers | Warm, about 3000 K | Graze the end-wall niche and bay back walls for depth. |
| Environment | Built from drei `<Lightformer>`s | Soft reflections on brass and polished stone. No HDR download. |

- Tone mapping: AgX. Exposure follows the **Ambient light** setting (0.4–1.5).
- Light, neutral fog tinted with the limestone colour adds depth and hides far, low-detail bays.
- One directional shadow (auto/high presets), rendered once. Contact darkening under the desk and
  bookcases is baked into textures.
- Warm vs cool contrast does the mood work: cool daylight in the nave, warm pools where people
  read.

---

## 4. Materials

| Material | Base colour | Roughness | Metalness | Notes |
|---|---|---|---|---|
| Limestone floor and columns | `#E7E3DB` | 0.40 (floor) / 0.70 (columns) | 0 | Subtle large-scale variation, no visible tiling repeats. |
| Plaster walls and arches | `#EEEBE5` | 0.90 | 0 | Matte; takes light gradients beautifully. |
| Ash wood (bookcases, desk) | `#C8B699` | 0.55 | 0 | Fine straight grain, 1K texture. |
| Walnut edge (shelf fronts) | `#5A4636` | 0.50 | 0 | Thin accent only. |
| Brass (plaques, inlays, bookends, lamps) | `#B08A4E` | 0.35 brushed / 0.25 polished inlay | 1.0 | Never mirror-like. |
| Lapis inlay (entrance medallion) | `#2C4C9C` | 0.30 | 0 | Only in the medallion. |
| Mashrabiya screens | `#3A3026` | 0.60 | 0 | Dark wood lattice; reads as silhouette against light. |
| Book cloth and leather | from `spine_color`, desaturated 15 % | 0.70 | 0 | Keeps hundreds of different covers harmonious. |
| Page edges | `#EFE9DC` | 0.85 | 0 | Slightly warm paper block. |

---

## 5. Books

- **Spines:** cloth/leather in the cover's colour (desaturated 15 %). Title along the spine,
  author smaller. Label colour by contrast: gilt `#D8B77A` on dark spines, ink `#1E2230` on
  light spines.
- **Spine typography:** Latin in Inter Medium, Arabic in Cairo SemiBold. Spine text is rotated
  90° clockwise for every book, so the whole shelf shares one orientation; each script keeps its
  own direction along the spine.
- **Hover:** the book slides out 5 cm with a thin warm rim light (`#D8B77A`) and a small tooltip
  with the full title.
- **Present:** the book lifts out and turns its cover toward you at arm's length, turned 15° so
  its boards, spine and gilt bands show; Open, Edit and Delete appear beneath it in a compact
  panel. Every closed book shown up close is a real hardcover: cloth boards with thickness
  overhanging the page block, a rounded spine with two gilt bands, endpapers inside.
- **Search arrival:** the target book's rim glows gilt, pulses twice, then holds for 3 s.

---

## 6. The Reader

- The hall recedes behind an ink vignette (`#1E2230`, 85 % at the edges, 60 % at the centre),
  so the open book is the only bright object.
- The book lies open like a real book on a desk, leaning back slightly: its pages rise out of
  the gutter in a soft arc, crown and settle toward the fore-edge; under them the page block
  shows its fine paper edges at the fore-edge, head and tail, on cloth boards in the book's spine
  colour that overhang the block; a soft gutter shadow, gentle shading across the curl of a
  turning page, and a soft shadow under the book.
- Pages show the PDF image as is on a paper base `#F6F5F2`; no tint over the scan.
- The reader toolbar floats at the bottom (see §10).

---

## 7. Colour Tokens (UI)

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#1E2230` | Primary text, icons, reader backdrop. Blue-black, like manuscript ink. |
| `--slate` | `#5B6070` | Secondary text, placeholders, inactive icons. |
| `--paper` | `#F6F5F2` | Solid panel surface (performance preset), inputs, page base. |
| `--limestone` | `#E7E3DB` | Panel tint (with alpha), dividers on paper. |
| `--lapis` | `#2C4C9C` | Primary actions, links, focus ring, selection. |
| `--brass` | `#B08A4E` | Logo, decorative lines, active markers. Never body text on light surfaces. |
| `--gilt` | `#D8B77A` | Hover highlights in 3D, label text on dark spines. |
| `--verdigris` | `#3D7A6F` | Success (aged-brass patina). |
| `--ochre` | `#8F6420` | Warnings (software rendering banner). |
| `--rubric` | `#B0392A` | Errors and destructive actions (the red of manuscript rubrics). |

Checked contrast pairs (WCAG AA ≥ 4.5:1 for text):

| Pair | Ratio |
|---|---|
| ink on paper | ≈ 14.5 : 1 |
| slate on paper | ≈ 5.7 : 1 |
| lapis on paper | ≈ 7.3 : 1 |
| white on lapis | ≈ 8.0 : 1 |
| white on rubric | ≈ 6.1 : 1 |
| white on verdigris | ≈ 5.0 : 1 |
| ochre on paper | ≈ 4.8 : 1 |

Brass on paper is below 4.5:1: brass is decoration only.

---

## 8. Typography

- **Families:** Inter (Latin) and Cairo (Arabic), variable `.woff2`, loaded locally with
  `next/font/local`. Font stack `Inter, Cairo, system-ui, sans-serif`: Latin glyphs come from
  Inter, Arabic glyphs fall through to Cairo.
- **Scale (px):** 12, 14, 16, 18, 21, 24, 30, 36, 48. Body 16; secondary 14; captions 12.
- **Weights:** Inter 400 body, 500 labels and buttons, 600 headings. Cairo 400 body, 600 labels,
  700 headings and plaques.
- **Arabic adjustments:** Arabic text is set one step larger than the Latin equivalent and uses
  line-height 1.7 (Latin 1.5). Never apply letter-spacing to Arabic: it breaks the joins.
- **Case:** sentence case everywhere ("Add book", "Reading direction"). No all-caps labels, no
  tracked-out eyebrow labels.
- **Numerals:** Western digits in both languages; tabular figures (`font-variant-numeric:
  tabular-nums`) for page counters and sizes.
- **Plaques:** the category name is the hero of each plaque: large, sentence case, Inter
  SemiBold for Latin, Cairo Bold for Arabic, centred, up to 2 lines, shrinking to fit.
- **Line length:** text blocks (notes, descriptions) stay under 70 characters per line.

---

## 9. Logo and Iconography

- **Logo:** an eight-point star drawn as two overlapping squares in a single brass outline, with
  the wordmark "Dar al Ilm" (Inter SemiBold) and "دار العلم" (Cairo Bold). In the Arabic UI the
  Arabic name comes first.
- **Icons:** `lucide-react`, 20 px, stroke 1.5, colour `--ink` or `--slate`. Direction icons
  (arrows, chevrons, "back") mirror in RTL; media-style and numeric controls do not.

---

## 10. UI Overlays

The 3D hall is the interface; overlays float above it and step back when not needed.

### 10.1 Surfaces

- **Panel ("limestone glass"):** background `rgba(246, 245, 242, 0.84)` with
  `backdrop-filter: blur(18px) saturate(1.1)`, 1 px border `rgba(30, 34, 48, 0.08)`, shadow
  `0 12px 40px rgba(30, 34, 48, 0.18)`. In the performance preset: solid `--paper`, no blur.
- **Radii by hierarchy:** modals and large panels 16 px; controls (buttons, inputs, menus)
  10 px; chips and the search pill fully rounded.
- **Spacing:** 4 px base grid (4, 8, 12, 16, 24, 32, 48).

### 10.2 Layouts

Hall view (LTR; RTL mirrors):
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ✦ Dar al Ilm          ( ⌕  Search title, author or category      / )   [+ Add book] ⚙ │
│                                                                          │
│                                (3D hall)                                 │
│                                                                          │
│ [↑][↓][←][→] Walk   [Drag] Look   [Home] Desk                            │
└──────────────────────────────────────────────────────────────────────────┘
```
- Top elements are separate floating pieces (logo, search pill, actions), not a full-width bar.
  They fade to 40 % opacity while walking and return on mouse movement near the top.
- The key hint appears on first launch and after 30 s of inactivity in the entrance zone; it
  hides once the user has walked.

Reader view:
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ✕  Muqaddimah, Ibn Khaldun                                               │
│                  ┌───────────────┬───────────────┐                       │
│                  │      12       │      13       │                       │
│                  └───────────────┴───────────────┘                       │
│              ‹   ━━━━━━━━●━━━━━━━━━━━━━━━   12–13 / 340   ›   200%          │
└──────────────────────────────────────────────────────────────────────────┘
```
- The toolbar is one floating pill at the bottom centre. It hides after 2.5 s without mouse
  movement.
- Zoom is the mouse wheel over the book, which comes closer around the cursor; there are no
  zoom buttons. While zoomed, the pill ends with the zoom level (`200%`), which returns to
  100 % when clicked.

Modal:
```
┌───────────────────────────────────────────┐
│ Add book                                ✕ │
│ ┌─────────┐  Title *                      │
│ │ cover   │  [__________________________] │
│ │ preview │  Category *        Direction *│
│ │ 342 p.  │  [__________ ▾]    (LTR)(RTL) │
│ └─────────┘  Author                       │
│              [__________________________] │
│              Notes                        │
│              [__________________________] │
│                       [Cancel]  [Add book]│
└───────────────────────────────────────────┘
```
- Width 560 px, content start-aligned. Primary action at the end side.

### 10.3 Components

| Component | Design |
|---|---|
| Primary button | `--lapis` fill, white text, 10 px radius, 40 px high. Hover: 6 % lighter. |
| Secondary button | Transparent, 1 px `--limestone` border darker on hover, `--ink` text. |
| Destructive button | `--rubric` fill, white text. Used only inside confirmation dialogs. |
| Inputs | `--paper` fill, 1 px border `rgba(30,34,48,0.14)`, focus: 2 px `--lapis` ring with 2 px offset. Labels above fields; required fields marked with `*` and an accessible "required". |
| Segmented control (LTR/RTL, language, presets) | Pill group; selected segment `--ink` fill with white text. |
| Search pill | 44 px high, magnifier icon, placeholder in `--slate`, `/` key hint at the end. Results panel below with cover thumbnails (40 × 56 px). |
| Toasts | Bottom centre above the reader toolbar position, panel surface, 4 s, one at a time. Success icon `--verdigris`. |
| Banners | Top centre under the top bar, panel surface with a 3 px start-side stripe: `--ochre` (warning) or `--rubric` (error). |
| Present panel (3D, via `<Html>`) | Compact panel under the presented book: title, author, page count, then Open (primary), Edit, Delete (secondary; Delete text in `--rubric`). |
| Debug HUD (F2) | Top end corner, monospace digits, semi-transparent ink panel. Developer tool, exempt from the type rules. |

---

## 11. Motion

Motion answers the user's actions. The only unprompted motion is the boot reveal.

| Token | Duration | Easing | Use |
|---|---|---|---|
| `--motion-fast` | 120 ms | `ease-out` | Colour and opacity changes on hover. |
| `--motion-base` | 200 ms | `cubic-bezier(0.22, 1, 0.36, 1)` | Overlays fading in, tooltips. |
| `--motion-modal` | 220 ms in / 160 ms out | in `cubic-bezier(0.22, 1, 0.36, 1)`, out `cubic-bezier(0.4, 0, 1, 1)` | Modals: fade + scale 0.98 → 1. Backdrop fade 200 ms. |
| Book hover | 180 ms out / 220 ms back | critically damped spring (no overshoot) | Books are heavy: no bounce. |
| Book present | 450 ms | `easeInOutCubic` | Lift, turn, settle. |
| Page flip | 550 ms (queued flips 280 ms) | `easeInOutCubic` | Page curl. |
| Low → high page swap | 150 ms | linear cross-fade | Sharpening a settled page. |
| Book open / close | 700 ms | `easeInOutCubic` | Shelf → reader and back. |
| Camera flight | 0.6–1.5 s | `easeInOutCubic` on arc length | Search and Home. |
| Reader zoom | about 200 ms (time constant 70 ms) | exponential ease-out | The book coming closer under the wheel; a drag pans without easing. |
| Walking | accelerate 250 ms, stop 200 ms | linear velocity ramps | No sliding after key release. |
| Boot reveal | 1.2 s | `easeOutCubic` | Exposure rises from dark to the target while the star mark fades out. |

**Reduced motion** (`prefers-reduced-motion: reduce`): flights become 300 ms fade cuts; book
open/close and present become 200 ms cross-fades; page flips become a 150 ms slide; the boot
reveal becomes a 200 ms fade.

---

## 12. States

### 12.1 Loading

| Moment | Treatment |
|---|---|
| App boot | `--ink` screen with the eight-point star drawn as a line (stroke animation, 1.2 s loop) and "Opening the library…". Cross-fade to the hall only after the first frame is ready (no pop-in), then the boot reveal. |
| Import | In the drop zone: upload progress bar (`--lapis`), then "Reading the PDF…", then the cover preview with the page count. |
| Reader pages | Never a spinner. Low-resolution page first, sharp version cross-fades in. Nothing yet: paper-coloured page with faint line placeholders. |
| Shelf labels | Spines appear in colour first; titles fade in (200 ms) when their atlas is ready. |
| Covers | Paper-coloured card with the title set in type until the image loads. |

### 12.2 Empty

| Situation | English | Arabic |
|---|---|---|
| First launch, no categories (WelcomeCard title) | Welcome to Dar al Ilm | مرحبًا بك في دار العلم |
| WelcomeCard body | Create a category, then add your first book. | أنشئ تصنيفًا، ثم أضف كتابك الأول. |
| WelcomeCard action | Create your first category | أنشئ أول تصنيف |
| Suggestion chips | Programming · History · Novels · العربية | البرمجة · التاريخ · الروايات · العربية |
| Empty category (ghost slot label) | Add book | إضافة كتاب |
| Desk with no books | Books you open will appear here. | ستظهر هنا الكتب التي تفتحها. |
| Search, no results | No books match "{query}". | لا توجد كتب تطابق «{query}». |

(The chips are separate buttons; the middle dots above only separate them in this table.)

### 12.3 Errors

Errors say what happened and what to do. They never apologize and are never vague.

| Code / situation | English | Arabic |
|---|---|---|
| `not_pdf` | This file isn't a PDF. Choose a .pdf file. | هذا الملف ليس بصيغة PDF. اختر ملفًا بامتداد ‎.pdf‎. |
| `file_too_large` | This PDF is larger than 2 GB. | حجم ملف PDF هذا أكبر من 2 غيغابايت. |
| `pdf_encrypted` | This PDF is password-protected. Remove the password, then add it again. | ملف PDF هذا محمي بكلمة مرور. أزل كلمة المرور ثم أضفه من جديد. |
| `pdf_empty` | This PDF has no pages. | لا يحتوي ملف PDF هذا على أي صفحة. |
| `pdf_damaged` | This PDF is damaged and can't be opened. | ملف PDF هذا تالف ولا يمكن فتحه. |
| `invalid_cover` | Use a PNG, JPEG or WebP image under 10 MB. | استخدم صورة PNG أو JPEG أو WebP أصغر من 10 ميغابايت. |
| Duplicate | Already in your library: "{title}". | هذا الكتاب موجود في مكتبتك: «{title}». |
| Duplicate actions | Import anyway / Open existing | استيراد على أي حال / فتح الموجود |
| `category_name_taken` | A category with this name already exists. | يوجد تصنيف بهذا الاسم بالفعل. |
| `category_not_empty` | "{name}" has {count, plural}. Move them to another category to delete it. | يحتوي «{name}» على {count, plural}. انقلها إلى تصنيف آخر لحذفه. |
| `pdf_missing` | The PDF file for this book is missing from the library folder. | ملف PDF الخاص بهذا الكتاب مفقود من مجلد المكتبة. |
| Missing file action | Remove from library | إزالة من المكتبة |
| Page render failed | Page {n} couldn't be displayed. | تعذّر عرض الصفحة {n}. |
| API unreachable | The library service stopped. Run ./start.sh to restart it. | توقفت خدمة المكتبة. شغّل ‎./start.sh‎ لإعادة تشغيلها. |
| Retry action | Retry | إعادة المحاولة |
| Software rendering | Graphics acceleration is off, so 3D will be slow. | تسريع الرسوميات معطّل، لذا سيكون العرض ثلاثي الأبعاد بطيئًا. |
| No WebGL | This browser can't display 3D. Open Dar al Ilm in Chrome, Edge, Brave or Firefox with graphics acceleration on. | لا يستطيع هذا المتصفح عرض المحتوى ثلاثي الأبعاد. افتح دار العلم في Chrome أو Edge أو Brave أو Firefox مع تفعيل تسريع الرسوميات. |

Arabic plural forms for counts (via `Intl.PluralRules('ar')`):

| Form | Books | Pages |
|---|---|---|
| zero | لا كتب | لا صفحات |
| one | كتاب واحد | صفحة واحدة |
| two | كتابان | صفحتان |
| few (3–10) | {n} كتب | {n} صفحات |
| many (11–99) | {n} كتابًا | {n} صفحة |
| other (100+) | {n} كتاب | {n} صفحة |

---

## 13. Copy and Voice

- Plain, calm, specific. Sentence case. Active verbs that say exactly what happens.
- An action keeps its name through the flow: the **Add book** button produces the toast **Book
  added**; **Delete book** produces **Book deleted**.
- Arabic copy is written, not machine-translated: Modern Standard Arabic, natural word order,
  correct plurals, «guillemets» around quoted titles.

**Glossary (use these terms consistently):**

| English | Arabic |
|---|---|
| Library | المكتبة |
| Category | تصنيف |
| Book | كتاب |
| Shelf | رف |
| Currently reading | قيد القراءة |
| Add book / Book added | إضافة كتاب / أُضيف الكتاب |
| Edit / Save changes | تعديل / حفظ التغييرات |
| Delete book / Book deleted | حذف الكتاب / حُذف الكتاب |
| Open | فتح |
| Cancel | إلغاء |
| Search | بحث |
| Settings | الإعدادات |
| Title / Author / Notes | العنوان / المؤلف / ملاحظات |
| Cover / Custom cover | الغلاف / غلاف مخصّص |
| Reading direction | اتجاه القراءة |
| Left to right / Right to left | من اليسار إلى اليمين / من اليمين إلى اليسار |
| Page / Pages | صفحة / صفحات |
| Language | اللغة |
| Graphics: Auto / Performance / High | الرسوميات: تلقائي / الأداء / جودة عالية |
| Ambient light | الإضاءة المحيطة |

---

## 14. RTL Rules

- `<html dir="rtl" lang="ar">` mirrors every overlay through logical properties.
- Mirrored: layout order, the search pill's icon side, toolbars (previous/next arrows swap
  sides), chevrons, toast and banner stripes, key hint order.
- Not mirrored: the 3D scene, page images, numbers, the zoom percentage, media-style sliders'
  numeric readouts, Latin text runs inside Arabic sentences (bidi isolation with `<bdi>`).
- The Entrance Desk orders books 1st → 3rd from the UI's start side (left in English, right in
  Arabic).
- Exception: the reader's page navigation (previous, page slider, next) follows the open book's
  reading direction, not the UI language, so it matches the arrow keys and the page that turns
  (an RTL book has "previous" on the right in both languages).

---

## 15. Accessibility

- Visible focus: 2 px `--lapis` ring with 2 px offset on every interactive element.
- Full keyboard paths: walk, search, present, open, flip, zoom (`+`, `-`, `0`), close, and
  every modal.
- Screen-reader labels on icon buttons; modals trap focus and restore it on close.
- Text contrast ≥ 4.5:1 (see §7); never rely on colour alone (errors include text and icon).
- `prefers-reduced-motion` honoured (§11).

---

## 16. Don'ts

- No arabesque or star patterns outside the five places listed in principle 2.
- No gold-on-black or emerald-and-gold "Oriental" theming.
- No all-caps labels, no letter-spaced Arabic, no gradient washes, no glassmorphism stacks
  (one panel surface level only).
- No looping idle animation in the 3D scene; no spinners in the reader.
- No external fonts, icons, textures or HDRs from the network.
