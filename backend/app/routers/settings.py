"""PATCH /api/settings (docs/ARCHITECTURE.md section 6.3)."""

from __future__ import annotations

from fastapi import APIRouter, Request

from app.database import immediate_session
from app.models import AppSetting
from app.schemas import SettingsOut, SettingsPatch, settings_out

router = APIRouter(prefix="/settings", tags=["settings"])


@router.patch("", response_model=SettingsOut)
def update_settings(body: SettingsPatch, request: Request) -> SettingsOut:
    changes = body.model_dump(exclude_unset=True)
    with immediate_session(request.app.state.engine) as session:
        setting = session.get(AppSetting, 1)
        assert setting is not None, "init_db() creates the singleton settings row"
        for field, value in changes.items():
            setattr(setting, field, value)
        session.add(setting)
        session.flush()
        result = settings_out(setting)
    return result
