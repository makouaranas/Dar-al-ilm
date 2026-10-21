"""Request guards that keep other websites away from the local API.

docs/ARCHITECTURE.md section 7:
- DNS rebinding: only the Host values 127.0.0.1 and localhost are accepted
  (TrustedHostMiddleware, configured in main.py with ALLOWED_HOSTS).
- Cross-site requests: mutating requests must send `X-Dar-Client: 1`, which forces a
  CORS preflight, and an `Origin` header, when present, must be the app's own origin.
"""

from __future__ import annotations

from typing import Any

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import AppConfig

ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
CLIENT_HEADER = "x-dar-client"


def error_body(code: str, message: str, **extra: Any) -> dict[str, Any]:
    """Domain error envelope: {"detail": {"code", "message", ...extra}}."""
    return {"detail": {"code": code, "message": message, **extra}}


def allowed_origins(config: AppConfig) -> frozenset[str]:
    origins = {f"http://127.0.0.1:{config.port}", f"http://localhost:{config.port}"}
    if config.dev_origin:
        origins.add(config.dev_origin)
    return frozenset(origins)


class ClientGuardMiddleware:
    """Rejects mutating /api requests from foreign origins or without X-Dar-Client."""

    def __init__(self, app: ASGIApp, origins: frozenset[str]) -> None:
        self.app = app
        self.origins = origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope["method"] in MUTATING_METHODS
            and scope["path"].startswith("/api")
        ):
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            if origin is not None and origin not in self.origins:
                response = JSONResponse(
                    error_body("forbidden_origin", "Requests from this origin are not allowed."),
                    status_code=403,
                )
                await response(scope, receive, send)
                return
            if headers.get(CLIENT_HEADER) != "1":
                response = JSONResponse(
                    error_body("forbidden_client", "Missing the X-Dar-Client header."),
                    status_code=403,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
