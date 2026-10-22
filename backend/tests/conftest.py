"""Shared fixtures. Tests always use a temporary data directory, never a real library."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import create_app

BASE_URL = "http://127.0.0.1:8000"


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Anything that reads the environment also lands in the temporary directory.
    monkeypatch.setenv("DAR_DATA_DIR", str(tmp_path / "library_data"))
    monkeypatch.setenv("DAR_RENDER_WORKERS", "0")


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return AppConfig(data_dir=tmp_path / "library_data", port=8000, render_workers=0)


@pytest.fixture
def app(config: AppConfig):
    return create_app(config)


@pytest.fixture
def client(app) -> Iterator[TestClient]:
    """Client that behaves like the frontend: same origin, X-Dar-Client header."""
    with TestClient(app, base_url=BASE_URL, headers={"X-Dar-Client": "1"}) as test_client:
        yield test_client
