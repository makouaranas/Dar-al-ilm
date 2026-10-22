"""Page rendering in worker processes, with priority and cancellable prefetch.

docs/ARCHITECTURE.md section 8.3:
- PyMuPDF is not thread-safe, so pages render in worker processes (spawned, each
  single-threaded) that keep an LRU of open documents. With 0 workers (tests),
  rendering runs in-process under `PYMUPDF_LOCK`.
- Foreground requests (a page the UI asked for) are never queued behind prefetch jobs:
  the prefetch thread only starts a job while no foreground render is running.
- After serving page n, `schedule_prefetch()` queues `low` for n+1..n+6 and `high` for
  n+1..n+2. Queued jobs of the same book outside the new window are dropped (the user
  jumped).
"""

from __future__ import annotations

import logging
import multiprocessing
import threading
from collections import OrderedDict, deque
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from app.cache import PageCache
from app.pdf_service import PYMUPDF_LOCK, open_pdf, render_page_webp
from app.security import ApiError

logger = logging.getLogger("dar.render")

PREFETCH_LOW_AHEAD = 6
PREFETCH_HIGH_AHEAD = 2
OPEN_DOCUMENTS_PER_WORKER = 6


@dataclass(frozen=True)
class RenderJob:
    book_id: int
    pdf_path: str
    page: int
    quality: str


# --- Worker side: runs in a worker process, or in-process when there are no workers ----

_open_documents: OrderedDict[tuple[str, float], pymupdf.Document] = OrderedDict()

ErrorPayload = tuple[int, str, str]


def _document(pdf_path: str) -> pymupdf.Document:
    key = (pdf_path, Path(pdf_path).stat().st_mtime)
    doc = _open_documents.get(key)
    if doc is not None:
        _open_documents.move_to_end(key)
        return doc
    doc = open_pdf(Path(pdf_path))
    _open_documents[key] = doc
    while len(_open_documents) > OPEN_DOCUMENTS_PER_WORKER:
        _key, oldest = _open_documents.popitem(last=False)
        oldest.close()
    return doc


def render_job(job: RenderJob) -> tuple[str, bytes | ErrorPayload]:
    """Render one page: ("ok", webp bytes) or ("error", (status, code, message)).

    Errors are returned instead of raised because ApiError does not pickle across processes.
    """
    try:
        with PYMUPDF_LOCK:
            return "ok", render_page_webp(_document(job.pdf_path), job.page, job.quality)
    except ApiError as exc:
        return "error", (exc.status_code, exc.code, exc.message)
    except FileNotFoundError:
        return "error", (410, "pdf_missing", "The PDF file for this book is missing.")


def _warm_up() -> None:
    """No-op job that makes the executor start its worker process ahead of time."""


# --- Coordinator: lives in the API process -----------------------------------------------


class RenderPool:
    def __init__(self, workers: int, cache: PageCache, *, autostart_prefetch: bool = True) -> None:
        self._cache = cache
        self._executor: ProcessPoolExecutor | None = None
        if workers > 0:
            # "spawn": forking a multi-threaded server process is unsafe.
            self._executor = ProcessPoolExecutor(
                max_workers=workers, mp_context=multiprocessing.get_context("spawn")
            )
            for _ in range(workers):
                self._executor.submit(_warm_up)
        self._cond = threading.Condition()
        self._queue: deque[RenderJob] = deque()
        self._foreground = 0
        self._prefetch_busy = False
        self._closed = False
        self._thread = threading.Thread(target=self._prefetch_loop, name="dar-prefetch", daemon=True)
        if autostart_prefetch:
            self._thread.start()

    def _run(self, job: RenderJob) -> bytes:
        if self._executor is not None:
            status, payload = self._executor.submit(render_job, job).result()
        else:
            status, payload = render_job(job)
        if status == "error":
            assert isinstance(payload, tuple)
            raise ApiError(*payload)
        assert isinstance(payload, bytes)
        return payload

    def render(self, job: RenderJob) -> bytes:
        """Foreground render: runs now, ahead of any queued prefetch job."""
        with self._cond:
            self._foreground += 1
        try:
            return self._run(job)
        finally:
            with self._cond:
                self._foreground -= 1
                self._cond.notify_all()

    def schedule_prefetch(self, book_id: int, pdf_path: str, page: int, page_count: int) -> None:
        last_low = min(page + PREFETCH_LOW_AHEAD, page_count)
        last_high = min(page + PREFETCH_HIGH_AHEAD, page_count)
        wanted = [RenderJob(book_id, pdf_path, n, "low") for n in range(page + 1, last_low + 1)]
        wanted += [RenderJob(book_id, pdf_path, n, "high") for n in range(page + 1, last_high + 1)]
        wanted = [job for job in wanted if not self._cache.path(job.book_id, job.quality, job.page).exists()]
        window = range(page + 1, page + PREFETCH_LOW_AHEAD + 1)
        with self._cond:
            self._queue = deque(
                job for job in self._queue if job.book_id != book_id or job.page in window
            )
            queued = set(self._queue)
            self._queue.extend(job for job in wanted if job not in queued)
            self._cond.notify_all()

    def cancel_book(self, book_id: int) -> None:
        with self._cond:
            self._queue = deque(job for job in self._queue if job.book_id != book_id)

    def pending(self) -> list[RenderJob]:
        with self._cond:
            return list(self._queue)

    def _prefetch_one(self, job: RenderJob) -> None:
        if self._cache.path(job.book_id, job.quality, job.page).exists():
            return
        try:
            self._cache.put(job.book_id, job.quality, job.page, self._run(job))
        except Exception:
            logger.debug("Prefetch failed for %s", job, exc_info=True)

    def _prefetch_loop(self) -> None:
        while True:
            with self._cond:
                while not self._closed and (not self._queue or self._foreground > 0):
                    self._cond.wait()
                if self._closed:
                    return
                job = self._queue.popleft()
                self._prefetch_busy = True
            try:
                self._prefetch_one(job)
            finally:
                with self._cond:
                    self._prefetch_busy = False
                    self._cond.notify_all()

    def run_pending(self) -> None:
        """Run queued prefetch jobs on the calling thread (tests without autostart)."""
        while True:
            with self._cond:
                if not self._queue:
                    return
                job = self._queue.popleft()
            self._prefetch_one(job)

    def drain(self, timeout: float = 30.0) -> bool:
        """Wait until the prefetch queue is empty and idle. Returns False on timeout."""
        with self._cond:
            return self._cond.wait_for(
                lambda: not self._queue and not self._prefetch_busy, timeout=timeout
            )

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._queue.clear()
            self._cond.notify_all()
        if self._thread.is_alive():
            self._thread.join(timeout=10)
        if self._executor is not None:
            self._executor.shutdown(wait=True, cancel_futures=True)
