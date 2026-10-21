"""Story verification tests. Each story's tests share a name prefix used with `-k`."""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from app import config as config_module
from app.config import AppConfig, resolve_data_dir
from app.database import SCHEMA_VERSION, SchemaTooNewError, immediate_session, init_db
from app.main import create_app
from app.models import AppSetting, Book, Category

# ---------------------------------------------------------------------------
# US-01: workspace init, SQLite WAL database and models
# ---------------------------------------------------------------------------


def _category(name: str = "Programming", column_index: int = 0) -> Category:
    return Category(name=name, name_key=name.casefold(), column_index=column_index)


def _book(category_id: int, shelf: int = 0, slot: int = 0, **overrides) -> Book:
    values = dict(
        title="A Book",
        category_id=category_id,
        reading_direction="LTR",
        pdf_rel_path="pdfs/book_1.pdf",
        cover_rel_path="covers/book_1.webp",
        page_count=120,
        page_width_pt=595.0,
        page_height_pt=842.0,
        spine_color="#6B3F2A",
        file_sha256="0" * 64,
        file_size_bytes=1024,
        shelf_number=shelf,
        slot_index=slot,
    )
    values.update(overrides)
    return Book(**values)


def test_health_and_db_health_endpoint(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "api_version": 1}


def test_health_and_db_creates_data_layout(client: TestClient, config: AppConfig) -> None:
    for name in ("pdfs", "covers", "cache", "staging"):
        assert (config.data_dir / name).is_dir(), name
    assert config.db_path.is_file()


def test_health_and_db_pragmas_on_every_connection(client: TestClient, app) -> None:
    engine = app.state.engine
    for _ in range(2):
        with engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
    # WAL is persistent in the file: a plain sqlite3 connection sees it too.
    raw = sqlite3.connect(app.state.config.db_path)
    try:
        assert raw.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    finally:
        raw.close()


def test_health_and_db_schema_version(client: TestClient, app) -> None:
    with app.state.engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == SCHEMA_VERSION == 1


def test_health_and_db_tables_and_columns(client: TestClient, app) -> None:
    expected = {
        "category": {"id", "name", "name_key", "column_index", "created_at"},
        "book": {
            "id", "title", "category_id", "reading_direction", "author", "notes",
            "pdf_rel_path", "cover_rel_path", "cover_is_custom", "page_count",
            "page_width_pt", "page_height_pt", "spine_color", "file_sha256",
            "file_size_bytes", "last_read_page", "last_opened_at", "shelf_number",
            "slot_index", "created_at", "updated_at",
        },
        "app_setting": {"id", "ui_language", "default_direction", "graphics_quality", "ambient_light"},
    }
    with app.state.engine.connect() as connection:
        for table, columns in expected.items():
            rows = connection.exec_driver_sql(f"PRAGMA table_info({table})").all()
            assert {row[1] for row in rows} == columns, table
        sql = connection.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'book'"
        ).scalar_one()
        assert "AUTOINCREMENT" in sql
        assert "ON DELETE RESTRICT" in sql
        indexes = {
            row[1] for row in connection.exec_driver_sql("PRAGMA index_list(book)").all()
        }
        assert {"ix_book_category_id", "ix_book_last_opened_at", "ix_book_file_sha256"} <= indexes


def test_health_and_db_settings_singleton_defaults(client: TestClient, app) -> None:
    with Session(app.state.engine) as session:
        settings = session.get(AppSetting, 1)
        assert settings is not None
        assert (settings.ui_language, settings.default_direction) == ("en", "LTR")
        assert (settings.graphics_quality, settings.ambient_light) == ("auto", 1.0)
    with app.state.engine.connect() as connection:
        with pytest.raises(IntegrityError):
            connection.exec_driver_sql("INSERT INTO app_setting (id) VALUES (2)")


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("ui_language", "fr"),
        ("default_direction", "TTB"),
        ("graphics_quality", "ultra"),
        ("ambient_light", 1.6),
        ("ambient_light", 0.3),
    ],
)
def test_health_and_db_settings_checks(client: TestClient, app, column: str, value) -> None:
    with app.state.engine.connect() as connection:
        with pytest.raises(IntegrityError):
            connection.execute(text(f"UPDATE app_setting SET {column} = :v WHERE id = 1"), {"v": value})


def test_health_and_db_book_slot_unique_and_foreign_key(client: TestClient, app) -> None:
    with Session(app.state.engine) as session:
        category = _category()
        session.add(category)
        session.commit()
        session.add(_book(category.id, shelf=0, slot=3))
        session.commit()

        session.add(_book(category.id, shelf=0, slot=3))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

        session.add(_book(category_id=999))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

        # ON DELETE RESTRICT: a category with books cannot be deleted.
        session.delete(session.get(Category, category.id))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


@pytest.mark.parametrize(
    "overrides",
    [
        {"reading_direction": "TTB"},
        {"slot_index": 30},
        {"slot_index": -1},
        {"shelf_number": -1},
        {"page_count": 0},
        {"page_width_pt": 0.0},
        {"last_read_page": 0},
        {"spine_color": "red"},
        {"spine_color": "#12345G"},
        {"title": ""},
        {"title": "x" * 301},
        {"author": "x" * 201},
        {"notes": "x" * 5001},
    ],
)
def test_health_and_db_book_checks(client: TestClient, app, overrides: dict) -> None:
    with Session(app.state.engine) as session:
        category = _category()
        session.add(category)
        session.commit()
        session.add(_book(category.id, **overrides))
        with pytest.raises(IntegrityError):
            session.commit()


def test_health_and_db_category_constraints(client: TestClient, app) -> None:
    with Session(app.state.engine) as session:
        session.add(_category("History"))
        session.commit()
        session.add(Category(name="history", name_key="history", column_index=1))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        session.add(_category("x" * 41, column_index=1))
        with pytest.raises(IntegrityError):
            session.commit()


def test_health_and_db_book_ids_never_reused(client: TestClient, app) -> None:
    with Session(app.state.engine) as session:
        category = _category()
        session.add(category)
        session.commit()
        first = _book(category.id)
        session.add(first)
        session.commit()
        first_id = first.id
        session.delete(first)
        session.commit()
        second = _book(category.id)
        session.add(second)
        session.commit()
        assert second.id > first_id


def test_health_and_db_timestamps_are_iso_utc(client: TestClient, app) -> None:
    with Session(app.state.engine) as session:
        category = _category()
        session.add(category)
        session.commit()
    with app.state.engine.connect() as connection:
        stored = connection.exec_driver_sql("SELECT created_at FROM category").scalar_one()
        datetime.strptime(stored, "%Y-%m-%dT%H:%M:%SZ")
        # Rows written by SQLite's CURRENT_TIMESTAMP default read back as datetimes too.
        connection.exec_driver_sql(
            "INSERT INTO category (name, name_key, column_index) VALUES ('Novels', 'novels', 1)"
        )
        connection.commit()
    with Session(app.state.engine) as session:
        novels = session.exec(
            Category.__table__.select().where(Category.__table__.c.name == "Novels")
        ).one()
        assert isinstance(novels.created_at, datetime)


def test_health_and_db_init_is_idempotent(config: AppConfig) -> None:
    init_db(config).dispose()
    engine = init_db(config)
    try:
        with engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT COUNT(*) FROM app_setting").scalar_one() == 1
            assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == SCHEMA_VERSION
    finally:
        engine.dispose()


def test_health_and_db_rejects_newer_schema(config: AppConfig) -> None:
    init_db(config).dispose()
    raw = sqlite3.connect(config.db_path)
    raw.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    raw.close()
    with pytest.raises(SchemaTooNewError):
        init_db(config)


def test_health_and_db_immediate_session_takes_write_lock(client: TestClient, app) -> None:
    with immediate_session(app.state.engine) as session:
        session.add(_category())
        other = sqlite3.connect(app.state.config.db_path, timeout=0)
        try:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                other.execute("BEGIN IMMEDIATE")
        finally:
            other.close()
    with Session(app.state.engine) as session:
        assert session.exec(Category.__table__.select()).all()


def test_health_and_db_data_dir_resolution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    assert resolve_data_dir({}) == repo_root / "library_data"
    monkeypatch.chdir(tmp_path)
    assert resolve_data_dir({}) == repo_root / "library_data"
    assert config_module.DEFAULT_DATA_DIR == repo_root / "library_data"
    custom = tmp_path / "elsewhere"
    assert resolve_data_dir({"DAR_DATA_DIR": str(custom)}) == custom.resolve()


def test_health_and_db_load_config_from_env(tmp_path: Path) -> None:
    config = config_module.load_config(
        {"DAR_DATA_DIR": str(tmp_path), "DAR_PORT": "8765", "DAR_RENDER_WORKERS": "0"}
    )
    assert (config.data_dir, config.port, config.render_workers) == (tmp_path.resolve(), 8765, 0)
    with pytest.raises(ValueError, match="DAR_PORT"):
        config_module.load_config({"DAR_PORT": "abc"})


def test_health_and_db_rejects_foreign_host(app) -> None:
    with TestClient(app, base_url="http://evil.example") as foreign:
        assert foreign.get("/api/health").status_code == 400
    with TestClient(app, base_url="http://localhost:8000") as local:
        assert local.get("/api/health").status_code == 200


def test_health_and_db_guard_blocks_mutations_without_client_header(app) -> None:
    with TestClient(app, base_url="http://127.0.0.1:8000") as bare:
        response = bare.post("/api/health")
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden_client"
        response = bare.post(
            "/api/health", headers={"X-Dar-Client": "1", "Origin": "https://evil.example"}
        )
        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "forbidden_origin"


def test_health_and_db_no_cdn_docs_pages(client: TestClient) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 200


def test_health_and_db_import_has_no_side_effects(tmp_path: Path) -> None:
    # Importing app.main creates the module-level app but must not touch the disk.
    target = Path(os.environ["DAR_DATA_DIR"])
    create_app(AppConfig(data_dir=target, render_workers=0))
    assert not target.exists()
