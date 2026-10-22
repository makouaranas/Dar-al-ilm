"""Books: import (phase 2), edit, delete, covers and page images.

docs/ARCHITECTURE.md sections 6.3, 8.1 (import), 8.2–8.4 (page images and cache).
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse
from PIL import Image
from sqlalchemy import func
from sqlmodel import Session, select

from app.cache import PageCache
from app.database import immediate_session
from app.models import Book, Category, utc_now
from app.pdf_service import (
    MAX_COVER_BYTES,
    cover_from_pdf,
    load_custom_cover,
    spine_color,
    write_atomic,
)
from app.render_pool import RenderJob, RenderPool
from app.routers.uploads import load_staged
from app.schemas import BookOut, BookPatch, ReadingDirection, book_out
from app.security import ApiError
from app.shelving import allocate_slot

router = APIRouter(prefix="/books", tags=["books"])

IMMUTABLE = "private, max-age=31536000, immutable"
_TEXT_LIMITS = {"title": 300, "author": 200, "notes": 5000}
_ONE_SECOND = timedelta(seconds=1)

Quality = Literal["low", "high", "zoom"]


def book_not_found(book_id: int) -> ApiError:
    return ApiError(404, "book_not_found", f"Book {book_id} does not exist.")


def pdf_missing() -> ApiError:
    return ApiError(410, "pdf_missing", "The PDF file for this book is missing.")


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


def _after(previous: datetime | None) -> datetime:
    """Now, but strictly later than `previous`, so cover URLs and desk order always change."""
    now = utc_now()
    return now if previous is None or now > previous else previous + _ONE_SECOND


def _get_book(session: Session, book_id: int) -> Book:
    book = session.get(Book, book_id)
    if book is None:
        raise book_not_found(book_id)
    return book


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


@router.patch("/{book_id}", response_model=BookOut)
def update_book(book_id: int, body: BookPatch, request: Request) -> BookOut:
    data_dir: Path = request.app.state.config.data_dir
    fields = body.model_fields_set
    with immediate_session(request.app.state.engine) as session:
        book = _get_book(session, book_id)
        metadata_changed = False

        if "title" in fields:
            book.title = _clean_text("title", body.title, required=True) or book.title
            metadata_changed = True
        if "author" in fields:
            book.author = _clean_text("author", body.author, required=False)
            metadata_changed = True
        if "notes" in fields:
            book.notes = _clean_text("notes", body.notes, required=False)
            metadata_changed = True
        if "reading_direction" in fields and body.reading_direction is not None:
            book.reading_direction = body.reading_direction
            metadata_changed = True
        if "category_id" in fields and body.category_id != book.category_id:
            assert body.category_id is not None
            if session.get(Category, body.category_id) is None:
                raise ApiError(
                    404, "category_not_found", f"Category {body.category_id} does not exist."
                )
            # The old slot frees up; the book takes the first free slot of its new category.
            book.shelf_number, book.slot_index = allocate_slot(session, body.category_id)
            book.category_id = body.category_id
            metadata_changed = True
        if "last_read_page" in fields and body.last_read_page is not None:
            if body.last_read_page > book.page_count:
                raise _invalid(
                    "last_read_page",
                    f"last_read_page must be between 1 and {book.page_count}",
                    body.last_read_page,
                )
            book.last_read_page = body.last_read_page
        if body.mark_opened:
            latest = session.exec(select(func.max(Book.last_opened_at))).one()
            book.last_opened_at = _after(latest)

        if metadata_changed:
            book.updated_at = _after(book.updated_at)
        session.add(book)
        session.flush()
        result = book_out(book, data_dir)
    return result


@router.delete("/{book_id}", status_code=204)
def delete_book(book_id: int, request: Request) -> Response:
    data_dir: Path = request.app.state.config.data_dir
    with immediate_session(request.app.state.engine) as session:
        book = _get_book(session, book_id)
        files = [data_dir / book.pdf_rel_path, data_dir / book.cover_rel_path]
        session.delete(book)
    # Files go after the commit; anything left by a crash is removed at the next startup.
    pool: RenderPool = request.app.state.render_pool
    pool.cancel_book(book_id)
    for path in files:
        path.unlink(missing_ok=True)
    cache: PageCache = request.app.state.page_cache
    cache.remove_book(book_id)
    return Response(status_code=204)


def _store_cover(request: Request, book_id: int, cover_bytes: bytes, image: Image.Image, custom: bool) -> BookOut:
    data_dir: Path = request.app.state.config.data_dir
    with immediate_session(request.app.state.engine) as session:
        book = _get_book(session, book_id)
        write_atomic(data_dir / book.cover_rel_path, cover_bytes)
        book.cover_is_custom = custom
        book.spine_color = spine_color(image)
        book.updated_at = _after(book.updated_at)
        session.add(book)
        session.flush()
        result = book_out(book, data_dir)
    return result


@router.put("/{book_id}/cover", response_model=BookOut)
def replace_cover(book_id: int, request: Request, cover_file: Annotated[UploadFile, File()]) -> BookOut:
    with Session(request.app.state.engine) as session:
        _get_book(session, book_id)
    data = _read_cover(cover_file)
    if data is None:
        raise _invalid("cover_file", "cover_file is required", None)
    cover_bytes, image = load_custom_cover(data)
    return _store_cover(request, book_id, cover_bytes, image, custom=True)


@router.delete("/{book_id}/cover", response_model=BookOut)
def revert_cover(book_id: int, request: Request) -> BookOut:
    data_dir: Path = request.app.state.config.data_dir
    with Session(request.app.state.engine) as session:
        pdf = data_dir / _get_book(session, book_id).pdf_rel_path
    if not pdf.is_file():
        raise pdf_missing()
    cover_bytes, image = cover_from_pdf(pdf)
    return _store_cover(request, book_id, cover_bytes, image, custom=False)


@router.get("/{book_id}/cover")
def get_book_cover(book_id: int, request: Request) -> FileResponse:
    data_dir: Path = request.app.state.config.data_dir
    with Session(request.app.state.engine) as session:
        book = _get_book(session, book_id)

    path = data_dir / book.cover_rel_path
    if not path.is_file():
        # Self-repair a cover removed by hand: regenerate the Page 1 snapshot.
        pdf = data_dir / book.pdf_rel_path
        if not pdf.is_file():
            raise pdf_missing()
        write_atomic(path, cover_from_pdf(pdf)[0])

    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})


@router.get("/{book_id}/page/{page_num}")
def get_page(book_id: int, page_num: int, request: Request, quality: Quality = "high") -> Response:
    started = time.perf_counter()
    data_dir: Path = request.app.state.config.data_dir
    with Session(request.app.state.engine) as session:
        book = _get_book(session, book_id)
    if not 1 <= page_num <= book.page_count:
        raise ApiError(
            404, "page_out_of_range", f"Page {page_num} is outside 1..{book.page_count}."
        )
    pdf = data_dir / book.pdf_rel_path
    if not pdf.is_file():
        raise pdf_missing()

    # Book IDs are never reused and stored PDFs never change: the image is immutable.
    etag = f'"{book_id}-{quality}-{page_num}"'
    headers = {"Cache-Control": IMMUTABLE, "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)

    cache: PageCache = request.app.state.page_cache
    pool: RenderPool = request.app.state.render_pool
    data = cache.get(book_id, quality, page_num)
    source = "cache"
    if data is None:
        data = pool.render(RenderJob(book_id, str(pdf), page_num, quality))
        cache.put(book_id, quality, page_num, data)
        source = "render"
    pool.schedule_prefetch(book_id, str(pdf), page_num, book.page_count)

    headers["Server-Timing"] = f"{source};dur={(time.perf_counter() - started) * 1000:.1f}"
    return Response(content=data, media_type="image/webp", headers=headers)
