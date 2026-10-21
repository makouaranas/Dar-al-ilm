"""API request and response shapes (docs/ARCHITECTURE.md section 6.2) and serializers."""

from __future__ import annotations

import calendar
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import AppSetting, Book, Category

CATEGORY_NAME_MAX = 40

UiLanguage = Literal["en", "ar"]
ReadingDirection = Literal["LTR", "RTL"]
GraphicsQuality = Literal["auto", "performance", "high"]


def iso_utc(value: datetime | None) -> str | None:
    """Naive UTC datetime -> `2026-10-21T18:04:05Z`."""
    return None if value is None else value.strftime("%Y-%m-%dT%H:%M:%SZ")


def unix_seconds(value: datetime) -> int:
    return calendar.timegm(value.utctimetuple())


def normalize_category_name(name: str) -> str:
    return unicodedata.normalize("NFC", name.strip())


def category_name_key(name: str) -> str:
    """casefold(NFC(trim(name))): case-insensitive, accent-aware uniqueness key."""
    return normalize_category_name(name).casefold()


# --- Requests -----------------------------------------------------------------------


class CategoryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str

    @field_validator("name")
    @classmethod
    def _normalize(cls, value: str) -> str:
        value = normalize_category_name(value)
        if not 1 <= len(value) <= CATEGORY_NAME_MAX:
            raise ValueError(f"name must be 1 to {CATEGORY_NAME_MAX} characters after trimming")
        return value


class SettingsPatch(BaseModel):
    """Partial settings update. Omitted fields stay unchanged; null is rejected."""

    model_config = ConfigDict(extra="forbid")

    ui_language: UiLanguage | None = None
    default_direction: ReadingDirection | None = None
    graphics_quality: GraphicsQuality | None = None
    ambient_light: float | None = Field(default=None, ge=0.4, le=1.5, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nulls = [key for key, value in data.items() if value is None]
            if nulls:
                raise ValueError(f"fields cannot be null: {', '.join(sorted(nulls))}")
        return data


class BookPatch(BaseModel):
    """Partial book update. `author` and `notes` may be null (cleared); other fields may not."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    author: str | None = None
    notes: str | None = None
    category_id: int | None = None
    reading_direction: ReadingDirection | None = None
    last_read_page: int | None = Field(default=None, ge=1)
    mark_opened: bool | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_null(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nullable = {"author", "notes"}
            nulls = [key for key, value in data.items() if value is None and key not in nullable]
            if nulls:
                raise ValueError(f"fields cannot be null: {', '.join(sorted(nulls))}")
        return data


# --- Responses ----------------------------------------------------------------------


class CategoryOut(BaseModel):
    id: int
    name: str
    column_index: int
    book_count: int
    created_at: str


class BookOut(BaseModel):
    id: int
    title: str
    author: str | None
    notes: str | None
    category_id: int
    reading_direction: ReadingDirection
    page_count: int
    page_width_pt: float
    page_height_pt: float
    spine_color: str
    cover_url: str
    cover_is_custom: bool
    file_size_bytes: int
    file_missing: bool
    last_read_page: int
    last_opened_at: str | None
    shelf_number: int
    slot_index: int
    created_at: str
    updated_at: str


class SettingsOut(BaseModel):
    ui_language: UiLanguage
    default_direction: ReadingDirection
    graphics_quality: GraphicsQuality
    ambient_light: float


class DuplicateRef(BaseModel):
    id: int
    title: str


class UploadOut(BaseModel):
    upload_id: str
    original_filename: str
    file_size_bytes: int
    page_count: int
    page_width_pt: float
    page_height_pt: float
    suggested_title: str
    suggested_direction: ReadingDirection
    cover_preview_url: str
    duplicate_of: DuplicateRef | None
    expires_at: str


class BootstrapOut(BaseModel):
    categories: list[CategoryOut]
    books: list[BookOut]
    currently_reading: list[int]
    settings: SettingsOut
    api_version: int


def category_out(category: Category, book_count: int) -> CategoryOut:
    assert category.id is not None
    return CategoryOut(
        id=category.id,
        name=category.name,
        column_index=category.column_index,
        book_count=book_count,
        created_at=iso_utc(category.created_at) or "",
    )


def book_out(book: Book, data_dir: Path) -> BookOut:
    assert book.id is not None
    return BookOut(
        id=book.id,
        title=book.title,
        author=book.author,
        notes=book.notes,
        category_id=book.category_id,
        reading_direction=book.reading_direction,  # type: ignore[arg-type]
        page_count=book.page_count,
        page_width_pt=book.page_width_pt,
        page_height_pt=book.page_height_pt,
        spine_color=book.spine_color,
        cover_url=f"/api/books/{book.id}/cover?v={unix_seconds(book.updated_at)}",
        cover_is_custom=book.cover_is_custom,
        file_size_bytes=book.file_size_bytes,
        # Computed at runtime so it is always current (docs/ARCHITECTURE.md section 5.2).
        file_missing=not (data_dir / book.pdf_rel_path).is_file(),
        last_read_page=book.last_read_page,
        last_opened_at=iso_utc(book.last_opened_at),
        shelf_number=book.shelf_number,
        slot_index=book.slot_index,
        created_at=iso_utc(book.created_at) or "",
        updated_at=iso_utc(book.updated_at) or "",
    )


def settings_out(setting: AppSetting) -> SettingsOut:
    return SettingsOut(
        ui_language=setting.ui_language,  # type: ignore[arg-type]
        default_direction=setting.default_direction,  # type: ignore[arg-type]
        graphics_quality=setting.graphics_quality,  # type: ignore[arg-type]
        ambient_light=setting.ambient_light,
    )
