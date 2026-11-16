"""Account-wide podcast resume preference; clients keep only an offline cache."""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from wildstring.library.repository import now

SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS podcast_resume_prefs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    resume_mode TEXT NOT NULL CHECK(resume_mode IN ('auto', 'ask', 'restart')),
    updated_at TEXT NOT NULL
);
PRAGMA user_version=54;
COMMIT;
"""


class ResumePreference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resume_mode: Literal["auto", "ask", "restart"]


def get_resume_preference(database, user_id):
    with database.connect() as connection:
        row = connection.execute(
            "SELECT resume_mode FROM podcast_resume_prefs WHERE user_id=?", (user_id,)
        ).fetchone()
    return ResumePreference(resume_mode=row["resume_mode"] if row else "auto")


def save_resume_preference(database, user_id, body: ResumePreference):
    with database.connect(write=True) as connection:
        connection.execute(
            """INSERT INTO podcast_resume_prefs(user_id, resume_mode, updated_at) VALUES (?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET
                 resume_mode=excluded.resume_mode, updated_at=excluded.updated_at""",
            (user_id, body.resume_mode, now()),
        )
    return body
