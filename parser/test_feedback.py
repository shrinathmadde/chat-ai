"""Checks for the store of shared reports (feedback_store.py) and its routes.

    python test_feedback.py        (or: python -m pytest test_feedback.py)
"""

from __future__ import annotations

import json
import sqlite3
import stat
import tempfile
from pathlib import Path

import feedback_store

ID = "0b6f2b5e-7c1d-4a8e-9f3a-2d4c6e8a1b3c"

RECORD = {
    "id": ID,
    "rating": -1,
    "comment": "Lymphknoten fehlt.",
    "previous_report": "Befund:\nLunge: Kein Rundherd.\n\nBeurteilung:\n1. Kein Tumornachweis.",
    "dictation": "Neu 12 mm LK paratracheal.",
    "assessment": "",
    "generated_report": "Befund:\nLunge: Kein Rundherd.\n\nBeurteilung:\n1. Kein Tumornachweis.",
    "final_report": "Befund:\nLunge: Kein Rundherd.\nLymphknoten: Neu 12 mm LK paratracheal.\n\nBeurteilung:\n1. Neu LK.",
    "assessment_generated": True,
    "edit_log": [{"section": "Befund > Lunge", "status": "kept"}],
    "model": "qwen3-30b-a3b-instruct-2507",
    "reasoning": {"reasoning_effort": "low"},
    "app_version": "1.0.0",
}


def rows(path: Path) -> list[dict]:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in connection.execute("SELECT * FROM feedback")]
    finally:
        connection.close()


def test_save_creates_file_readable_by_owner_only() -> None:
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "data" / "feedback.sqlite"
        feedback_store.save(path, RECORD)
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        [row] = rows(path)
        assert row["final_report"] == RECORD["final_report"]
        assert row["rating"] == -1 and row["assessment_generated"] == 1
        assert json.loads(row["edit_log"]) == RECORD["edit_log"]
        assert json.loads(row["reasoning"]) == {"reasoning_effort": "low"}


def test_save_again_replaces_and_keeps_created_at() -> None:
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "feedback.sqlite"
        feedback_store.save(path, RECORD)
        [first] = rows(path)
        feedback_store.save(path, {**RECORD, "rating": 1, "final_report": "Neu."})
        [row] = rows(path)
        assert row["rating"] == 1 and row["final_report"] == "Neu."
        assert row["created_at"] == first["created_at"]


def test_missing_optional_values_are_null() -> None:
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "feedback.sqlite"
        feedback_store.save(path, {**RECORD, "rating": None, "generated_report": None, "edit_log": None})
        [row] = rows(path)
        assert row["rating"] is None and row["generated_report"] is None and row["edit_log"] is None


def test_delete_withdraws_only_that_report() -> None:
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "feedback.sqlite"
        other = "7e2a9c41-3b5d-4f60-8a1e-c9d2b4f6e803"
        feedback_store.save(path, RECORD)
        feedback_store.save(path, {**RECORD, "id": other})
        assert feedback_store.delete(path, ID)
        assert not feedback_store.delete(path, ID)
        assert [row["id"] for row in rows(path)] == [other]


def test_request_validation() -> None:
    from pydantic import ValidationError

    from app import Feedback

    for bad in ({"id": "../x"}, {"id": ID.upper()}, {"rating": 5}, {"final_report": None}):
        try:
            Feedback(**{**RECORD, **bad})
        except ValidationError:
            continue
        raise AssertionError(f"accepted {bad}")


def test_routes() -> None:
    from fastapi import HTTPException

    import app

    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "feedback.sqlite"
        saved = app.FEEDBACK_PATH
        try:
            app.FEEDBACK_PATH = ""
            try:
                app.feedback(app.Feedback(**RECORD))
                raise AssertionError("stored without radiologyFeedbackPath")
            except HTTPException as error:
                assert error.status_code == 503

            app.FEEDBACK_PATH = str(path)
            assert app.feedback(app.Feedback(**RECORD)) == {"id": ID}
            assert app.withdraw_feedback(ID) == {"id": ID, "deleted": True}
            assert app.withdraw_feedback(ID) == {"id": ID, "deleted": False}
            assert rows(path) == []
        finally:
            app.FEEDBACK_PATH = saved


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"ok  {test.__name__}")
    print(f"\n{len(tests)} passed")
