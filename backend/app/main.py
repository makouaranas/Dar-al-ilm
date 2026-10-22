"""FastAPI application factory for Dar al Ilm.

Run with: `uvicorn app.main:app --host 127.0.0.1 --port 8000` from `backend/`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import Response
from starlette.types import Scope

from app.cache import PageCache
from app.config import REPO_ROOT, AppConfig, load_config
from app.database import init_db
from app.maintenance import reconcile
from app.render_pool import RenderPool
from app.routers import bootstrap, books, categories, health, settings, uploads
from app.security import (
    ALLOWED_HOSTS,
    ApiError,
    ClientGuardMiddleware,
    allowed_origins,
    error_body,
)


FRONTEND_DIR = REPO_ROOT / "frontend" / "out"


class FrontendFiles(StaticFiles):
    """The static Next.js export. Unknown non-/api paths fall back to index.html."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or path == "api" or path.startswith("api/"):
                raise
            return FileResponse(Path(str(self.directory)) / "index.html")


def create_app(config: AppConfig | None = None, frontend_dir: Path | None = FRONTEND_DIR) -> FastAPI:
    config = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = init_db(config)
        reconcile(config.data_dir, app.state.engine)
        app.state.page_cache = PageCache(config.data_dir / "cache", config.cache_limit_mb * 1024 * 1024)
        app.state.render_pool = RenderPool(config.render_workers, app.state.page_cache)
        try:
            yield
        finally:
            app.state.render_pool.close()
            app.state.engine.dispose()

    # The interactive /docs and /redoc pages load Swagger UI and ReDoc from a CDN, which
    # the offline rule forbids. The OpenAPI schema stays available at /openapi.json.
    app = FastAPI(
        title="Dar al Ilm API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    app.state.config = config

    for module in (health, bootstrap, categories, settings, uploads, books):
        app.include_router(module.router, prefix="/api")

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            error_body(exc.code, exc.message, **exc.extra), status_code=exc.status_code
        )

    # Production: serve the static frontend at / (docs/ARCHITECTURE.md section 1).
    # Mounted after the API routers, so /api routes always win.
    if frontend_dir is not None and (frontend_dir / "index.html").is_file():
        app.mount("/", FrontendFiles(directory=frontend_dir, html=True), name="frontend")

    # Starlette runs the last added middleware first: TrustedHost, then CORS, then the guard.
    app.add_middleware(ClientGuardMiddleware, origins=allowed_origins(config))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[config.dev_origin] if config.dev_origin else [],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
    return app


app = create_app()
