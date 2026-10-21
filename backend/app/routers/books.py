"""Books: phase 2 of the import and covers (docs/ARCHITECTURE.md sections 6.3 and 8.1)."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse
from PIL import Image
from sqlmodel import Session

from app.database import immediate_session
from app.models import Book, Category, utc_now
from app.pdf_service import (
    MAX_COVER_BYTES,
    load_custom_cover,
    open_pdf,
    render_cover,
    spine_color,
    write_atomic,
)
from app.routers.uploads import load_staged
from app.schemas import BookOut, ReadingDirection, book_out
from app.security import ApiError
from app.shelving import allocate_slot

router = APIRouter(prefix="/books", tags=["books"])

IMMUTABLE = "private, max-age=31536000, immutable"
_TEXT_LIMITS = {"title": 300, "author": 200, "notes": 5000}


def book_not_found(book_id: int) -> ApiError:
    return ApiError(404, "book_not_found", f"Book {book_id} does not exist.")


def pdf_rel_path(book_id: int) -> str:
    return PurePosixPath("pdfs", f"book_{book_id}.pdf").as_posix()


def cover_rel_path(book_id: int) -> str:
    return PurePosixPath("covers", f"book_{book_id}.webp").as_posix()


def _invalid(field: str, message: str, value: Any) -> RequestValidationError:
    return RequestValidationError(
        [{"type": "value_error", "loc": ("body", field), "msg": message, "input": value}]
    )


def _clean_text(field: str, value: str | None, *, required: bool) -> str | None:
    """Trim; empty optional text becomes null; enforce the column length limits."""
    cleaned = (value or "").strip()
    if not cleaned:
        if required:
            raise _invalid(field, f"{field} is required", value)
        return None
    if len(cleaned) > _TEXT_LIMITS[field]:
        raise _invalid(field, f"{field} must be at most {_TEXT_LIMITS[field]} characters", value)
    return cleaned


def _read_cover(upload: UploadFile | None) -> bytes | None:
    """Bytes of an optional custom cover; an empty file input counts as no cover."""
    if upload is None or (not upload.filename and not upload.size):
        return None
    return upload.file.read(MAX_COVER_BYTES + 1)


@router.post("", status_code=201, response_model=BookOut)
def create_book(
    request: Request,
    upload_id: Annotated[str, Form()],
    title: Annotated[str, Form()],
    category_id: Annotated[int, Form()],
    reading_direction: Annotated[ReadingDirection, Form()],
    author: Annotated[str | None, Form()] = None,
    notes: Annotated[str | None, Form()] = None,
    cover_file: Annotated[UploadFile | None, File()] = None,
) -> BookOut:
    data_dir: Path = request.app.state.config.data_dir
    clean_title = _clean_text("title", title, required=True)
    clean_author = _clean_text("author", author, required=False)
    clean_notes = _clean_text("notes", notes, required=False)

    staged, meta = load_staged(data_dir, upload_id)

    # Prepare the cover before touching the database, so an invalid cover changes nothing.
    custom = _read_cover(cover_file)
    if custom is not None:
        cover_bytes, cover_image = load_custom_cover(custom)
    else:
        cover_bytes = staged.cover.read_bytes()
        with Image.open(staged.cover) as preview:
            cover_image = preview.convert("RGB")
    color = spine_color(cover_image)

    moved_pdf: Path | None = None
    written_cover: Path | None = None
    try:
        with immediate_session(request.app.state.engine) as session:
            if session.get(Category, category_id) is None:
                raise ApiError(404, "category_not_found", f"Category {category_id} does not exist.")
            shelf, slot = allocate_slot(session, category_id)
            now = utc_now()
            book = Book(
                title=clean_title,
                category_id=category_id,
                reading_direction=reading_direction,
                author=clean_author,
                notes=clean_notes,
                pdf_rel_path="pending",
                cover_rel_path="pending",
                cover_is_custom=custom is not None,
                page_count=meta["page_count"],
                page_width_pt=meta["page_width_pt"],
                page_height_pt=meta["page_height_pt"],
                spine_color=color,
                file_sha256=meta["file_sha256"],
                file_size_bytes=meta["file_size_bytes"],
                shelf_number=shelf,
                slot_index=slot,
                created_at=now,
                updated_at=now,
            )
            session.add(book)
            session.flush()  # assigns book.id
            assert book.id is not None
            book.pdf_rel_path = pdf_rel_path(book.id)
            book.cover_rel_path = cover_rel_path(book.id)
            session.add(book)
            session.flush()

            written_cover = data_dir / book.cover_rel_path
            write_atomic(written_cover, cover_bytes)
            os.replace(staged.pdf, data_dir / book.pdf_rel_path)
            moved_pdf = data_dir / book.pdf_rel_path
            result = book_out(book, data_dir)
    except BaseException:
        # The transaction rolled back: put the PDF back so the upload can be retried.
        if moved_pdf is not None and moved_pdf.exists():
            os.replace(moved_pdf, staged.pdf)
        if written_cover is not None:
            written_cover.unlink(missing_ok=True)
        raise

    staged.remove()
    return result


@router.get("/{book_id}/cover")
def get_book_cover(book_id: int, request: Request) -> FileResponse:
    data_dir: Path = request.app.state.config.data_dir
    with Session(request.app.state.engine) as session:
        book = session.get(Book, book_id)
    if book is None:
        raise book_not_found(book_id)

    path = data_dir / book.cover_rel_path
    if not path.is_file():
        # Self-repair a cover removed by hand: regenerate the Page 1 snapshot.
        pdf = data_dir / book.pdf_rel_path
        if not pdf.is_file():
            raise ApiError(410, "pdf_missing", "The PDF file for this book is missing.")
        doc = open_pdf(pdf)
        try:
            cover_bytes, _image = render_cover(doc)
        finally:
            doc.close()
        write_atomic(path, cover_bytes)

    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})
