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


# ---------------------------------------------------------------------------
# US-02: category and settings CRUD endpoints, bootstrap
# ---------------------------------------------------------------------------

ISO_UTC = "%Y-%m-%dT%H:%M:%SZ"


def _create(client: TestClient, name: str):
    return client.post("/api/categories", json={"name": name})


def _categories(client: TestClient) -> list[dict]:
    return client.get("/api/bootstrap").json()["categories"]


def _insert_books(app, category_id: int, slots: list[tuple[int, int]], **overrides) -> list[int]:
    ids = []
    with Session(app.state.engine) as session:
        for shelf, slot in slots:
            book = _book(category_id, shelf=shelf, slot=slot, **overrides)
            session.add(book)
            session.commit()
            ids.append(book.id)
    return ids


def test_categories_and_settings_create_sequential_columns(client: TestClient) -> None:
    created = [_create(client, name) for name in ("Programming", "Histoire", "العربية")]
    assert [r.status_code for r in created] == [201, 201, 201]
    bodies = [r.json() for r in created]
    assert [b["name"] for b in bodies] == ["Programming", "Histoire", "العربية"]
    assert [b["column_index"] for b in bodies] == [0, 1, 2]
    assert all(b["book_count"] == 0 for b in bodies)
    for body in bodies:
        datetime.strptime(body["created_at"], ISO_UTC)
    assert [c["name"] for c in _categories(client)] == ["Programming", "Histoire", "العربية"]


def test_categories_and_settings_names_trimmed_and_nfc(client: TestClient) -> None:
    decomposed = "  École  "  # "École" with a combining accent, padded
    body = _create(client, decomposed).json()
    assert body["name"] == "École"


def test_categories_and_settings_duplicate_names(client: TestClient) -> None:
    assert _create(client, "History").status_code == 201
    for duplicate in (" history ", "HISTORY"):
        response = _create(client, duplicate)
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "category_name_taken"
    assert _create(client, "العربية").status_code == 201
    assert _create(client, " العربية").status_code == 409
    # Case-insensitive but accent-aware: "École" and "école" clash, "Ecole" does not.
    assert _create(client, "École").status_code == 201
    assert _create(client, "école").status_code == 409
    assert _create(client, "Ecole").status_code == 201


@pytest.mark.parametrize("name", ["", "   ", "x" * 41, "ع" * 41])
def test_categories_and_settings_invalid_names(client: TestClient, name: str) -> None:
    assert _create(client, name).status_code == 422


def test_categories_and_settings_name_length_limit(client: TestClient) -> None:
    assert _create(client, "x" * 40).status_code == 201
    assert _create(client, "ع" * 40).status_code == 201


def test_categories_and_settings_rename(client: TestClient) -> None:
    history = _create(client, "History").json()
    _create(client, "Novels")
    response = client.patch(f"/api/categories/{history['id']}", json={"name": "Histoire"})
    assert response.status_code == 200
    assert response.json()["name"] == "Histoire"
    assert response.json()["column_index"] == history["column_index"]
    # Changing only the letter case of its own name is allowed.
    assert client.patch(f"/api/categories/{history['id']}", json={"name": "HISTOIRE"}).status_code == 200
    clash = client.patch(f"/api/categories/{history['id']}", json={"name": "novels"})
    assert clash.status_code == 409
    assert clash.json()["detail"]["code"] == "category_name_taken"
    missing = client.patch("/api/categories/999", json={"name": "Anything"})
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "category_not_found"
    assert client.patch(f"/api/categories/{history['id']}", json={"name": ""}).status_code == 422


def test_categories_and_settings_delete_empty_compacts_columns(client: TestClient) -> None:
    ids = [_create(client, name).json()["id"] for name in ("A", "B", "C", "D")]
    response = client.delete(f"/api/categories/{ids[1]}")
    assert response.status_code == 204
    assert response.content == b""
    remaining = _categories(client)
    assert [(c["name"], c["column_index"]) for c in remaining] == [("A", 0), ("C", 1), ("D", 2)]
    # The next new category continues after the highest index.
    assert _create(client, "E").json()["column_index"] == 3


def test_categories_and_settings_delete_unknown(client: TestClient) -> None:
    response = client.delete("/api/categories/999")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "category_not_found"


def test_categories_and_settings_delete_non_empty_requires_move(client: TestClient, app) -> None:
    category = _create(client, "History").json()
    _insert_books(app, category["id"], [(0, 0), (0, 1), (1, 0)])
    response = client.delete(f"/api/categories/{category['id']}")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "category_not_empty"
    assert detail["book_count"] == 3
    assert [c["book_count"] for c in _categories(client)] == [3]


def test_categories_and_settings_delete_with_move_to(client: TestClient, app) -> None:
    source = _create(client, "Histoire").json()
    target = _create(client, "History").json()
    third = _create(client, "Novels").json()
    # Target already holds books in (0, 0) and (0, 2): moved books fill (0, 1), (0, 3), (0, 4).
    _insert_books(app, target["id"], [(0, 0), (0, 2)])
    moved_ids = _insert_books(app, source["id"], [(1, 5), (0, 0), (0, 9)])

    response = client.delete(f"/api/categories/{source['id']}?move_to={target['id']}")
    assert response.status_code == 204

    data = client.get("/api/bootstrap").json()
    assert [(c["name"], c["column_index"]) for c in data["categories"]] == [
        ("History", 0),
        ("Novels", 1),
    ]
    assert {c["id"]: c["book_count"] for c in data["categories"]} == {target["id"]: 5, third["id"]: 0}
    moved = {b["id"]: (b["category_id"], b["shelf_number"], b["slot_index"]) for b in data["books"]}
    # Books move in id order into the first free slots.
    assert [moved[i] for i in moved_ids] == [
        (target["id"], 0, 1),
        (target["id"], 0, 3),
        (target["id"], 0, 4),
    ]


def test_categories_and_settings_delete_move_to_invalid(client: TestClient, app) -> None:
    category = _create(client, "History").json()
    _insert_books(app, category["id"], [(0, 0)])
    unknown = client.delete(f"/api/categories/{category['id']}?move_to=999")
    assert unknown.status_code == 404
    assert unknown.json()["detail"]["code"] == "category_not_found"
    itself = client.delete(f"/api/categories/{category['id']}?move_to={category['id']}")
    assert itself.status_code == 422
    assert client.delete(f"/api/categories/{category['id']}?move_to=abc").status_code == 422
    # Nothing changed.
    assert _categories(client)[0]["book_count"] == 1


def test_categories_and_settings_first_free_slot() -> None:
    from app.shelving import first_free_slot

    assert first_free_slot([]) == (0, 0)
    full_shelf = [(0, slot) for slot in range(30)]
    assert first_free_slot(full_shelf) == (1, 0)
    with_gap = [s for s in full_shelf if s != (0, 7)] + [(1, 0), (1, 1)]
    assert first_free_slot(with_gap) == (0, 7)


def test_categories_and_settings_patch_settings(client: TestClient, app) -> None:
    response = client.patch(
        "/api/settings",
        json={
            "ui_language": "ar",
            "default_direction": "RTL",
            "graphics_quality": "performance",
            "ambient_light": 0.4,
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "ui_language": "ar",
        "default_direction": "RTL",
        "graphics_quality": "performance",
        "ambient_light": 0.4,
    }
    # Partial update keeps the other fields.
    response = client.patch("/api/settings", json={"graphics_quality": "high", "ambient_light": 1.5})
    assert response.json() == {
        "ui_language": "ar",
        "default_direction": "RTL",
        "graphics_quality": "high",
        "ambient_light": 1.5,
    }
    assert client.patch("/api/settings", json={}).status_code == 200
    # Persisted in the database.
    with Session(app.state.engine) as session:
        stored = session.get(AppSetting, 1)
        assert (stored.ui_language, stored.default_direction) == ("ar", "RTL")
        assert (stored.graphics_quality, stored.ambient_light) == ("high", 1.5)
    assert client.get("/api/bootstrap").json()["settings"]["ui_language"] == "ar"


@pytest.mark.parametrize(
    "body",
    [
        {"ui_language": "fr"},
        {"default_direction": "TTB"},
        {"graphics_quality": "ultra"},
        {"ambient_light": 1.6},
        {"ambient_light": 0.39},
        {"ambient_light": "bright"},
        {"ui_language": None},
        {"unknown_field": 1},
    ],
)
def test_categories_and_settings_invalid_settings(client: TestClient, body: dict) -> None:
    assert client.patch("/api/settings", json=body).status_code == 422
    assert client.get("/api/bootstrap").json()["settings"] == {
        "ui_language": "en",
        "default_direction": "LTR",
        "graphics_quality": "auto",
        "ambient_light": 1.0,
    }


def test_categories_and_settings_bootstrap_shape(client: TestClient) -> None:
    data = client.get("/api/bootstrap").json()
    assert set(data) == {"categories", "books", "currently_reading", "settings", "api_version"}
    assert data["categories"] == data["books"] == data["currently_reading"] == []
    assert data["api_version"] == 1


def test_categories_and_settings_bootstrap_books_and_desk(client: TestClient, app, config) -> None:
    category = _create(client, "العربية").json()
    ids = _insert_books(
        app, category["id"], [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4)], reading_direction="RTL"
    )
    opened = {ids[0]: "2026-10-20 10:00:00", ids[2]: "2026-10-21 09:00:00",
              ids[3]: "2026-10-19 08:00:00", ids[4]: "2026-10-21 12:00:00"}
    with app.state.engine.begin() as connection:
        for book_id, when in opened.items():
            connection.exec_driver_sql(
                "UPDATE book SET last_opened_at = ? WHERE id = ?", (when, book_id)
            )
    # Only book ids[1] has its PDF file on disk.
    pdf = config.data_dir / "pdfs" / f"book_{ids[1]}.pdf"
    pdf.write_bytes(b"%PDF-1.7\n")
    with app.state.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE book SET pdf_rel_path = ? WHERE id = ?", (f"pdfs/book_{ids[1]}.pdf", ids[1])
        )

    data = client.get("/api/bootstrap").json()
    assert data["currently_reading"] == [ids[4], ids[2], ids[0]]
    assert data["categories"][0]["book_count"] == 5
    books = {b["id"]: b for b in data["books"]}
    assert set(books) == set(ids)
    sample = books[ids[4]]
    assert set(sample) == {
        "id", "title", "author", "notes", "category_id", "reading_direction", "page_count",
        "page_width_pt", "page_height_pt", "spine_color", "cover_url", "cover_is_custom",
        "file_size_bytes", "file_missing", "last_read_page", "last_opened_at", "shelf_number",
        "slot_index", "created_at", "updated_at",
    }
    assert sample["reading_direction"] == "RTL"
    assert sample["last_opened_at"] == "2026-10-21T12:00:00Z"
    assert books[ids[1]]["last_opened_at"] is None
    assert sample["cover_url"].startswith(f"/api/books/{ids[4]}/cover?v=")
    assert int(sample["cover_url"].rsplit("=", 1)[1]) > 0
    assert books[ids[1]]["file_missing"] is False
    assert sample["file_missing"] is True


def test_categories_and_settings_client_guard(app) -> None:
    with TestClient(app, base_url="http://127.0.0.1:8000") as bare:
        no_header = bare.post("/api/categories", json={"name": "History"})
        assert no_header.status_code == 403
        assert no_header.json()["detail"]["code"] == "forbidden_client"
        for method, path in (("PATCH", "/api/settings"), ("DELETE", "/api/categories/1")):
            assert bare.request(method, path, json={}).status_code == 403
        foreign = bare.post(
            "/api/categories",
            json={"name": "History"},
            headers={"X-Dar-Client": "1", "Origin": "https://evil.example"},
        )
        assert foreign.status_code == 403
        assert foreign.json()["detail"]["code"] == "forbidden_origin"
        origins = ("http://127.0.0.1:8000", "http://localhost:8000", "http://127.0.0.1:3000")
        for number, origin in enumerate(origins):
            response = bare.post(
                "/api/categories",
                json={"name": f"Allowed origin {number}"},
                headers={"X-Dar-Client": "1", "Origin": origin},
            )
            assert response.status_code == 201, origin
        # Reads need no header.
        assert bare.get("/api/bootstrap").status_code == 200


def test_categories_and_settings_cors_preflight_for_dev_origin(app) -> None:
    with TestClient(app, base_url="http://127.0.0.1:8000") as bare:
        allowed = bare.options(
            "/api/categories",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-dar-client,content-type",
            },
        )
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
        denied = bare.options(
            "/api/categories",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
        assert "access-control-allow-origin" not in denied.headers
