"""Story verification tests. Each story's tests share a name prefix used with `-k`."""

from __future__ import annotations

import os
import sqlite3
from datetime import UTC, datetime
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


# ---------------------------------------------------------------------------
# US-03: managed PDF upload, page count, Page 1 cover, auto-shelf math
# ---------------------------------------------------------------------------

import hashlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402

from PIL import Image  # noqa: E402

from tests import pdf_factory  # noqa: E402


@pytest.fixture(scope="session")
def scanned_400(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return pdf_factory.scanned_pdf(tmp_path_factory.mktemp("fixtures") / "scanned-400.pdf")


@pytest.fixture
def sample_pdf(tmp_path: Path) -> Path:
    return pdf_factory.text_pdf(tmp_path / "sample.pdf", pages=5, title="Muqaddimah", page_size=pdf_factory.A5)


def _upload(client: TestClient, path: Path, filename: str | None = None):
    with path.open("rb") as handle:
        return client.post(
            "/api/uploads", files={"pdf_file": (filename or path.name, handle, "application/pdf")}
        )


def _staging_files(config: AppConfig) -> list[str]:
    return sorted(p.name for p in (config.data_dir / "staging").iterdir())


def _save_book(client: TestClient, upload_id: str, category_id: int, **fields):
    data = {
        "upload_id": upload_id,
        "title": "Muqaddimah",
        "category_id": str(category_id),
        "reading_direction": "LTR",
        **{key: value for key, value in fields.items() if key != "files"},
    }
    return client.post("/api/books", data=data, files=fields.get("files"))


def _import(client: TestClient, path: Path, category_id: int, **fields) -> dict:
    upload = _upload(client, path)
    assert upload.status_code == 201, upload.text
    response = _save_book(client, upload.json()["upload_id"], category_id, **fields)
    assert response.status_code == 201, response.text
    return response.json()


def test_book_upload_and_shelf_overflow_upload_metadata(client: TestClient, config, sample_pdf) -> None:
    response = _upload(client, sample_pdf, "ibn-khaldun.pdf")
    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == {
        "upload_id", "original_filename", "file_size_bytes", "page_count", "page_width_pt",
        "page_height_pt", "suggested_title", "suggested_direction", "cover_preview_url",
        "duplicate_of", "expires_at",
    }
    upload_id = body["upload_id"]
    assert len(upload_id) == 32
    assert body["original_filename"] == "ibn-khaldun.pdf"
    assert body["file_size_bytes"] == sample_pdf.stat().st_size
    assert (body["page_count"], body["page_width_pt"], body["page_height_pt"]) == (5, 420.0, 595.0)
    assert body["suggested_title"] == "Muqaddimah"
    assert body["suggested_direction"] == "LTR"
    assert body["duplicate_of"] is None
    expires = datetime.strptime(body["expires_at"], ISO_UTC)
    now = datetime.now(UTC).replace(tzinfo=None)
    assert 23.9 * 3600 < (expires - now).total_seconds() <= 24 * 3600 + 5
    assert _staging_files(config) == sorted(f"{upload_id}{ext}" for ext in (".json", ".pdf", ".webp"))
    assert (config.data_dir / "staging" / f"{upload_id}.pdf").read_bytes() == sample_pdf.read_bytes()
    assert "import;dur=" in response.headers["server-timing"]

    preview = client.get(body["cover_preview_url"])
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/webp"
    with Image.open(io.BytesIO(preview.content)) as image:
        assert image.format == "WEBP"
        assert max(image.size) == 1024


def test_book_upload_and_shelf_overflow_suggestions(client: TestClient, tmp_path: Path) -> None:
    arabic = pdf_factory.text_pdf(tmp_path / "a.pdf", pages=1, title="مقدمة ابن خلدون")
    body = _upload(client, arabic).json()
    assert (body["suggested_title"], body["suggested_direction"]) == ("مقدمة ابن خلدون", "RTL")

    no_title = pdf_factory.text_pdf(tmp_path / "b.pdf", pages=1)
    body = _upload(client, no_title, "ibn_khaldun-muqaddimah.PDF").json()
    assert body["suggested_title"] == "ibn khaldun muqaddimah"

    meaningless = pdf_factory.text_pdf(tmp_path / "c.pdf", pages=1, title="Microsoft Word - draft.docx")
    assert _upload(client, meaningless, "Le Petit Prince.pdf").json()["suggested_title"] == "Le Petit Prince"

    client.patch("/api/settings", json={"default_direction": "RTL"})
    assert _upload(client, no_title, "notes.pdf").json()["suggested_direction"] == "RTL"


def test_book_upload_and_shelf_overflow_filename_is_display_only(client: TestClient, config, sample_pdf) -> None:
    body = _upload(client, sample_pdf, "../../evil/../Muqaddimah.pdf").json()
    assert body["original_filename"] == "Muqaddimah.pdf"
    assert not (config.data_dir.parent / "evil").exists()
    assert all(name.startswith(body["upload_id"]) for name in _staging_files(config))


@pytest.mark.parametrize(
    ("factory", "status", "code"),
    [
        (lambda p: (p.write_bytes(pdf_factory.image_bytes("PNG")), p)[1], 415, "not_pdf"),
        (lambda p: (p.write_bytes(b""), p)[1], 415, "not_pdf"),
        (pdf_factory.encrypted_pdf, 422, "pdf_encrypted"),
        (pdf_factory.zero_page_pdf, 422, "pdf_empty"),
        (pdf_factory.damaged_pdf, 422, "pdf_damaged"),
    ],
    ids=["png", "empty-file", "encrypted", "zero-pages", "damaged"],
)
def test_book_upload_and_shelf_overflow_rejections(
    client: TestClient, config, tmp_path: Path, factory, status: int, code: str
) -> None:
    path = factory(tmp_path / "bad.pdf")
    response = _upload(client, path)
    assert response.status_code == status, response.text
    assert response.json()["detail"]["code"] == code
    assert _staging_files(config) == []


def test_book_upload_and_shelf_overflow_too_large(tmp_path: Path) -> None:
    small = AppConfig(data_dir=tmp_path / "lib", render_workers=0, max_upload_mb=1)
    with TestClient(create_app(small), base_url="http://127.0.0.1:8000", headers={"X-Dar-Client": "1"}) as c:
        # Rejected from Content-Length before the body is read.
        huge = pdf_factory.padded_pdf(tmp_path / "huge.pdf", 3 * 1024 * 1024)
        response = _upload(c, huge)
        assert response.status_code == 413
        assert response.json()["detail"]["code"] == "file_too_large"
        # Just over the limit but within the form overhead: caught while copying.
        slightly = pdf_factory.padded_pdf(tmp_path / "slightly.pdf", 1024 * 1024 + 10_000)
        response = _upload(c, slightly)
        assert response.status_code == 413
        assert response.json()["detail"]["code"] == "file_too_large"
        assert _staging_files(small) == []
        within = pdf_factory.padded_pdf(tmp_path / "within.pdf", 1024 * 1024 - 10_000)
        assert _upload(c, within).status_code == 201


def test_book_upload_and_shelf_overflow_missing_file_field(client: TestClient) -> None:
    assert client.post("/api/uploads", data={"other": "x"}).status_code == 422
    assert client.post("/api/uploads", json={"pdf_file": "x"}).status_code == 422


def test_book_upload_and_shelf_overflow_cancel_upload(client: TestClient, config, sample_pdf) -> None:
    upload_id = _upload(client, sample_pdf).json()["upload_id"]
    assert client.delete(f"/api/uploads/{upload_id}").status_code == 204
    assert _staging_files(config) == []
    for method, url in (("GET", f"/api/uploads/{upload_id}/cover"), ("DELETE", f"/api/uploads/{upload_id}")):
        response = client.request(method, url)
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "upload_not_found"
    assert client.get("/api/uploads/..%2F..%2Flibrary.db/cover").status_code == 404
    assert client.get("/api/uploads/NOT-A-VALID-ID/cover").json()["detail"]["code"] == "upload_not_found"


def test_book_upload_and_shelf_overflow_expired_upload(client: TestClient, config, sample_pdf) -> None:
    upload_id = _upload(client, sample_pdf).json()["upload_id"]
    meta_path = config.data_dir / "staging" / f"{upload_id}.json"
    meta = json.loads(meta_path.read_text())
    meta["expires_at"] = "2020-01-01T00:00:00Z"
    meta_path.write_text(json.dumps(meta))
    response = client.get(f"/api/uploads/{upload_id}/cover")
    assert response.status_code == 404
    assert _staging_files(config) == []


def test_book_upload_and_shelf_overflow_create_book(client: TestClient, config, sample_pdf) -> None:
    category = _create(client, "Histoire").json()
    upload = _upload(client, sample_pdf).json()
    response = _save_book(
        client,
        upload["upload_id"],
        category["id"],
        title="  Muqaddimah  ",
        author="Ibn Khaldun",
        notes="",
    )
    assert response.status_code == 201, response.text
    book = response.json()
    assert set(book) == set(BookOutFields)
    book_id = book["id"]
    assert (book["title"], book["author"], book["notes"]) == ("Muqaddimah", "Ibn Khaldun", None)
    assert (book["category_id"], book["reading_direction"]) == (category["id"], "LTR")
    assert (book["page_count"], book["page_width_pt"], book["page_height_pt"]) == (5, 420.0, 595.0)
    assert (book["shelf_number"], book["slot_index"], book["last_read_page"]) == (0, 0, 1)
    assert book["cover_is_custom"] is False and book["file_missing"] is False
    assert book["last_opened_at"] is None
    assert book["file_size_bytes"] == sample_pdf.stat().st_size
    assert len(book["spine_color"]) == 7 and book["spine_color"].startswith("#")

    pdf_path = config.data_dir / "pdfs" / f"book_{book_id}.pdf"
    cover_path = config.data_dir / "covers" / f"book_{book_id}.webp"
    assert pdf_path.read_bytes() == sample_pdf.read_bytes()
    assert cover_path.is_file()
    assert _staging_files(config) == []
    with Session(app_engine(client)) as session:
        row = session.get(Book, book_id)
        assert (row.pdf_rel_path, row.cover_rel_path) == (f"pdfs/book_{book_id}.pdf", f"covers/book_{book_id}.webp")
        assert row.file_sha256 == hashlib.sha256(sample_pdf.read_bytes()).hexdigest()

    cover = client.get(book["cover_url"])
    assert cover.status_code == 200
    assert cover.headers["content-type"] == "image/webp"
    assert "immutable" in cover.headers["cache-control"]
    assert cover.headers.get("etag")
    assert client.get("/api/bootstrap").json()["books"][0]["id"] == book_id
    # The upload is consumed.
    assert _save_book(client, upload["upload_id"], category["id"]).status_code == 404


BookOutFields = {
    "id", "title", "author", "notes", "category_id", "reading_direction", "page_count",
    "page_width_pt", "page_height_pt", "spine_color", "cover_url", "cover_is_custom",
    "file_size_bytes", "file_missing", "last_read_page", "last_opened_at", "shelf_number",
    "slot_index", "created_at", "updated_at",
}


def app_engine(client: TestClient):
    return client.app.state.engine


@pytest.mark.parametrize(
    "fields",
    [
        {"title": None},
        {"title": "   "},
        {"title": "x" * 301},
        {"category_id": None},
        {"category_id": "abc"},
        {"reading_direction": None},
        {"reading_direction": "TTB"},
        {"author": "x" * 201},
        {"notes": "x" * 5001},
        {"upload_id": None},
    ],
)
def test_book_upload_and_shelf_overflow_required_fields(
    client: TestClient, config, sample_pdf, fields: dict
) -> None:
    category = _create(client, "Novels").json()
    upload_id = _upload(client, sample_pdf).json()["upload_id"]
    data = {"upload_id": upload_id, "title": "T", "category_id": str(category["id"]), "reading_direction": "RTL"}
    for key, value in fields.items():
        if value is None:
            data.pop(key)
        else:
            data[key] = value
    response = client.post("/api/books", data=data)
    assert response.status_code == 422, response.text
    # Nothing was consumed or created.
    assert len(_staging_files(config)) == 3
    assert client.get("/api/bootstrap").json()["books"] == []


def test_book_upload_and_shelf_overflow_unknown_references(client: TestClient, config, sample_pdf) -> None:
    category = _create(client, "Novels").json()
    upload_id = _upload(client, sample_pdf).json()["upload_id"]
    unknown_upload = _save_book(client, "0" * 32, category["id"])
    assert unknown_upload.status_code == 404
    assert unknown_upload.json()["detail"]["code"] == "upload_not_found"
    unknown_category = _save_book(client, upload_id, 999)
    assert unknown_category.status_code == 404
    assert unknown_category.json()["detail"]["code"] == "category_not_found"
    # The staged upload survives a failed save and can be retried.
    assert len(_staging_files(config)) == 3
    assert _save_book(client, upload_id, category["id"]).status_code == 201
    assert list((config.data_dir / "covers").iterdir()) != []


def test_book_upload_and_shelf_overflow_custom_cover(client: TestClient, config, sample_pdf) -> None:
    category = _create(client, "Novels").json()
    upload_id = _upload(client, sample_pdf).json()["upload_id"]
    red = pdf_factory.image_bytes("PNG", size=(600, 900), color=(200, 30, 30))
    response = _save_book(client, upload_id, category["id"], files={"cover_file": ("cover.png", red, "image/png")})
    assert response.status_code == 201, response.text
    book = response.json()
    assert book["cover_is_custom"] is True
    r, g, b = (int(book["spine_color"][i : i + 2], 16) for i in (1, 3, 5))
    assert r > 150 and g < 80 and b < 80
    with Image.open(config.data_dir / "covers" / f"book_{book['id']}.webp") as image:
        assert image.format == "WEBP" and image.size == (600, 900)

    big = pdf_factory.image_bytes("JPEG", size=(2400, 3000))
    upload_id = _upload(client, sample_pdf).json()["upload_id"]
    book = _save_book(client, upload_id, category["id"], files={"cover_file": ("c.jpg", big, "image/jpeg")}).json()
    with Image.open(config.data_dir / "covers" / f"book_{book['id']}.webp") as image:
        assert max(image.size) == 1024


@pytest.mark.parametrize(
    "cover",
    [b"not an image at all", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100, b"\xff\xd8\xff" + b"x" * (10 * 1024 * 1024)],
    ids=["text", "corrupt-png", "too-large"],
)
def test_book_upload_and_shelf_overflow_invalid_cover(client: TestClient, config, sample_pdf, cover: bytes) -> None:
    category = _create(client, "Novels").json()
    upload_id = _upload(client, sample_pdf).json()["upload_id"]
    response = _save_book(client, upload_id, category["id"], files={"cover_file": ("c.png", cover, "image/png")})
    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "invalid_cover"
    assert client.get("/api/bootstrap").json()["books"] == []
    assert len(_staging_files(config)) == 3
    assert list((config.data_dir / "covers").iterdir()) == []


def test_book_upload_and_shelf_overflow_source_can_be_deleted(client: TestClient, tmp_path: Path) -> None:
    category = _create(client, "Programming").json()
    source = pdf_factory.text_pdf(tmp_path / "Documents-book.pdf", pages=7)
    upload = _upload(client, source).json()
    source.unlink()  # the user deletes the original from Documents
    book = _save_book(client, upload["upload_id"], category["id"]).json()
    assert client.get(book["cover_url"]).status_code == 200
    assert client.get("/api/bootstrap").json()["books"][0]["page_count"] == 7


def test_book_upload_and_shelf_overflow_duplicate_detection(client: TestClient, sample_pdf) -> None:
    category = _create(client, "Histoire").json()
    first = _import(client, sample_pdf, category["id"])
    again = _upload(client, sample_pdf).json()
    assert again["duplicate_of"] == {"id": first["id"], "title": first["title"]}
    # Importing anyway is allowed.
    assert _save_book(client, again["upload_id"], category["id"]).status_code == 201


def test_book_upload_and_shelf_overflow_31st_book_new_shelf(client: TestClient, sample_pdf) -> None:
    category = _create(client, "Programming").json()
    placements = [
        (book["shelf_number"], book["slot_index"])
        for book in (_import(client, sample_pdf, category["id"]) for _ in range(31))
    ]
    assert placements[:30] == [(0, slot) for slot in range(30)]
    assert placements[30] == (1, 0)


def test_book_upload_and_shelf_overflow_allocate_fills_gap(client: TestClient, app) -> None:
    from app.database import immediate_session
    from app.shelving import allocate_slot

    category = _create(client, "Histoire").json()
    slots = [(0, s) for s in range(30) if s != 7] + [(1, 0), (1, 1)]
    _insert_books(app, category["id"], slots)
    with immediate_session(app.state.engine) as session:
        assert allocate_slot(session, category["id"]) == (0, 7)


def test_book_upload_and_shelf_overflow_new_book_fills_freed_slot(client: TestClient, app, sample_pdf) -> None:
    category = _create(client, "Novels").json()
    _insert_books(app, category["id"], [(0, s) for s in range(30) if s != 4])
    book = _import(client, sample_pdf, category["id"])
    assert (book["shelf_number"], book["slot_index"]) == (0, 4)


def test_book_upload_and_shelf_overflow_cover_self_repair(client: TestClient, config, sample_pdf) -> None:
    category = _create(client, "Novels").json()
    book = _import(client, sample_pdf, category["id"])
    cover_path = config.data_dir / "covers" / f"book_{book['id']}.webp"
    cover_path.unlink()
    assert client.get(book["cover_url"]).status_code == 200
    assert cover_path.is_file()
    cover_path.unlink()
    (config.data_dir / "pdfs" / f"book_{book['id']}.pdf").unlink()
    response = client.get(book["cover_url"])
    assert response.status_code == 410
    assert response.json()["detail"]["code"] == "pdf_missing"
    assert client.get("/api/books/999/cover").json()["detail"]["code"] == "book_not_found"


def test_book_upload_and_shelf_overflow_scanned_400_pages_under_1_5_s(client: TestClient, scanned_400: Path) -> None:
    response = _upload(client, scanned_400)
    assert response.status_code == 201, response.text
    assert response.json()["page_count"] == 400
    server_ms = float(response.headers["server-timing"].split("dur=")[1])
    print(f"\n400-page scanned PDF ({scanned_400.stat().st_size / 1e6:.1f} MB): import {server_ms:.0f} ms")
    assert server_ms < 1500


# ---------------------------------------------------------------------------
# US-04: page streaming (low/high/zoom), cache, edit/delete, startup reconciliation
# ---------------------------------------------------------------------------

import time as _time  # noqa: E402

from app.cache import PageCache  # noqa: E402
from app.maintenance import reconcile  # noqa: E402
from app.render_pool import RenderJob, RenderPool  # noqa: E402


@pytest.fixture
def stored_book(client: TestClient, tmp_path: Path) -> dict:
    """An imported 12-page A4 book."""
    category = _create(client, "Programming").json()
    pdf = pdf_factory.text_pdf(tmp_path / "twelve.pdf", pages=12, title="Twelve Pages")
    return _import(client, pdf, category["id"])


def _page(client: TestClient, book_id: int, page: int, quality: str | None = "high", **kwargs):
    query = f"?quality={quality}" if quality else ""
    return client.get(f"/api/books/{book_id}/page/{page}{query}", **kwargs)


def _image_size(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as image:
        assert image.format == "WEBP"
        return image.size


def _files_mentioning(root: Path, needle: str) -> list[str]:
    return [str(p.relative_to(root)) for p in root.rglob("*") if needle in p.as_posix()]


def test_page_streaming_qualities(client: TestClient, stored_book: dict) -> None:
    for quality, long_side in (("low", 768), ("high", 2048), ("zoom", 4096)):
        response = _page(client, stored_book["id"], 1, quality)
        assert response.status_code == 200, response.text
        assert response.headers["content-type"] == "image/webp"
        width, height = _image_size(response.content)
        # MuPDF rounds a partially covered pixel up, so allow one pixel of difference.
        assert height == long_side and abs(width - long_side * 595 / 842) <= 1, quality
    default = _page(client, stored_book["id"], 2, None)
    assert max(_image_size(default.content)) == 2048


def test_page_streaming_render_limits(client: TestClient, tmp_path: Path) -> None:
    category = _create(client, "Odd sizes").json()
    huge = _import(client, pdf_factory.text_pdf(tmp_path / "huge.pdf", 1, page_size=(14400, 14400)), category["id"])
    width, height = _image_size(_page(client, huge["id"], 1, "zoom").content)
    assert max(width, height) <= 4096 and width * height <= 16_800_000
    wide = _import(client, pdf_factory.text_pdf(tmp_path / "wide.pdf", 1, page_size=(3000, 200)), category["id"])
    width, height = _image_size(_page(client, wide["id"], 1, "zoom").content)
    assert width == 4096 and abs(height - 4096 * 200 / 3000) <= 1
    rotated = _import(client, pdf_factory.text_pdf(tmp_path / "rot.pdf", 1, rotate=90), category["id"])
    assert (rotated["page_width_pt"], rotated["page_height_pt"]) == (842.0, 595.0)
    width, height = _image_size(_page(client, rotated["id"], 1, "low").content)
    assert width == 768 and width > height


def test_page_streaming_errors(client: TestClient, config, stored_book: dict) -> None:
    book_id = stored_book["id"]
    for page in (0, 13):
        response = _page(client, book_id, page)
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "page_out_of_range"
    assert _page(client, book_id, 1, "ultra").status_code == 422
    assert _page(client, 999, 1).json()["detail"]["code"] == "book_not_found"
    (config.data_dir / "pdfs" / f"book_{book_id}.pdf").unlink()
    response = _page(client, book_id, 1)
    assert response.status_code == 410
    assert response.json()["detail"]["code"] == "pdf_missing"


def test_page_streaming_cache_and_headers(client: TestClient, config, stored_book: dict) -> None:
    book_id = stored_book["id"]
    cached = config.data_dir / "cache" / f"book_{book_id}" / "high" / "5.webp"
    assert not cached.exists()
    first = _page(client, book_id, 5)
    assert first.headers["server-timing"].startswith("render;dur=")
    assert cached.read_bytes() == first.content
    second = _page(client, book_id, 5)
    assert second.content == first.content
    assert second.headers["server-timing"].startswith("cache;dur=")
    assert second.headers["etag"] == first.headers["etag"] == f'"{book_id}-high-5"'
    assert "immutable" in second.headers["cache-control"]
    not_modified = _page(client, book_id, 5, headers={"If-None-Match": first.headers["etag"]})
    assert not_modified.status_code == 304 and not_modified.content == b""


def test_page_streaming_prefetch(client: TestClient, config, stored_book: dict) -> None:
    book_id = stored_book["id"]
    _page(client, book_id, 3, "low")
    assert client.app.state.render_pool.drain(timeout=60)
    cache_dir = config.data_dir / "cache" / f"book_{book_id}"
    low = sorted(int(p.stem) for p in (cache_dir / "low").glob("*.webp"))
    high = sorted(int(p.stem) for p in (cache_dir / "high").glob("*.webp"))
    assert low == [3, 4, 5, 6, 7, 8, 9]
    assert high == [4, 5]
    # Near the end, prefetch stops at the last page.
    _page(client, book_id, 11, "low")
    assert client.app.state.render_pool.drain(timeout=60)
    assert max(int(p.stem) for p in (cache_dir / "low").glob("*.webp")) == 12


def test_page_streaming_prefetch_queue_cancels_on_jump(tmp_path: Path) -> None:
    cache = PageCache(tmp_path / "cache", 10 * 1024 * 1024)
    pool = RenderPool(0, cache, autostart_prefetch=False)
    try:
        pool.schedule_prefetch(1, "/tmp/a.pdf", 10, 500)
        pool.schedule_prefetch(2, "/tmp/b.pdf", 1, 500)
        assert sorted((j.quality, j.page) for j in pool.pending() if j.book_id == 1) == sorted(
            [("low", n) for n in range(11, 17)] + [("high", 11), ("high", 12)]
        )
        pool.schedule_prefetch(1, "/tmp/a.pdf", 200, 500)  # the user jumped
        pages = {j.page for j in pool.pending() if j.book_id == 1}
        assert pages == set(range(201, 207))
        assert {j.page for j in pool.pending() if j.book_id == 2} == set(range(2, 8))
        pool.cancel_book(2)
        assert all(j.book_id == 1 for j in pool.pending())
    finally:
        pool.close()


def test_page_streaming_cache_lru_eviction(tmp_path: Path) -> None:
    cache = PageCache(tmp_path / "cache", limit_bytes=10_000)
    for page in range(1, 6):
        cache.put(1, "low", page, b"x" * 2_000)
        old = _time.time() - 100 + page
        os.utime(cache.path(1, "low", page), (old, old))
    assert cache.total_bytes == 10_000
    assert cache.get(1, "low", 1) is not None  # page 1 becomes the most recently used
    cache.put(1, "low", 6, b"x" * 2_000)  # 12 000 bytes > limit: evict to 9 000
    remaining = sorted(int(p.stem) for p in (tmp_path / "cache" / "book_1" / "low").glob("*.webp"))
    assert remaining == [1, 4, 5, 6]
    assert cache.total_bytes == 8_000
    cache.remove_book(1)
    assert cache.total_bytes == 0 and not (tmp_path / "cache" / "book_1").exists()
    # A restarted cache counts what is on disk.
    cache.put(2, "high", 1, b"y" * 500)
    assert PageCache(tmp_path / "cache", 10_000).total_bytes == 500


def test_page_streaming_cache_limit_through_api(tmp_path: Path) -> None:
    tiny = AppConfig(data_dir=tmp_path / "lib", render_workers=0, cache_limit_mb=1)
    with TestClient(create_app(tiny), base_url="http://127.0.0.1:8000", headers={"X-Dar-Client": "1"}) as c:
        category = _create(c, "Big").json()
        book = _import(c, pdf_factory.scanned_pdf(tmp_path / "scan.pdf", pages=6, distinct_scans=6), category["id"])
        for page in range(1, 7):
            assert _page(c, book["id"], page, "zoom").status_code == 200
        assert c.app.state.render_pool.drain(timeout=120)
        assert c.app.state.page_cache.total_bytes <= 1024 * 1024


def test_page_streaming_worker_processes(tmp_path: Path) -> None:
    pooled = AppConfig(data_dir=tmp_path / "lib", render_workers=1)
    with TestClient(create_app(pooled), base_url="http://127.0.0.1:8000", headers={"X-Dar-Client": "1"}) as c:
        category = _create(c, "Pooled").json()
        book = _import(c, pdf_factory.text_pdf(tmp_path / "p.pdf", 4), category["id"])
        response = _page(c, book["id"], 2, "low")
        assert response.status_code == 200
        assert max(_image_size(response.content)) == 768
        assert _page(c, book["id"], 9, "low").json()["detail"]["code"] == "page_out_of_range"
        assert c.app.state.render_pool.drain(timeout=120)


def test_book_edit_and_delete_metadata(client: TestClient, stored_book: dict) -> None:
    book_id = stored_book["id"]
    response = client.patch(
        f"/api/books/{book_id}",
        json={"title": "  Twelve  ", "author": "Anonymous", "notes": "Margins", "reading_direction": "RTL"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["title"], body["author"], body["notes"], body["reading_direction"]) == (
        "Twelve", "Anonymous", "Margins", "RTL",
    )
    assert body["cover_url"] != stored_book["cover_url"]  # metadata change bumps updated_at
    cleared = client.patch(f"/api/books/{book_id}", json={"author": None, "notes": ""}).json()
    assert (cleared["author"], cleared["notes"]) == (None, None)
    assert client.patch("/api/books/999", json={"title": "x"}).json()["detail"]["code"] == "book_not_found"


@pytest.mark.parametrize(
    "body",
    [
        {"title": None},
        {"title": "  "},
        {"title": "x" * 301},
        {"reading_direction": "TTB"},
        {"last_read_page": 0},
        {"last_read_page": 13},
        {"category_id": None},
        {"mark_opened": None},
        {"unknown": 1},
    ],
)
def test_book_edit_and_delete_invalid_patch(client: TestClient, stored_book: dict, body: dict) -> None:
    assert client.patch(f"/api/books/{stored_book['id']}", json=body).status_code == 422
    unchanged = client.get("/api/bootstrap").json()["books"][0]
    assert (unchanged["title"], unchanged["last_read_page"]) == (stored_book["title"], 1)


def test_book_edit_and_delete_bookmark_and_desk(client: TestClient, tmp_path: Path) -> None:
    category = _create(client, "Desk").json()
    pdf = pdf_factory.text_pdf(tmp_path / "d.pdf", pages=20)
    ids = [_import(client, pdf, category["id"])["id"] for _ in range(4)]
    for book_id in (ids[2], ids[0], ids[3], ids[1], ids[3]):  # opened in this order
        response = client.patch(f"/api/books/{book_id}", json={"mark_opened": True})
        assert response.status_code == 200
    assert client.get("/api/bootstrap").json()["currently_reading"] == [ids[3], ids[1], ids[0]]
    saved = client.patch(f"/api/books/{ids[0]}", json={"last_read_page": 20}).json()
    assert saved["last_read_page"] == 20
    assert saved["cover_url"].endswith(  # reading progress does not bust the cover cache
        client.get("/api/bootstrap").json()["books"][0]["cover_url"].rsplit("?", 1)[1]
    )
    times = [client.get("/api/bootstrap").json()["books"][i]["last_opened_at"] for i in range(4)]
    assert all(t is not None for t in times)


def test_book_edit_and_delete_change_category(client: TestClient, app, stored_book: dict, tmp_path: Path) -> None:
    source_id = stored_book["category_id"]
    target = _create(client, "Histoire").json()
    _insert_books(app, target["id"], [(0, 0), (0, 1), (0, 3)])
    moved = client.patch(f"/api/books/{stored_book['id']}", json={"category_id": target["id"]})
    assert moved.status_code == 200
    assert (moved.json()["category_id"], moved.json()["shelf_number"], moved.json()["slot_index"]) == (
        target["id"], 0, 2,
    )
    # The freed slot in the old category is reused by the next import there.
    newcomer = _import(client, pdf_factory.text_pdf(tmp_path / "n.pdf", 2), source_id)
    assert (newcomer["shelf_number"], newcomer["slot_index"]) == (0, 0)
    same = client.patch(f"/api/books/{stored_book['id']}", json={"category_id": target["id"]}).json()
    assert (same["shelf_number"], same["slot_index"]) == (0, 2)
    missing = client.patch(f"/api/books/{stored_book['id']}", json={"category_id": 999})
    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "category_not_found"


def test_book_edit_and_delete_cover_replace_and_revert(client: TestClient, config, stored_book: dict) -> None:
    book_id = stored_book["id"]
    blue = pdf_factory.image_bytes("PNG", size=(500, 700), color=(30, 60, 200))
    replaced = client.put(f"/api/books/{book_id}/cover", files={"cover_file": ("c.png", blue, "image/png")})
    assert replaced.status_code == 200, replaced.text
    body = replaced.json()
    assert body["cover_is_custom"] is True
    assert body["cover_url"] != stored_book["cover_url"]
    r, g, b = (int(body["spine_color"][i : i + 2], 16) for i in (1, 3, 5))
    assert b > 150 and r < 80
    with Image.open(config.data_dir / "covers" / f"book_{book_id}.webp") as image:
        assert image.size == (500, 700)

    reverted = client.delete(f"/api/books/{book_id}/cover")
    assert reverted.status_code == 200
    assert reverted.json()["cover_is_custom"] is False
    assert reverted.json()["cover_url"] not in (stored_book["cover_url"], body["cover_url"])
    with Image.open(config.data_dir / "covers" / f"book_{book_id}.webp") as image:
        assert max(image.size) == 1024

    bad = client.put(f"/api/books/{book_id}/cover", files={"cover_file": ("c.png", b"nope", "image/png")})
    assert bad.status_code == 415 and bad.json()["detail"]["code"] == "invalid_cover"
    assert client.put(f"/api/books/{book_id}/cover").status_code == 422
    assert client.delete("/api/books/999/cover").json()["detail"]["code"] == "book_not_found"


def test_book_edit_and_delete_leaves_zero_files(client: TestClient, config, stored_book: dict) -> None:
    book_id = stored_book["id"]
    client.patch(f"/api/books/{book_id}", json={"mark_opened": True})
    for quality in ("low", "high", "zoom"):
        _page(client, book_id, 1, quality)
    assert client.app.state.render_pool.drain(timeout=60)
    assert _files_mentioning(config.data_dir, f"book_{book_id}")

    response = client.delete(f"/api/books/{book_id}")
    assert response.status_code == 204
    assert _files_mentioning(config.data_dir, f"book_{book_id}") == []
    data = client.get("/api/bootstrap").json()
    assert data["books"] == [] and data["currently_reading"] == []
    assert data["categories"][0]["book_count"] == 0
    assert client.delete(f"/api/books/{book_id}").json()["detail"]["code"] == "book_not_found"
    assert _page(client, book_id, 1).status_code == 404


def test_book_edit_and_delete_bootstrap_lists_books(client: TestClient, stored_book: dict) -> None:
    data = client.get("/api/bootstrap").json()
    assert [b["id"] for b in data["books"]] == [stored_book["id"]]
    assert data["books"][0] == stored_book


def test_startup_reconcile_removes_orphans(config, tmp_path: Path) -> None:
    app = create_app(config)
    with TestClient(app, base_url="http://127.0.0.1:8000", headers={"X-Dar-Client": "1"}) as c:
        category = _create(c, "Keep").json()
        kept = _import(c, pdf_factory.text_pdf(tmp_path / "k.pdf", 3), category["id"])
        gone = _import(c, pdf_factory.text_pdf(tmp_path / "g.pdf", 3), category["id"])
        _page(c, kept["id"], 1, "low")
        fresh_upload = _upload(c, pdf_factory.text_pdf(tmp_path / "u.pdf", 1)).json()["upload_id"]
        assert c.app.state.render_pool.drain(timeout=60)

    data = config.data_dir
    (data / "pdfs" / f"book_{gone['id']}.pdf").unlink()  # the user deleted a PDF by hand
    (data / "pdfs" / "book_999.pdf").write_bytes(b"%PDF-orphan")
    (data / "covers" / "book_999.webp").write_bytes(b"orphan")
    (data / "cache" / "book_999" / "low").mkdir(parents=True)
    (data / "cache" / "book_999" / "low" / "1.webp").write_bytes(b"orphan")
    (data / "pdfs" / ".tmp-crash.pdf").write_bytes(b"half")
    (data / "pdfs" / "my-notes.txt").write_text("not ours")
    stale_id = "a" * 32
    for ext in (".pdf", ".webp", ".json"):
        stale = data / "staging" / f"{stale_id}{ext}"
        stale.write_bytes(b"{}")
        old = _time.time() - 2 * 24 * 3600
        os.utime(stale, (old, old))
    (data / "staging" / f"{'b' * 32}.pdf").write_bytes(b"%PDF-incomplete")

    engine = init_db(config)
    try:
        report = reconcile(data, engine)
    finally:
        engine.dispose()
    assert (report.pdfs_removed, report.covers_removed, report.cache_dirs_removed) == (1, 1, 1)
    assert report.temp_removed == 1
    assert report.staging_removed == 4
    assert report.missing_pdfs == [gone["id"]]
    assert not (data / "pdfs" / "book_999.pdf").exists()
    assert not (data / "cache" / "book_999").exists()
    assert (data / "pdfs" / "my-notes.txt").exists()
    assert (data / "pdfs" / f"book_{kept['id']}.pdf").exists()
    assert (data / "cache" / f"book_{kept['id']}" / "low" / "1.webp").exists()
    assert sorted(p.stem for p in (data / "staging").iterdir()) == [fresh_upload] * 3

    # On a real restart the same cleanup runs, and the missing PDF is flagged.
    with TestClient(create_app(config), base_url="http://127.0.0.1:8000") as c:
        books = {b["id"]: b for b in c.get("/api/bootstrap").json()["books"]}
        assert books[gone["id"]]["file_missing"] is True
        assert books[kept["id"]]["file_missing"] is False
