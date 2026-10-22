"""Informational latency report (docs/ARCHITECTURE.md section 8.6).

Run with:  .venv/bin/pytest tests/test_perf.py -m perf -s
These tests print measurements and never fail on timing: numbers depend on the machine.
"""

from __future__ import annotations

import statistics
from pathlib import Path

import pymupdf
import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app
from tests import pdf_factory

pytestmark = pytest.mark.perf

TARGETS_MS = {"import": 1500, "hit": 10, "low": 50, "high": 250, "zoom": 500}
SAMPLE_PAGES = [1, 31, 61, 91, 121, 151, 181, 211, 241, 271]  # far apart: never prefetched


@pytest.fixture(scope="module")
def realistic_scan(tmp_path_factory: pytest.TempPathFactory) -> Path:
    # 40 distinct full-page 300 DPI scans, like a real 400-page scanned book (~20 MB).
    path = tmp_path_factory.mktemp("perf") / "scanned-400-realistic.pdf"
    return pdf_factory.scanned_pdf(path, pages=400, distinct_scans=40)


def _server_ms(response) -> float:
    return float(response.headers["server-timing"].split("dur=")[1])


def test_latency_report(tmp_path: Path, realistic_scan: Path) -> None:
    config = AppConfig(data_dir=tmp_path / "lib", render_workers=0)
    with TestClient(create_app(config), base_url="http://127.0.0.1:8000", headers={"X-Dar-Client": "1"}) as client:
        category = client.post("/api/categories", json={"name": "Perf"}).json()
        imports = []
        for _ in range(3):
            with realistic_scan.open("rb") as handle:
                upload = client.post("/api/uploads", files={"pdf_file": ("scan.pdf", handle, "application/pdf")})
            assert upload.status_code == 201
            imports.append(_server_ms(upload))
        book = client.post(
            "/api/books",
            data={"upload_id": upload.json()["upload_id"], "title": "Perf", "category_id": str(category["id"]),
                  "reading_direction": "LTR"},
        ).json()

        results: dict[str, list[float]] = {"import": imports, "hit": [], "low": [], "high": [], "zoom": []}
        pool = client.app.state.render_pool
        for quality in ("low", "high", "zoom"):
            for page in SAMPLE_PAGES:
                pool.drain(timeout=300)
                pymupdf.TOOLS.store_shrink(100)  # cold: drop MuPDF's decoded-image cache
                response = client.get(f"/api/books/{book['id']}/page/{page}?quality={quality}")
                assert response.status_code == 200
                assert response.headers["server-timing"].startswith("render")
                results[quality].append(_server_ms(response))
                hit = client.get(f"/api/books/{book['id']}/page/{page}?quality={quality}")
                results["hit"].append(_server_ms(hit))
        pool.drain(timeout=300)

    size_mb = realistic_scan.stat().st_size / 1e6
    print(f"\nLatency report: 400-page scanned A4 PDF ({size_mb:.1f} MB), in-process rendering")
    print(f"{'case':<8}{'median ms':>12}{'max ms':>10}{'target ms':>12}  status")
    for case, values in results.items():
        median = statistics.median(values)
        status = "ok" if median < TARGETS_MS[case] else "ABOVE TARGET"
        print(f"{case:<8}{median:>12.1f}{max(values):>10.1f}{TARGETS_MS[case]:>12}  {status}")
