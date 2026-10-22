"""Runtime configuration: data directory resolution and environment variables.

See docs/ARCHITECTURE.md section 4 for the storage layout and section 4.1 for the
environment variables.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

# backend/app/config.py -> parents[0] = backend/app, [1] = backend, [2] = repository root.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATA_DIR = REPO_ROOT / "library_data"

DATA_SUBDIRS = ("pdfs", "covers", "cache", "staging")
DB_FILENAME = "library.db"
API_VERSION = 1


def default_render_workers() -> int:
    return min(4, max(1, (os.cpu_count() or 2) - 1))


@dataclass(frozen=True)
class AppConfig:
    data_dir: Path
    port: int = 8000
    render_workers: int = field(default_factory=default_render_workers)
    cache_limit_mb: int = 1024
    max_upload_mb: int = 2048
    dev_origin: str = "http://127.0.0.1:3000"

    @property
    def db_path(self) -> Path:
        return self.data_dir / DB_FILENAME


def resolve_data_dir(env: Mapping[str, str] = os.environ) -> Path:
    """Return the data directory: DAR_DATA_DIR if set, else <repo>/library_data.

    The default never depends on the current working directory.
    """
    value = env.get("DAR_DATA_DIR", "").strip()
    if value:
        return Path(value).expanduser().resolve()
    return DEFAULT_DATA_DIR


def _int_env(env: Mapping[str, str], name: str, default: int, minimum: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


def load_config(env: Mapping[str, str] = os.environ) -> AppConfig:
    """Build the configuration from environment variables (docs/ARCHITECTURE.md 4.1)."""
    return AppConfig(
        data_dir=resolve_data_dir(env),
        port=_int_env(env, "DAR_PORT", 8000, minimum=1),
        render_workers=_int_env(env, "DAR_RENDER_WORKERS", default_render_workers(), minimum=0),
        cache_limit_mb=_int_env(env, "DAR_CACHE_LIMIT_MB", 1024, minimum=1),
        max_upload_mb=_int_env(env, "DAR_MAX_UPLOAD_MB", 2048, minimum=1),
        dev_origin=env.get("DAR_DEV_ORIGIN", "http://127.0.0.1:3000").strip(),
    )
