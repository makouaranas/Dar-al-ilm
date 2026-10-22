"""Rendered page cache with a least-recently-used size limit (docs/ARCHITECTURE.md 8.4).

Layout: cache/book_{id}/{quality}/{page}.webp. A cache hit touches the file's
modification time, so eviction removes the least recently used pages first.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
from pathlib import Path

from app.pdf_service import write_atomic

logger = logging.getLogger("dar.cache")

EVICT_TO_FRACTION = 0.9


class PageCache:
    def __init__(self, cache_dir: Path, limit_bytes: int) -> None:
        self._dir = cache_dir
        self._limit = limit_bytes
        self._lock = threading.Lock()
        self._dir.mkdir(parents=True, exist_ok=True)
        self._total = sum(path.stat().st_size for path in self._dir.rglob("*.webp"))

    @property
    def total_bytes(self) -> int:
        return self._total

    def path(self, book_id: int, quality: str, page: int) -> Path:
        return self._dir / f"book_{book_id}" / quality / f"{page}.webp"

    def get(self, book_id: int, quality: str, page: int) -> bytes | None:
        path = self.path(book_id, quality, page)
        try:
            data = path.read_bytes()
            os.utime(path)  # mark as recently used
        except FileNotFoundError:
            return None
        return data

    def put(self, book_id: int, quality: str, page: int, data: bytes) -> None:
        path = self.path(book_id, quality, page)
        path.parent.mkdir(parents=True, exist_ok=True)
        previous = path.stat().st_size if path.exists() else 0
        write_atomic(path, data)
        with self._lock:
            self._total += len(data) - previous
            over_limit = self._total > self._limit
        if over_limit:
            self.evict()

    def evict(self) -> int:
        """Delete least recently used pages until the cache is at 90 % of its limit."""
        with self._lock:
            entries = []
            for path in self._dir.rglob("*.webp"):
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                entries.append((stat.st_mtime, stat.st_size, path))
            entries.sort()
            total = sum(size for _mtime, size, _path in entries)
            target = self._limit * EVICT_TO_FRACTION
            removed = 0
            for _mtime, size, path in entries:
                if total <= target:
                    break
                path.unlink(missing_ok=True)
                total -= size
                removed += 1
            self._total = total
        if removed:
            logger.info("Evicted %d cached pages; cache now %.1f MB", removed, total / 1e6)
        return removed

    def remove_book(self, book_id: int) -> None:
        book_dir = self._dir / f"book_{book_id}"
        with self._lock:
            size = sum(path.stat().st_size for path in book_dir.rglob("*.webp")) if book_dir.exists() else 0
            shutil.rmtree(book_dir, ignore_errors=True)
            self._total = max(0, self._total - size)
