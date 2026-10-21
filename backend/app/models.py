"""SQLModel table definitions (docs/ARCHITECTURE.md section 5).

Timestamps are naive datetimes in UTC. They are stored as ISO 8601 text
(`2026-10-21T18:04:05Z`); values written by SQLite's CURRENT_TIMESTAMP default
(`2026-10-21 18:04:05`) are read back correctly as well.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    REAL,
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.sqlite import DATETIME
from sqlmodel import Field, SQLModel

UTCDateTime = DATETIME(
    storage_format="%(year)04d-%(month)02d-%(day)02dT%(hour)02d:%(minute)02d:%(second)02dZ",
    regexp=r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})",
)


def utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None, microsecond=0)


def _created_at_column() -> Column:
    return Column(UTCDateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class Category(SQLModel, table=True):
    __tablename__ = "category"
    __table_args__ = (
        CheckConstraint("length(name) BETWEEN 1 AND 40", name="ck_category_name_length"),
        CheckConstraint("column_index >= 0", name="ck_category_column_index"),
        {"sqlite_autoincrement": True},
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(sa_column=Column(Text, nullable=False))
    # casefold(NFC(trim(name))): case-insensitive, accent-aware uniqueness.
    name_key: str = Field(sa_column=Column(Text, nullable=False, unique=True))
    column_index: int = Field(sa_column=Column(Integer, nullable=False))
    created_at: datetime = Field(default_factory=utc_now, sa_column=_created_at_column())


class Book(SQLModel, table=True):
    __tablename__ = "book"
    __table_args__ = (
        UniqueConstraint("category_id", "shelf_number", "slot_index", name="uq_book_slot"),
        CheckConstraint("length(title) BETWEEN 1 AND 300", name="ck_book_title_length"),
        CheckConstraint("reading_direction IN ('LTR', 'RTL')", name="ck_book_reading_direction"),
        CheckConstraint("author IS NULL OR length(author) <= 200", name="ck_book_author_length"),
        CheckConstraint("notes IS NULL OR length(notes) <= 5000", name="ck_book_notes_length"),
        CheckConstraint("page_count > 0", name="ck_book_page_count"),
        CheckConstraint("page_width_pt > 0", name="ck_book_page_width"),
        CheckConstraint("page_height_pt > 0", name="ck_book_page_height"),
        CheckConstraint(
            "length(spine_color) = 7 AND spine_color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]"
            "[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'",
            name="ck_book_spine_color",
        ),
        CheckConstraint("file_size_bytes >= 0", name="ck_book_file_size"),
        CheckConstraint("last_read_page >= 1", name="ck_book_last_read_page"),
        CheckConstraint("shelf_number >= 0", name="ck_book_shelf_number"),
        CheckConstraint("slot_index BETWEEN 0 AND 29", name="ck_book_slot_index"),
        # Book IDs are never reused, so rendered pages can be cached as immutable.
        {"sqlite_autoincrement": True},
    )

    id: int | None = Field(default=None, primary_key=True)
    title: str = Field(sa_column=Column(Text, nullable=False))
    category_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("category.id", ondelete="RESTRICT"),
            nullable=False,
            index=True,
        )
    )
    reading_direction: str = Field(
        default="LTR", sa_column=Column(Text, nullable=False, server_default=text("'LTR'"))
    )
    author: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    notes: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    pdf_rel_path: str = Field(sa_column=Column(Text, nullable=False))
    cover_rel_path: str = Field(sa_column=Column(Text, nullable=False))
    cover_is_custom: bool = Field(
        default=False, sa_column=Column(Boolean, nullable=False, server_default=text("0"))
    )
    page_count: int = Field(sa_column=Column(Integer, nullable=False))
    page_width_pt: float = Field(sa_column=Column(REAL, nullable=False))
    page_height_pt: float = Field(sa_column=Column(REAL, nullable=False))
    spine_color: str = Field(sa_column=Column(Text, nullable=False))
    file_sha256: str = Field(sa_column=Column(Text, nullable=False, index=True))
    file_size_bytes: int = Field(sa_column=Column(Integer, nullable=False))
    last_read_page: int = Field(
        default=1, sa_column=Column(Integer, nullable=False, server_default=text("1"))
    )
    last_opened_at: datetime | None = Field(
        default=None, sa_column=Column(UTCDateTime, nullable=True, index=True)
    )
    shelf_number: int = Field(sa_column=Column(Integer, nullable=False))
    slot_index: int = Field(sa_column=Column(Integer, nullable=False))
    created_at: datetime = Field(default_factory=utc_now, sa_column=_created_at_column())
    updated_at: datetime = Field(
        default_factory=utc_now, sa_column=Column(UTCDateTime, nullable=False)
    )


class AppSetting(SQLModel, table=True):
    __tablename__ = "app_setting"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_app_setting_singleton"),
        CheckConstraint("ui_language IN ('en', 'ar')", name="ck_app_setting_ui_language"),
        CheckConstraint(
            "default_direction IN ('LTR', 'RTL')", name="ck_app_setting_default_direction"
        ),
        CheckConstraint(
            "graphics_quality IN ('auto', 'performance', 'high')",
            name="ck_app_setting_graphics_quality",
        ),
        CheckConstraint(
            "ambient_light BETWEEN 0.4 AND 1.5", name="ck_app_setting_ambient_light"
        ),
    )

    id: int = Field(default=1, sa_column=Column(Integer, primary_key=True, autoincrement=False))
    ui_language: str = Field(
        default="en", sa_column=Column(Text, nullable=False, server_default=text("'en'"))
    )
    default_direction: str = Field(
        default="LTR", sa_column=Column(Text, nullable=False, server_default=text("'LTR'"))
    )
    graphics_quality: str = Field(
        default="auto", sa_column=Column(Text, nullable=False, server_default=text("'auto'"))
    )
    ambient_light: float = Field(
        default=1.0, sa_column=Column(REAL, nullable=False, server_default=text("1.0"))
    )
