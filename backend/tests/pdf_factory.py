"""Generates PDF and image fixtures at test time. No copyrighted files are committed."""

from __future__ import annotations

import io
import random
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFilter

A4 = (595.0, 842.0)
A5 = (420.0, 595.0)


def text_pdf(
    path: Path,
    pages: int = 3,
    *,
    title: str | None = None,
    page_size: tuple[float, float] = A4,
    body: str = "Dar al Ilm test page",
    rotate: int = 0,
) -> Path:
    """A small text PDF (Latin text, French accents supported by the base-14 font)."""
    doc = pymupdf.open()
    for number in range(1, pages + 1):
        page = doc.new_page(width=page_size[0], height=page_size[1])
        page.insert_text((56, 72), f"{body} - {number}", fontsize=14)
        page.draw_rect(pymupdf.Rect(40, 40, page_size[0] - 40, 120), color=(0.6, 0.1, 0.1), fill=(0.6, 0.1, 0.1))
        if rotate:
            page.set_rotation(rotate)
    if title is not None:
        doc.set_metadata({"title": title})
    doc.save(path)
    doc.close()
    return path


def _scan_image(seed: int, size: tuple[int, int] = (2480, 3508)) -> bytes:
    """A4 at 300 DPI: grey text-like lines with blur and noise, JPEG like a real scan."""
    rng = random.Random(seed)
    image = Image.new("L", size, 235)
    draw = ImageDraw.Draw(image)
    y = 250
    while y < size[1] - 200:
        x = 200
        while x < size[0] - 230:
            width = rng.randint(30, 160)
            draw.rectangle([x, y, x + width, y + 34], fill=rng.randint(20, 70))
            x += width + rng.randint(18, 30)
        y += 62
    image = image.filter(ImageFilter.GaussianBlur(1.2))
    image = Image.blend(image, Image.effect_noise(size, 18), 0.08)
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=70)
    return buffer.getvalue()


def scanned_pdf(path: Path, pages: int = 400, *, distinct_scans: int = 4) -> Path:
    """Image-only PDF: every page is a full-page 300 DPI JPEG scan (no text layer)."""
    scans = [_scan_image(seed) for seed in range(distinct_scans)]
    doc = pymupdf.open()
    for number in range(pages):
        page = doc.new_page(width=A4[0], height=A4[1])
        page.insert_image(page.rect, stream=scans[number % distinct_scans])
    doc.save(path, garbage=3, deflate=True)
    doc.close()
    return path


def encrypted_pdf(path: Path) -> Path:
    """Needs a user password to open."""
    source = pymupdf.open(text_pdf(path.with_suffix(".plain.pdf"), pages=1))
    source.save(path, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    source.close()
    path.with_suffix(".plain.pdf").unlink()
    return path


def zero_page_pdf(path: Path) -> Path:
    """Structurally valid PDF whose page tree is empty (PyMuPDF cannot save one)."""
    path.write_bytes(
        b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF\n"
    )
    return path


def damaged_pdf(path: Path) -> Path:
    """Starts with a PDF header but has no recoverable structure.

    (A merely truncated PDF is not enough: MuPDF repairs those and opens them.)
    """
    path.write_bytes(b"%PDF-1.7\n" + bytes(range(256)) * 40)
    return path


def padded_pdf(path: Path, min_bytes: int) -> Path:
    """A valid PDF made larger with trailing bytes after %%EOF."""
    data = text_pdf(path, pages=1).read_bytes()
    if len(data) < min_bytes:
        data += b"\n%" + b"x" * (min_bytes - len(data))
    path.write_bytes(data)
    return path


def image_bytes(fmt: str = "PNG", size: tuple[int, int] = (600, 900), color=(200, 30, 30)) -> bytes:
    mode = "RGBA" if fmt == "PNG" else "RGB"
    fill = (*color, 255) if mode == "RGBA" else color
    buffer = io.BytesIO()
    Image.new(mode, size, fill).save(buffer, fmt)
    return buffer.getvalue()
