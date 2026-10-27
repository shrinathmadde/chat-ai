"""Reports a radiologist chose to share for evaluation (modules.radiologyFeedback).

One row per report, in an SQLite file at radiologyFeedbackPath (back.json). The row id is
generated in the browser and kept with the report there: sending again after further edits
replaces the row, and the same id withdraws it. Nothing about the radiologist is stored.

For evaluation, read it with e.g. pandas.read_sql("select * from feedback", sqlite3.connect(path));
edit_log and reasoning are JSON text.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback (
    id                   TEXT PRIMARY KEY,
    created_at           TEXT NOT NULL,  -- UTC, ISO 8601
    updated_at           TEXT NOT NULL,
    rating               INTEGER,        -- 1 thumbs up, -1 thumbs down, NULL none
    comment              TEXT NOT NULL,  -- the radiologist's comments and suggestions
    previous_report      TEXT NOT NULL,
    dictation            TEXT NOT NULL,
    assessment           TEXT NOT NULL,  -- empty: the model wrote it (assessment_generated)
    generated_report     TEXT,           -- NULL for reports from before the editor kept it
    final_report         TEXT NOT NULL,  -- with the radiologist's edits
    assessment_generated INTEGER NOT NULL,
    edit_log             TEXT,
    model                TEXT NOT NULL,
    reasoning            TEXT,
    app_version          TEXT NOT NULL
)
"""

# Every column the caller sets; id and the timestamps are handled here
COLUMNS = (
    "rating", "comment", "previous_report", "dictation", "assessment",
    "generated_report", "final_report", "assessment_generated", "edit_log", "model",
    "reasoning", "app_version",
)
JSON_COLUMNS = ("edit_log", "reasoning")

UPSERT = f"""
INSERT INTO feedback (id, created_at, updated_at, {", ".join(COLUMNS)})
VALUES (:id, :now, :now, {", ".join(":" + column for column in COLUMNS)})
ON CONFLICT (id) DO UPDATE SET
    updated_at = :now, {", ".join(f"{column} = excluded.{column}" for column in COLUMNS)}
"""


def connect(path: str | Path) -> sqlite3.Connection:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    # Readable by the service's own user only: the rows hold patient data
    file.touch(mode=0o600, exist_ok=True)
    connection = sqlite3.connect(file)
    connection.execute(SCHEMA)
    return connection


def save(path: str | Path, record: dict) -> None:
    """Store one shared report, or replace the one with the same id."""
    row = {column: record.get(column) for column in ("id", *COLUMNS)}
    for column in JSON_COLUMNS:
        if row[column] is not None:
            row[column] = json.dumps(row[column], ensure_ascii=False)
    row["now"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with closing(connect(path)) as connection, connection:
        connection.execute(UPSERT, row)


def delete(path: str | Path, feedback_id: str) -> bool:
    """Withdraw a shared report. False if there was none with this id."""
    with closing(connect(path)) as connection, connection:
        return connection.execute("DELETE FROM feedback WHERE id = ?", (feedback_id,)).rowcount > 0
