"""Phase 1 of the two-phase import: staged uploads (docs/ARCHITECTURE.md section 8.1).

POST /api/uploads stores the PDF in `staging/{upload_id}.pdf`, validates it, reads its
page count and page size, renders a Page 1 cover preview (`.webp`) and writes the
metadata (`.json`). POST /api/books (books.py) turns a staged upload into a book.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse
from sqlalchemy import Engine
from sqlmodel import Session, col, select
from starlette.datastructures import UploadFile

from app.config import AppConfig
from app.models import AppSetting, Book, utc_now
from app.pdf_service import (
    contains_arabic,
    display_filename,
    file_too_large,
    inspect_pdf,
    open_pdf,
    render_cover,
    stage_pdf_stream,
    suggest_title,
    write_atomic,
)
from app.schemas import DuplicateRef, UploadOut, iso_utc
from app.security import ApiError

router = APIRouter(prefix="/uploads", tags=["uploads"])

UPLOAD_TTL = timedelta(hours=24)
MB = 1024 * 1024
FORM_OVERHEAD = 64 * 1024  # multipart boundaries and headers around the file
_UPLOAD_ID = re.compile(r"[0-9a-f]{32}")


def upload_not_found() -> ApiError:
    return ApiError(404, "upload_not_found", "This upload does not exist or has expired.")


@dataclass(frozen=True)
class StagedPaths:
    pdf: Path
    cover: Path
    meta: Path

    def exist(self) -> bool:
        return self.pdf.is_file() and self.cover.is_file() and self.meta.is_file()

    def remove(self) -> None:
        for path in (self.pdf, self.cover, self.meta):
            path.unlink(missing_ok=True)


def staged_paths(data_dir: Path, upload_id: str) -> StagedPaths:
    """Paths of a staged upload. The ID format is checked, so it can never escape staging/."""
    if not _UPLOAD_ID.fullmatch(upload_id):
        raise upload_not_found()
    staging = data_dir / "staging"
    return StagedPaths(
        pdf=staging / f"{upload_id}.pdf",
        cover=staging / f"{upload_id}.webp",
        meta=staging / f"{upload_id}.json",
    )


def load_staged(data_dir: Path, upload_id: str) -> tuple[StagedPaths, dict[str, Any]]:
    """A complete, unexpired staged upload; expired or partial uploads are removed."""
    paths = staged_paths(data_dir, upload_id)
    if not paths.exist():
        paths.remove()
        raise upload_not_found()
    meta = json.loads(paths.meta.read_text(encoding="utf-8"))
    if datetime.strptime(meta["expires_at"], "%Y-%m-%dT%H:%M:%SZ") <= utc_now():
        paths.remove()
        raise upload_not_found()
    return paths, meta


def _stage(config: AppConfig, engine: Engine, upload: UploadFile) -> UploadOut:
    upload_id = uuid4().hex
    paths = staged_paths(config.data_dir, upload_id)
    try:
        staged = stage_pdf_stream(upload.file, paths.pdf, config.max_upload_mb * MB)
        doc = open_pdf(paths.pdf)
        try:
            info = inspect_pdf(doc)
            cover_bytes, _cover = render_cover(doc)
        finally:
            doc.close()
        write_atomic(paths.cover, cover_bytes)

        original_filename = display_filename(upload.filename)
        title = suggest_title(info.metadata_title, original_filename)
        with Session(engine) as session:
            setting = session.get(AppSetting, 1)
            duplicate = session.exec(
                select(Book).where(Book.file_sha256 == staged.sha256).order_by(col(Book.id))
            ).first()
        assert setting is not None, "init_db() creates the singleton settings row"
        direction = "RTL" if contains_arabic(title) else setting.default_direction

        now = utc_now()
        meta = {
            "upload_id": upload_id,
            "original_filename": original_filename,
            "file_size_bytes": staged.size,
            "file_sha256": staged.sha256,
            "page_count": info.page_count,
            "page_width_pt": info.page_width_pt,
            "page_height_pt": info.page_height_pt,
            "suggested_title": title,
            "suggested_direction": direction,
            "created_at": iso_utc(now),
            "expires_at": iso_utc(now + UPLOAD_TTL),
        }
        write_atomic(paths.meta, json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    except BaseException:
        paths.remove()
        raise

    return UploadOut(
        upload_id=upload_id,
        original_filename=original_filename,
        file_size_bytes=staged.size,
        page_count=info.page_count,
        page_width_pt=info.page_width_pt,
        page_height_pt=info.page_height_pt,
        suggested_title=title,
        suggested_direction=direction,  # type: ignore[arg-type]
        cover_preview_url=f"/api/uploads/{upload_id}/cover",
        duplicate_of=(
            DuplicateRef(id=duplicate.id, title=duplicate.title)
            if duplicate is not None and duplicate.id is not None
            else None
        ),
        expires_at=meta["expires_at"],
    )


@router.post("", status_code=201, response_model=UploadOut)
async def create_upload(request: Request, response: Response) -> UploadOut:
    config: AppConfig = request.app.state.config
    max_bytes = config.max_upload_mb * MB
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes + FORM_OVERHEAD:
        raise file_too_large(max_bytes)  # reject before receiving the body

    # Starlette spools the file part to a temporary file on disk after 1 MB.
    async with request.form(max_files=1, max_fields=4) as form:
        upload = form.get("pdf_file")
        if not isinstance(upload, UploadFile):
            raise RequestValidationError(
                [{"type": "missing", "loc": ("body", "pdf_file"), "msg": "Field required", "input": None}]
            )
        started = time.perf_counter()
        result = await run_in_threadpool(_stage, config, request.app.state.engine, upload)
        elapsed_ms = (time.perf_counter() - started) * 1000

    # Server-side processing time after the upload was received (goal G2).
    response.headers["Server-Timing"] = f"import;dur={elapsed_ms:.1f}"
    return result


@router.get("/{upload_id}/cover")
def get_upload_cover(upload_id: str, request: Request) -> FileResponse:
    paths, _meta = load_staged(request.app.state.config.data_dir, upload_id)
    return FileResponse(paths.cover, media_type="image/webp", headers={"Cache-Control": "no-store"})


@router.delete("/{upload_id}", status_code=204)
def delete_upload(upload_id: str, request: Request) -> Response:
    paths, _meta = load_staged(request.app.state.config.data_dir, upload_id)
    paths.remove()
    return Response(status_code=204)
