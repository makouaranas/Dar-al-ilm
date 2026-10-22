// Page, cover and spine images for the book-opening look-development (book_open.py).
// Pages: typeset Arabic (Amiri) on cream paper, 1448 x 2048. Cover and spine: white masks on
// transparent for the gilt foil. The text is original prose written for this render.
// Usage: node book_pages.mjs <out dir> <amiri font dir>
import { writeFileSync } from "node:fs";
import { assertFontsLoaded, fontFace } from "./fonts.mjs";
const { chromium } = await import(new URL("../../frontend/node_modules/@playwright/test/index.mjs", import.meta.url));
const [OUT, AMIRI] = process.argv.slice(2);

const P = {
  intro: `القراءةُ بابٌ واسعٌ إلى المعرفة، يدخله الإنسانُ فيجد فيه عقولَ من سبقوه حاضرةً بين يديه، كأنها تحادثه وتجيب عن أسئلته. وما الكتابُ إلا صديقٌ أمين، لا يملّ من صحبتك، ولا يبخل عليك بما عنده، ويصبر عليك إذا غفلت عنه، ثم يستقبلك إذا عدت إليه كأنك لم تغب.`,
  libraries: `وقد عرفت الحضاراتُ الكبرى قيمةَ الكتاب، فأقامت له الدورَ والخزائن، وجمعت فيه ما تفرّق من العلوم، ورتّبته على أبوابه حتى يسهل على الطالب أن يصل إلى حاجته. وكانت المكتباتُ ملتقى العلماء، يقصدها الناسُ من البلاد البعيدة، فيقيمون فيها الأيامَ والليالي، يقرؤون وينسخون ويتناظرون.`,
  reader: `والقارئ الحقّ لا يكتفي بأن يمرّ على السطور، بل يقف عند المعنى، ويسأل عن الدليل، ويقارن بين الأقوال، ثم يأخذ منها ما صحّ عنده. فإذا فرغ من كتابه دوّن ما استفاد، وعاد إليه بعد حين، فيرى فيه ما لم يره أول مرة.`,
  time: `ومن آداب القراءة أن يختار القارئُ وقتاً يصفو فيه ذهنُه، ومكاناً هادئاً يعينه على التأمّل، وأن يجعل لكلّ كتابٍ حقَّه من العناية، فلا يطوي صفحاته ولا يثقل عليه بما يفسده. فإنّ الكتاب أمانةٌ تنتقل من يدٍ إلى يد، ومن جيلٍ إلى جيل.`,
  order: `ومنها أن يبدأ بالأصول قبل الفروع، وبالمختصرات قبل المطوّلات، حتى تستقيم له قواعدُ العلم، ثم يتوسّع بعد ذلك على بصيرة. ومنها أن يصحب قلماً يقيّد به الفوائد، فإنّ العلمَ صيدٌ والكتابةَ قيده.`,
  doubt: `وإذا أشكل عليه شيءٌ لم يتعجّل الحكم، بل رجع إلى أهل الاختصاص، أو قرأ في الموضوع من كتابٍ آخر، فإنّ الكتبَ يفسّر بعضُها بعضاً، ويكمّل بعضُها ما نقص من بعض.`,
};
const TITLE = "في آداب القراءة";
const CHAPTER = "الباب الأول: في فضل القراءة";

const css = `
${fontFace("Amiri", `${AMIRI}/amiri-arabic-400-normal.woff2`, 400)}
${fontFace("Amiri", `${AMIRI}/amiri-arabic-700-normal.woff2`, 700)}
html, body { margin: 0; }
* { box-sizing: border-box; }
.page { width: 1448px; height: 2048px; background: #f3ecdc; color: #241d16; font-family: Amiri; direction: rtl;
  padding: 170px 150px 150px; position: relative; }
.head { position: absolute; top: 80px; left: 150px; right: 150px; text-align: center; font-size: 34px; color: #6b5d4c;
  border-bottom: 1.5px solid #b9a98e; padding-bottom: 14px; }
.body { font-size: 50px; line-height: 1.92; text-align: justify; }
.body p { margin: 0 0 22px; text-indent: 60px; }
.chapter { text-align: center; font-weight: 700; font-size: 70px; margin: 60px 0 24px; }
.rule { width: 220px; height: 2px; background: #8a6a3a; margin: 0 auto 60px; }
.num { position: absolute; bottom: 70px; left: 0; right: 0; text-align: center; font-size: 40px; color: #4a3d30; }
`;
const page = (head, body, num, chapter = false) => `
<div class="page">
  <div class="head">${head}</div>
  ${chapter ? `<div class="chapter">${CHAPTER}</div><div class="rule"></div>` : ""}
  <div class="body">${body.map((p) => `<p>${p}</p>`).join("")}</div>
  <div class="num">${num}</div>
</div>`;

const PAGES = {
  "page-chapter": page(TITLE, [P.intro, P.libraries, P.reader], "١٢", true),
  "page-cont": page(CHAPTER, [P.time, P.order, P.doubt, P.intro], "١٣"),
  "page-a": page(TITLE, [P.libraries, P.reader, P.time], "٨"),
  "page-b": page(CHAPTER, [P.order, P.doubt, P.intro], "٩"),
  "page-c": page(TITLE, [P.reader, P.time, P.order], "١٠"),
  "page-d": page(CHAPTER, [P.doubt, P.libraries, P.reader], "١١"),
};

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const tab = await browser.newPage({ deviceScaleFactor: 1 });
async function shoot(width, height, body, file, transparent = false) {
  await tab.setViewportSize({ width, height });
  await tab.setContent(`<html><head><style>${css}</style></head><body>${body}</body></html>`);
  await assertFontsLoaded(tab);
  await tab.screenshot({ path: `${OUT}/${file}.png`, omitBackground: transparent });
}
for (const [name, html] of Object.entries(PAGES)) await shoot(1448, 2048, html, name);

// Endpaper: warm paper with a faint laid texture (horizontal chain lines).
await shoot(1448, 2048, `<div style="width:1448px;height:2048px;background:#e9dcc0;
  background-image:repeating-linear-gradient(0deg, rgba(120,90,50,.05) 0 2px, transparent 2px 9px),
  repeating-linear-gradient(90deg, rgba(120,90,50,.06) 0 3px, transparent 3px 180px)"></div>`, "endpaper");

// Cover foil mask: double frame, title, a rule, the house name.
await shoot(1448, 2048, `
  <div style="position:absolute;inset:70px;border:10px solid white"></div>
  <div style="position:absolute;inset:100px;border:3px solid white"></div>
  <div style="position:absolute;inset:100px;display:flex;flex-direction:column;align-items:center;justify-content:center;
    color:white;font-family:Amiri;direction:rtl;text-align:center">
    <div style="font-weight:700;font-size:150px;line-height:1.5">${TITLE}</div>
    <div style="width:260px;height:6px;background:white;margin:70px 0 60px"></div>
    <div style="font-size:64px">رسالةٌ في صحبة الكتاب</div>
  </div>
  <div style="position:absolute;bottom:190px;left:0;right:0;text-align:center;color:white;font-family:Amiri;font-size:60px;font-weight:700">دار العلم</div>`,
  "cover-mask", true);

// Spine foil mask (2048 x 300, text along the spine) with bands near head and tail.
await shoot(2048, 300, `
  <div style="position:absolute;top:0;bottom:0;left:150px;width:10px;background:white"></div>
  <div style="position:absolute;top:0;bottom:0;left:178px;width:4px;background:white"></div>
  <div style="position:absolute;top:0;bottom:0;right:150px;width:10px;background:white"></div>
  <div style="position:absolute;top:0;bottom:0;right:178px;width:4px;background:white"></div>
  <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:white;font-family:Amiri;
    font-weight:700;font-size:120px;direction:rtl">${TITLE}</div>`, "spine-mask", true);

await browser.close();
writeFileSync(`${OUT}/book-pages.ok`, "ok\n");
console.log("ok");
