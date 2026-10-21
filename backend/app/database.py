"""SQLite engine, data folder initialization and schema migrations.

Every connection runs `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`
(docs/ARCHITECTURE.md section 5). The schema version lives in
`PRAGMA user_version` (section 5.4).
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import Request
from sqlalchemy import Connection, Engine, event
from sqlmodel import Session, SQLModel, create_engine

from app import models  # noqa: F401  (registers the tables on SQLModel.metadata)
from app.config import DATA_SUBDIRS, AppConfig

SCHEMA_VERSION = 1

Migration = Callable[[Connection], None]

# MIGRATIONS[n - 1] upgrades schema version n to n + 1. Migrations must preserve user data.
MIGRATIONS: list[Migration] = []

assert len(MIGRATIONS) == SCHEMA_VERSION - 1, "one migration per schema version step"

# Connection.info key consumed by the "begin" listener to emit BEGIN IMMEDIATE.
_BEGIN_IMMEDIATE = "dar_begin_immediate"


class SchemaTooNewError(RuntimeError):
    """The database was written by a newer version of the application."""


def create_db_engine(db_path: Path) -> Engine:
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_connection, _connection_record) -> None:
        # Let SQLAlchemy emit BEGIN itself (see _on_begin) instead of the sqlite3 module.
        dbapi_connection.isolation_level = None
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()

    @event.listens_for(engine, "begin")
    def _on_begin(connection: Connection) -> None:
        immediate = connection.info.pop(_BEGIN_IMMEDIATE, False)
        connection.exec_driver_sql("BEGIN IMMEDIATE" if immediate else "BEGIN")

    return engine


def _migrate(connection: Connection) -> None:
    version = connection.exec_driver_sql("PRAGMA user_version").scalar_one()
    if version > SCHEMA_VERSION:
        raise SchemaTooNewError(
            f"library.db has schema version {version}; this application supports "
            f"up to {SCHEMA_VERSION}. Update the application."
        )
    if version == 0:
        SQLModel.metadata.create_all(connection)
        connection.exec_driver_sql(f"PRAGMA user_version = {SCHEMA_VERSION}")
        return
    for current in range(version, SCHEMA_VERSION):
        MIGRATIONS[current - 1](connection)
        connection.exec_driver_sql(f"PRAGMA user_version = {current + 1}")


def init_db(config: AppConfig) -> Engine:
    """Create the data folders and the database, run migrations, return the engine."""
    config.data_dir.mkdir(parents=True, exist_ok=True)
    for name in DATA_SUBDIRS:
        (config.data_dir / name).mkdir(exist_ok=True)

    engine = create_db_engine(config.db_path)
    try:
        with engine.begin() as connection:
            _migrate(connection)
            connection.exec_driver_sql("INSERT OR IGNORE INTO app_setting (id) VALUES (1)")
    except BaseException:
        engine.dispose()
        raise
    return engine


@contextmanager
def immediate_session(engine: Engine) -> Iterator[Session]:
    """Session in a transaction opened with BEGIN IMMEDIATE.

    The write lock is taken up front, so read-then-write logic (such as shelf slot
    allocation) cannot race with another writer. Commits on normal exit, rolls back
    on an exception.
    """
    with engine.connect() as connection:
        connection.info[_BEGIN_IMMEDIATE] = True
        with connection.begin():
            session = Session(bind=connection)
            try:
                yield session
                session.flush()
            finally:
                session.close()


def get_session(request: Request) -> Iterator[Session]:
    """FastAPI dependency: a session bound to the application's engine."""
    with Session(request.app.state.engine) as session:
        yield session
