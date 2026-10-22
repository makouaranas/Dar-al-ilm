"""GET /api/bootstrap: everything the frontend needs on startup, in one payload."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlmodel import Session, col, select

from app.config import API_VERSION
from app.database import get_session
from app.models import AppSetting, Book, Category
from app.routers.categories import book_counts
from app.schemas import BootstrapOut, book_out, category_out, settings_out

router = APIRouter(tags=["bootstrap"])

CURRENTLY_READING_LIMIT = 3


@router.get("/bootstrap", response_model=BootstrapOut)
def bootstrap(request: Request, session: Session = Depends(get_session)) -> BootstrapOut:
    data_dir = request.app.state.config.data_dir
    counts = book_counts(session)
    categories = session.exec(select(Category).order_by(col(Category.column_index))).all()
    books = session.exec(select(Book).order_by(col(Book.id))).all()
    # 1st = most recently opened; books never opened are not on the desk.
    currently_reading = session.exec(
        select(Book.id)
        .where(col(Book.last_opened_at).is_not(None))
        .order_by(col(Book.last_opened_at).desc(), col(Book.id).desc())
        .limit(CURRENTLY_READING_LIMIT)
    ).all()
    setting = session.get(AppSetting, 1)
    assert setting is not None, "init_db() creates the singleton settings row"

    return BootstrapOut(
        categories=[category_out(c, counts.get(c.id or 0, 0)) for c in categories],
        books=[book_out(b, data_dir) for b in books],
        currently_reading=[book_id for book_id in currently_reading if book_id is not None],
        settings=settings_out(setting),
        api_version=API_VERSION,
    )
