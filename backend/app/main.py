"""FastAPI application factory for Dar al Ilm.

Run with: `uvicorn app.main:app --host 127.0.0.1 --port 8000` from `backend/`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.config import AppConfig, load_config
from app.database import init_db
from app.routers import bootstrap, books, categories, health, settings, uploads
from app.security import (
    ALLOWED_HOSTS,
    ApiError,
    ClientGuardMiddleware,
    allowed_origins,
    error_body,
)


def create_app(config: AppConfig | None = None) -> FastAPI:
    config = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = init_db(config)
        try:
            yield
        finally:
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
