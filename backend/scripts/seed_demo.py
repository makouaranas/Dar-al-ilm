"""Seed a demo library: 4 categories and 40 generated books in English, French and Arabic.

Usage (from backend/):
    .venv/bin/python scripts/seed_demo.py --data-dir /tmp/dar-demo [--force]

Books are generated PDFs (no copyrighted content): a cover page in the book's colour, a
title page and body pages with filler text in the book's language. Some books are
image-only "scans". Page counts and page sizes vary so spines differ on the shelves.
Books are imported through the real API (two-phase upload), and 3 of them are opened so
the Currently Reading desk is filled.

The script refuses to add demo books to a library that already has categories or books,
unless --force is given. It never deletes anything.
"""

from __future__ import annotations

import argparse
import io
import random
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import pymupdf  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageFilter  # noqa: E402

from app.config import load_config  # noqa: E402
from app.main import create_app  # noqa: E402

A4 = (595, 842)
A5 = (420, 595)
LETTER = (612, 792)
POCKET = (306, 495)
ROYAL = (432, 648)

UNIQUE_BODY_PAGES = 6


@dataclass(frozen=True)
class DemoBook:
    title: str
    author: str | None
    pages: int
    size: tuple[int, int]
    color: str
    scanned: bool = False


CATEGORIES: dict[str, tuple[str, list[DemoBook]]] = {
    "Programming": (
        "en",
        [
            DemoBook("Structure and Interpretation of Computer Programs", "Abelson & Sussman", 657, LETTER, "#7A2E8C"),
            DemoBook("Introduction to Algorithms", "Cormen, Leiserson, Rivest & Stein", 1312, LETTER, "#1F4E79"),
            DemoBook("Clean Code", "Robert C. Martin", 464, ROYAL, "#2E6B3A"),
            DemoBook("The Pragmatic Programmer", "Hunt & Thomas", 352, ROYAL, "#1E2230"),
            DemoBook("Designing Data-Intensive Applications", "Martin Kleppmann", 616, ROYAL, "#B5532E"),
            DemoBook("Eloquent JavaScript", "Marijn Haverbeke", 472, ROYAL, "#C9A227"),
            DemoBook("Fluent Python", "Luciano Ramalho", 1012, ROYAL, "#3B5F8A"),
            DemoBook("Computer Networking", "Kurose & Ross", 852, LETTER, "#8C1C13"),
            DemoBook("Operating Systems: Three Easy Pieces", "Arpaci-Dusseau", 714, LETTER, "#4A6C2F"),
            DemoBook("Python Crash Course", "Eric Matthes", 544, ROYAL, "#D9A441"),
        ],
    ),
    "Histoire": (
        "fr",
        [
            DemoBook("Histoire de France", "Jules Michelet", 520, A5, "#6B2D2D"),
            DemoBook("La Méditerranée et le monde méditerranéen", "Fernand Braudel", 1160, ROYAL, "#2F5D7C", scanned=True),
            DemoBook("Mémoires d'outre-tombe", "François-René de Chateaubriand", 980, A5, "#3E2F5B"),
            DemoBook("De la démocratie en Amérique", "Alexis de Tocqueville", 870, A5, "#22543D"),
            DemoBook("L'Ancien Régime et la Révolution", "Alexis de Tocqueville", 380, POCKET, "#7B341E"),
            DemoBook("Histoire de la Révolution française", "Jules Michelet", 744, A5, "#9B2C2C"),
            DemoBook("Histoire des Berbères", "Ibn Khaldoun (trad. de Slane)", 620, A4, "#5F4B32", scanned=True),
            DemoBook("Les Rois maudits", "Maurice Druon", 410, POCKET, "#2C3E50"),
            DemoBook("Le Siècle de Louis XIV", "Voltaire", 560, A5, "#7D5A1E"),
            DemoBook("Histoire de l'Afrique du Nord", "Charles-André Julien", 690, A5, "#486581"),
        ],
    ),
    "Novels": (
        "mixed",
        [
            DemoBook("Les Misérables", "Victor Hugo", 1488, A5, "#1A365D"),
            DemoBook("Le Petit Prince", "Antoine de Saint-Exupéry", 96, POCKET, "#2B6CB0"),
            DemoBook("Pride and Prejudice", "Jane Austen", 432, POCKET, "#97266D"),
            DemoBook("Moby-Dick", "Herman Melville", 720, A5, "#234E52"),
            DemoBook("L'Étranger", "Albert Camus", 184, POCKET, "#C05621"),
            DemoBook("Don Quixote", "Miguel de Cervantes", 1072, A5, "#744210"),
            DemoBook("Frankenstein", "Mary Shelley", 280, POCKET, "#1C4532"),
            DemoBook("Le Comte de Monte-Cristo", "Alexandre Dumas", 1276, A5, "#702459"),
            DemoBook("Jane Eyre", "Charlotte Brontë", 532, POCKET, "#4A5568"),
            DemoBook("Candide", "Voltaire", 144, POCKET, "#B7791F"),
        ],
    ),
    "العربية": (
        "ar",
        [
            DemoBook("مقدمة ابن خلدون", "ابن خلدون", 642, A5, "#7B341E"),
            DemoBook("كليلة ودمنة", "ابن المقفع", 312, A5, "#2C7A7B"),
            DemoBook("ألف ليلة وليلة", None, 980, ROYAL, "#553C9A"),
            DemoBook("الأيام", "طه حسين", 228, POCKET, "#9C4221"),
            DemoBook("رسالة الغفران", "أبو العلاء المعري", 304, A5, "#285E61"),
            DemoBook("البيان والتبيين", "الجاحظ", 860, A4, "#5F370E", scanned=True),
            DemoBook("طوق الحمامة", "ابن حزم", 196, POCKET, "#97266D"),
            DemoBook("المقامات", "بديع الزمان الهمذاني", 268, A5, "#2A4365"),
            DemoBook("رحلة ابن بطوطة", "ابن بطوطة", 720, ROYAL, "#22543D"),
            DemoBook("الأغاني", "أبو الفرج الأصفهاني", 1400, A4, "#742A2A", scanned=True),
        ],
    ),
}

FILLER = {
    "en": (
        "The reader turns the page and the argument continues, patient and exact. "
        "Each chapter builds on the last, and the margins invite notes. "
    ),
    "fr": (
        "Le lecteur tourne la page et le récit se poursuit, patient et précis. "
        "Chaque chapitre prolonge le précédent, et les marges invitent aux notes. "
    ),
    "ar": (
        "يقلّب القارئ الصفحة فيمضي الحديث هادئًا دقيقًا، "
        "ويبني كل فصل على ما قبله، وتدعو الهوامش إلى التدوين. "
    ),
}
CHAPTER = {"en": "Chapter", "fr": "Chapitre", "ar": "الفصل"}


def _language(category_language: str, book: DemoBook) -> str:
    if category_language != "mixed":
        return category_language
    return "fr" if any(ch in book.title for ch in "éèàçÉ'") or book.title.startswith(("Le ", "Les ", "L'")) else "en"


def _html_page(title: str, body: str, language: str) -> str:
    direction = "rtl" if language == "ar" else "ltr"
    align = "right" if language == "ar" else "left"
    return (
        f'<div style="direction:{direction}; text-align:{align}">'
        f'<h2 style="font-size:18px">{title}</h2>'
        f'<p style="font-size:11px; line-height:1.6">{body}</p></div>'
    )


def _build_pdf(book: DemoBook, language: str, path: Path) -> None:
    width, height = book.size
    rgb = tuple(int(book.color[i : i + 2], 16) / 255 for i in (1, 3, 5))
    margin = width * 0.1
    doc = pymupdf.open()

    cover = doc.new_page(width=width, height=height)
    cover.draw_rect(cover.rect, color=rgb, fill=rgb)
    cover.draw_rect(pymupdf.Rect(margin, height * 0.3, width - margin, height * 0.3 + 2), color=(0.85, 0.72, 0.48), fill=(0.85, 0.72, 0.48))
    direction = "rtl" if language == "ar" else "ltr"
    cover.insert_htmlbox(
        pymupdf.Rect(margin, height * 0.33, width - margin, height * 0.8),
        f'<div style="direction:{direction}; text-align:center; color:#F6F5F2">'
        f'<p style="font-size:{max(16, int(width / 16))}px; font-weight:bold">{book.title}</p>'
        f'<p style="font-size:{max(10, int(width / 32))}px">{book.author or ""}</p></div>',
    )

    for number in range(1, UNIQUE_BODY_PAGES + 1):
        page = doc.new_page(width=width, height=height)
        page.insert_htmlbox(
            pymupdf.Rect(margin, margin, width - margin, height - margin),
            _html_page(f"{CHAPTER[language]} {number}", FILLER[language] * 14, language),
        )

    # Fill the remaining pages by copying the body pages (fast, keeps files small).
    while doc.page_count < book.pages:
        doc.fullcopy_page(1 + (doc.page_count - 1) % UNIQUE_BODY_PAGES)
    for index in range(1, doc.page_count):
        doc[index].insert_text((width / 2 - 6, height - margin / 2), str(index + 1), fontsize=8)

    if book.scanned:
        doc = _as_scan(doc)
    doc.set_metadata({"title": book.title, "author": book.author or ""})
    doc.save(path, garbage=3, deflate=True)
    doc.close()


def _as_scan(doc: pymupdf.Document) -> pymupdf.Document:
    """Replace every page with a slightly skewed, tinted, noisy JPEG image (no text layer)."""
    rng = random.Random(doc.page_count)
    scanned = pymupdf.open()
    images: list[bytes] = []
    for index in range(min(UNIQUE_BODY_PAGES + 1, doc.page_count)):
        pix = doc[index].get_pixmap(dpi=150)
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        image = image.rotate(rng.uniform(-0.6, 0.6), expand=False, fillcolor=(242, 236, 222))
        tint = Image.new("RGB", image.size, (242, 232, 205))
        image = Image.blend(image, tint, 0.12).filter(ImageFilter.GaussianBlur(0.4))
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=72)
        images.append(buffer.getvalue())
    for index in range(doc.page_count):
        page = scanned.new_page(width=doc[0].rect.width, height=doc[0].rect.height)
        source = 0 if index == 0 else 1 + (index - 1) % (len(images) - 1)
        page.insert_image(page.rect, stream=images[source])
    doc.close()
    return scanned


def _library_is_empty(client: TestClient) -> bool:
    data = client.get("/api/bootstrap").json()
    return not data["categories"] and not data["books"]


def seed(data_dir: Path, force: bool) -> int:
    config = load_config({"DAR_DATA_DIR": str(data_dir), "DAR_RENDER_WORKERS": "0"})
    started = time.perf_counter()
    with (
        TestClient(create_app(config), base_url="http://127.0.0.1:8000", headers={"X-Dar-Client": "1"}) as client,
        tempfile.TemporaryDirectory(prefix="dar-seed-") as tmp,
    ):
        if not _library_is_empty(client) and not force:
            print(f"Library at {data_dir} is not empty; use --force to add demo books anyway.", file=sys.stderr)
            return 1

        book_ids: list[int] = []
        for name, (category_language, books) in CATEGORIES.items():
            response = client.post("/api/categories", json={"name": name})
            if response.status_code == 409:
                category = next(c for c in client.get("/api/bootstrap").json()["categories"] if c["name"] == name)
            else:
                response.raise_for_status()
                category = response.json()
            for book in books:
                language = _language(category_language, book)
                pdf_path = Path(tmp) / f"{len(book_ids)}.pdf"
                _build_pdf(book, language, pdf_path)
                with pdf_path.open("rb") as handle:
                    upload = client.post("/api/uploads", files={"pdf_file": (pdf_path.name, handle, "application/pdf")})
                upload.raise_for_status()
                created = client.post(
                    "/api/books",
                    data={
                        "upload_id": upload.json()["upload_id"],
                        "title": book.title,
                        "category_id": str(category["id"]),
                        "reading_direction": "RTL" if language == "ar" else "LTR",
                        **({"author": book.author} if book.author else {}),
                    },
                )
                created.raise_for_status()
                book_ids.append(created.json()["id"])
                print(f"  {created.json()['id']:>3}  {name:<12} {book.pages:>5} p.  {book.title}")

        # Open 3 books so the Currently Reading desk is filled (the last opened is 1st).
        for book_id, page in ((book_ids[30], 57), (book_ids[0], 120), (book_ids[11], 9)):
            client.patch(f"/api/books/{book_id}", json={"mark_opened": True, "last_read_page": page}).raise_for_status()

    print(f"Seeded {len(book_ids)} books into {data_dir} in {time.perf_counter() - started:.1f} s")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", type=Path, required=True, help="library folder to seed")
    parser.add_argument("--force", action="store_true", help="add demo books to a non-empty library")
    args = parser.parse_args()
    return seed(args.data_dir.expanduser().resolve(), args.force)


if __name__ == "__main__":
    raise SystemExit(main())
