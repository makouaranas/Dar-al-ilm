"""GET /api/health: used by the UI connection badge and the launcher."""

from fastapi import APIRouter

from app.config import API_VERSION

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, object]:
    return {"status": "ok", "api_version": API_VERSION}
