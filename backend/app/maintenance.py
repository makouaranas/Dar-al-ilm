"""Startup reconciliation of orphan and expired files (docs/ARCHITECTURE.md section 8.5).

Runs once at startup, after migrations. Only files that follow the app's own naming
(`book_{id}.pdf`, `book_{id}.webp`, `cache/book_{id}/`, staged uploads, `.tmp-*`) are
ever removed; anything else in the data directory is left alone.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sqlalchemy import Engine
from sqlmodel import Session, select

from app.models import Book, utc_now

logger = logging.getLogger("dar.maintenance")

STAGING_MAX_AGE_SECONDS = 24 * 3600
_BOOK_PDF = re.compile(r"book_(\d+)\.pdf")
_BOOK_COVER = re.compile(r"book_(\d+)\.webp")
_BOOK_DIR = re.compile(r"book_(\d+)")
_UPLOAD_FILE = re.compile(r"([0-9a-f]{32})\.(pdf|webp|json)")


@dataclass
class ReconcileReport:
    staging_removed: int = 0
    temp_removed: int = 0
    pdfs_removed: int = 0
    covers_removed: int = 0
    cache_dirs_removed: int = 0
    missing_pdfs: list[int] = field(default_factory=list)


def _staged_upload_is_stale(files: dict[str, Path], now: float) -> bool:
    if set(files) != {"pdf", "webp", "json"}:
        return True  # incomplete upload: no request can be writing it at startup
    if any(now - path.stat().st_mtime > STAGING_MAX_AGE_SECONDS for path in files.values()):
        return True
    try:
        meta = json.loads(files["json"].read_text(encoding="utf-8"))
        expires = datetime.strptime(meta["expires_at"], "%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, KeyError, OSError):
        return True
    return expires <= utc_now()


def reconcile(data_dir: Path, engine: Engine) -> ReconcileReport:
    report = ReconcileReport()
    now = time.time()
    with Session(engine) as session:
        books = session.exec(select(Book.id, Book.pdf_rel_path)).all()
    book_ids = {book_id for book_id, _path in books}

    for folder in ("pdfs", "covers", "staging", "cache"):
        for temp in (data_dir / folder).rglob(".tmp-*"):
            temp.unlink(missing_ok=True)
            report.temp_removed += 1

    uploads: dict[str, dict[str, Path]] = defaultdict(dict)
    for path in (data_dir / "staging").iterdir():
        match = _UPLOAD_FILE.fullmatch(path.name)
        if match and path.is_file():
            uploads[match.group(1)][match.group(2)] = path
    for files in uploads.values():
        if _staged_upload_is_stale(files, now):
            for path in files.values():
                path.unlink(missing_ok=True)
                report.staging_removed += 1

    for folder, pattern, counter in (
        ("pdfs", _BOOK_PDF, "pdfs_removed"),
        ("covers", _BOOK_COVER, "covers_removed"),
    ):
        for path in (data_dir / folder).iterdir():
            match = pattern.fullmatch(path.name)
            if match and path.is_file() and int(match.group(1)) not in book_ids:
                path.unlink(missing_ok=True)
                setattr(report, counter, getattr(report, counter) + 1)

    for path in (data_dir / "cache").iterdir():
        match = _BOOK_DIR.fullmatch(path.name)
        if match and path.is_dir() and int(match.group(1)) not in book_ids:
            shutil.rmtree(path, ignore_errors=True)
            report.cache_dirs_removed += 1

    report.missing_pdfs = sorted(
        book_id for book_id, rel_path in books if not (data_dir / rel_path).is_file()
    )

    logger.info(
        "Startup reconciliation: %d staged, %d temporary, %d PDF, %d cover files and "
        "%d cache folders removed; %d books with a missing PDF",
        report.staging_removed,
        report.temp_removed,
        report.pdfs_removed,
        report.covers_removed,
        report.cache_dirs_removed,
        len(report.missing_pdfs),
    )
    return report
