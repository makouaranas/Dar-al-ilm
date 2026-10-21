"""PyMuPDF and Pillow helpers: PDF validation, page metadata, covers, page images and
spine colours.

docs/ARCHITECTURE.md sections 7 (limits), 8.1 (two-phase import) and 8.2 (page qualities).

PyMuPDF is not thread-safe, even across different documents. Every in-process use goes
through the high-level functions below, which hold `PYMUPDF_LOCK`. Reader pages are
rendered in worker processes (render_pool.py), each single-threaded.
"""

from __future__ import annotations

import hashlib
import io
import math
import os
import re
import tempfile
import threading
import unicodedata
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import pymupdf
from PIL import Image, ImageOps

from app.security import ApiError

PDF_MAGIC = b"%PDF-"
MAGIC_WINDOW = 1024  # the PDF header may follow up to 1024 bytes of junk
CHUNK_SIZE = 1024 * 1024

COVER_LONG_SIDE = 1024
COVER_WEBP_QUALITY = 82
MAX_COVER_BYTES = 10 * 1024 * 1024

MAX_RENDER_LONG_SIDE = 4096
MAX_RENDER_PIXELS = 16_800_000

PAPER_RGB = (0xF6, 0xF5, 0xF2)  # --paper, used behind transparent cover images

# Long side in pixels per page quality (section 8.2).
QUALITY_LONG_SIDE = {"low": 768, "high": 2048, "zoom": 4096}
PAGE_WEBP_QUALITY = 80

PYMUPDF_LOCK = threading.RLock()

_ARABIC_SCRIPT = re.compile(
    "[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]"
)
_MEANINGLESS_TITLES = {"untitled", "untitled document", "document", "title", "none", "unknown"}
_FILE_EXTENSION = re.compile(r"\.(pdf|docx?|odt|rtf|tex|indd|ps|pptx?|xlsx?|txt)$", re.IGNORECASE)


def file_too_large(max_bytes: int) -> ApiError:
    return ApiError(413, "file_too_large", f"The PDF is larger than {max_bytes // (1024 * 1024)} MB.")


@dataclass(frozen=True)
class PdfInfo:
    page_count: int
    page_width_pt: float
    page_height_pt: float
    metadata_title: str | None


@dataclass(frozen=True)
class StagedFile:
    size: int
    sha256: str


# --- Files --------------------------------------------------------------------------


def write_atomic(path: Path, data: bytes) -> None:
    """Write to a temporary file in the same folder, then rename over `path`."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def stage_pdf_stream(source: BinaryIO, dest: Path, max_bytes: int) -> StagedFile:
    """Copy an uploaded PDF to `dest` in 1 MB chunks, hashing and size-capping it.

    Raises `not_pdf` or `file_too_large`; `dest` is removed on any failure.
    """
    digest = hashlib.sha256()
    size = 0
    head = b""
    try:
        with dest.open("wb") as out:
            while chunk := source.read(CHUNK_SIZE):
                if len(head) < MAGIC_WINDOW:
                    head += chunk[: MAGIC_WINDOW - len(head)]
                size += len(chunk)
                if size > max_bytes:
                    raise file_too_large(max_bytes)
                digest.update(chunk)
                out.write(chunk)
        if PDF_MAGIC not in head:
            raise ApiError(415, "not_pdf", "The file is not a PDF.")
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return StagedFile(size=size, sha256=digest.hexdigest())


def display_filename(name: str | None) -> str:
    """The user's file name for display only (never used in a path)."""
    base = re.split(r"[\\/]", name or "")[-1]
    base = "".join(ch for ch in unicodedata.normalize("NFC", base) if unicodedata.category(ch)[0] != "C")
    return base.strip()[:255]


# --- PDF inspection and rendering ----------------------------------------------------


def open_pdf(path: Path) -> pymupdf.Document:
    """Open a PDF for reading; maps PyMuPDF failures to API errors."""
    try:
        doc = pymupdf.open(path, filetype="pdf")
    except Exception as exc:  # PyMuPDF raises FileDataError and other RuntimeErrors
        raise ApiError(422, "pdf_damaged", "The PDF is damaged and cannot be opened.") from exc
    if doc.needs_pass:
        doc.close()
        raise ApiError(422, "pdf_encrypted", "The PDF is password-protected.")
    if doc.page_count == 0:
        doc.close()
        raise ApiError(422, "pdf_empty", "The PDF has no pages.")
    return doc


def inspect_pdf(doc: pymupdf.Document) -> PdfInfo:
    rect = doc[0].rect  # visible page rectangle, rotation applied
    title = (doc.metadata or {}).get("title") or None
    return PdfInfo(
        page_count=doc.page_count,
        page_width_pt=round(float(rect.width), 2),
        page_height_pt=round(float(rect.height), 2),
        metadata_title=title,
    )


def render_page(doc: pymupdf.Document, page_number: int, long_side: int) -> Image.Image:
    """Render a 1-based page so its long side is `long_side` px (capped, section 7)."""
    page = doc[page_number - 1]
    rect = page.rect
    long_side = min(long_side, MAX_RENDER_LONG_SIDE)
    scale = long_side / max(rect.width, rect.height, 1.0)
    pixels = rect.width * scale * rect.height * scale
    if pixels > MAX_RENDER_PIXELS:
        scale *= math.sqrt(MAX_RENDER_PIXELS / pixels)
    try:
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
    except Exception as exc:
        raise ApiError(422, "pdf_damaged", "The PDF page cannot be rendered.") from exc
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def encode_webp(image: Image.Image, quality: int, method: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=quality, method=method)
    return buffer.getvalue()


def render_cover(doc: pymupdf.Document) -> tuple[bytes, Image.Image]:
    """Automatic Page 1 cover: long side 1024 px, WebP quality 82."""
    image = render_page(doc, 1, COVER_LONG_SIDE)
    return encode_webp(image, COVER_WEBP_QUALITY, method=4), image


def analyze_pdf(path: Path) -> tuple[PdfInfo, bytes]:
    """Validate a PDF and render its Page 1 cover (thread-safe)."""
    with PYMUPDF_LOCK:
        doc = open_pdf(path)
        try:
            return inspect_pdf(doc), render_cover(doc)[0]
        finally:
            doc.close()


def cover_from_pdf(path: Path) -> tuple[bytes, Image.Image]:
    """Automatic Page 1 cover of a stored PDF (thread-safe)."""
    with PYMUPDF_LOCK:
        doc = open_pdf(path)
        try:
            return render_cover(doc)
        finally:
            doc.close()


def render_page_webp(doc: pymupdf.Document, page_number: int, quality: str) -> bytes:
    """A reader page as WebP at the given quality (low, high or zoom)."""
    image = render_page(doc, page_number, QUALITY_LONG_SIDE[quality])
    return encode_webp(image, PAGE_WEBP_QUALITY, method=0)


# --- Custom covers -------------------------------------------------------------------


def _is_supported_image(data: bytes) -> bool:
    return (
        data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith(b"\xff\xd8\xff")
        or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")
    )


def load_custom_cover(data: bytes) -> tuple[bytes, Image.Image]:
    """Validate a PNG/JPEG/WebP cover (<= 10 MB) and re-encode it as WebP (long side <= 1024)."""
    invalid = ApiError(415, "invalid_cover", "Use a PNG, JPEG or WebP image under 10 MB.")
    if len(data) > MAX_COVER_BYTES or not _is_supported_image(data):
        raise invalid
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as opened:
                opened.load()
                image = ImageOps.exif_transpose(opened)
    except Exception as exc:  # truncated, corrupt, or decompression bomb
        raise invalid from exc

    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, PAPER_RGB)
        background.paste(rgba, mask=rgba.getchannel("A"))
        image = background
    else:
        image = image.convert("RGB")
    image.thumbnail((COVER_LONG_SIDE, COVER_LONG_SIDE), Image.Resampling.LANCZOS)
    return encode_webp(image, COVER_WEBP_QUALITY, method=4), image


# --- Metadata suggestions -------------------------------------------------------------


def spine_color(cover: Image.Image) -> str:
    """Dominant cover colour that is not near-white or near-black (section 8.1)."""
    small = cover.convert("RGB").resize((64, 64), Image.Resampling.BILINEAR)
    palette_image = small.quantize(colors=5, method=Image.Quantize.MEDIANCUT)
    palette = palette_image.getpalette() or []
    counts = sorted(palette_image.getcolors() or [], reverse=True)
    colors = [tuple(palette[index * 3 : index * 3 + 3]) for _count, index in counts]
    if not colors:
        return "#808080"

    def usable(rgb: tuple[int, ...]) -> bool:
        return not (min(rgb) > 225 or max(rgb) < 30)

    chosen = next((rgb for rgb in colors if usable(rgb)), colors[0])
    return "#{:02X}{:02X}{:02X}".format(*chosen)


def contains_arabic(text: str) -> bool:
    return bool(_ARABIC_SCRIPT.search(text))


def _clean_title(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    return re.sub(r"\s+", " ", text).strip()


def _meaningful(title: str) -> bool:
    if len(title) < 2 or title.casefold() in _MEANINGLESS_TITLES:
        return False
    if _FILE_EXTENSION.search(title):
        return False
    return any(ch.isalpha() for ch in title)


def suggest_title(metadata_title: str | None, original_filename: str) -> str:
    """PDF metadata title when meaningful, else the file name stem with _ and - as spaces."""
    if metadata_title:
        cleaned = _clean_title(metadata_title)
        if _meaningful(cleaned):
            return cleaned[:300]
    stem = re.sub(r"\.pdf$", "", original_filename, flags=re.IGNORECASE)
    stem = _clean_title(re.sub(r"[_\-]+", " ", stem))
    return (stem or "Untitled")[:300]
