"""Category CRUD (docs/ARCHITECTURE.md section 6.3)."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from app.database import immediate_session
from app.models import Book, Category
from app.schemas import CategoryIn, CategoryOut, category_name_key, category_out
from app.security import ApiError
from app.shelving import move_books

router = APIRouter(prefix="/categories", tags=["categories"])

def _name_taken() -> ApiError:
    return ApiError(409, "category_name_taken", "A category with this name already exists.")


def book_counts(session: Session) -> dict[int, int]:
    rows = session.exec(select(Book.category_id, func.count()).group_by(Book.category_id)).all()
    return {category_id: count for category_id, count in rows}


def _get_category(session: Session, category_id: int) -> Category:
    category = session.get(Category, category_id)
    if category is None:
        raise ApiError(404, "category_not_found", f"Category {category_id} does not exist.")
    return category


def _ensure_name_free(session: Session, name_key: str, exclude_id: int | None = None) -> None:
    query = select(Category.id).where(Category.name_key == name_key)
    if exclude_id is not None:
        query = query.where(Category.id != exclude_id)
    if session.exec(query).first() is not None:
        raise _name_taken()


@router.post("", status_code=201, response_model=CategoryOut)
def create_category(body: CategoryIn, request: Request) -> CategoryOut:
    name_key = category_name_key(body.name)
    try:
        with immediate_session(request.app.state.engine) as session:
            _ensure_name_free(session, name_key)
            highest = session.exec(select(func.max(Category.column_index))).one()
            category = Category(
                name=body.name,
                name_key=name_key,
                column_index=0 if highest is None else highest + 1,
            )
            session.add(category)
            session.flush()
            result = category_out(category, book_count=0)
    except IntegrityError as exc:
        raise _name_taken() from exc
    return result


@router.patch("/{category_id}", response_model=CategoryOut)
def rename_category(category_id: int, body: CategoryIn, request: Request) -> CategoryOut:
    name_key = category_name_key(body.name)
    try:
        with immediate_session(request.app.state.engine) as session:
            category = _get_category(session, category_id)
            _ensure_name_free(session, name_key, exclude_id=category_id)
            category.name = body.name
            category.name_key = name_key
            session.add(category)
            session.flush()
            result = category_out(category, book_counts(session).get(category_id, 0))
    except IntegrityError as exc:
        raise _name_taken() from exc
    return result


@router.delete("/{category_id}", status_code=204)
def delete_category(
    category_id: int,
    request: Request,
    move_to: int | None = Query(default=None, description="Category that receives the books"),
) -> Response:
    if move_to is not None and move_to == category_id:
        raise RequestValidationError(
            [
                {
                    "type": "value_error",
                    "loc": ("query", "move_to"),
                    "msg": "move_to must be a different category",
                    "input": move_to,
                }
            ]
        )

    with immediate_session(request.app.state.engine) as session:
        category = _get_category(session, category_id)
        target = _get_category(session, move_to) if move_to is not None else None

        books = session.exec(
            select(Book).where(Book.category_id == category_id).order_by(col(Book.id))
        ).all()
        if books:
            if target is None:
                raise ApiError(
                    409,
                    "category_not_empty",
                    f"Category {category_id} still has books. Move them first.",
                    book_count=len(books),
                )
            assert target.id is not None
            move_books(session, books, target.id)

        deleted_index = category.column_index
        session.delete(category)
        session.flush()
        # Keep column_index contiguous so the hall has no gap.
        session.exec(
            update(Category)
            .where(col(Category.column_index) > deleted_index)
            .values(column_index=col(Category.column_index) - 1)
        )
    return Response(status_code=204)
