"""First-free-slot shelf allocation (docs/ARCHITECTURE.md section 9.1).

Callers must run inside `immediate_session()` so the read of occupied slots and the
write of the new slot happen under the same write lock. The
UNIQUE(category_id, shelf_number, slot_index) constraint is the final guard.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlmodel import Session, select

from app.models import Book

SLOTS_PER_SHELF = 30

Slot = tuple[int, int]  # (shelf_number, slot_index)


def first_free_slot(occupied: Iterable[Slot]) -> Slot:
    """Lowest (shelf_number, slot_index) not in `occupied`."""
    taken = set(occupied)
    shelf = 0
    while True:
        for slot in range(SLOTS_PER_SHELF):
            if (shelf, slot) not in taken:
                return shelf, slot
        shelf += 1


def occupied_slots(session: Session, category_id: int) -> set[Slot]:
    rows = session.exec(
        select(Book.shelf_number, Book.slot_index).where(Book.category_id == category_id)
    ).all()
    return {(shelf, slot) for shelf, slot in rows}


def allocate_slot(session: Session, category_id: int) -> Slot:
    """Next free slot in a category. Call inside `immediate_session()`."""
    return first_free_slot(occupied_slots(session, category_id))


def move_books(session: Session, books: Iterable[Book], target_category_id: int) -> None:
    """Move books (in the given order) into the first free slots of another category."""
    taken = occupied_slots(session, target_category_id)
    for book in books:
        shelf, slot = first_free_slot(taken)
        taken.add((shelf, slot))
        book.category_id = target_category_id
        book.shelf_number = shelf
        book.slot_index = slot
        session.add(book)
    session.flush()
