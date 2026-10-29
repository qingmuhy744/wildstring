"""Personal catalogue access is checked separately from shared file storage."""

from fastapi import HTTPException


def catalog_manager(db, user_id):
    row = db.execute("SELECT profile,enabled FROM users WHERE id=?", (user_id,)).fetchone()
    return bool(row and row["enabled"] and row["profile"] in {"owner", "librarian"})


def personal_ids(db, user_id):
    return {
        row[0]
        for row in db.execute(
            "SELECT podcast_id FROM podcast_user_catalog WHERE user_id=?", (user_id,)
        )
    }


def require_programme(db, user_id, podcast_id):
    if (
        not catalog_manager(db, user_id)
        and not db.execute(
            "SELECT 1 FROM podcast_user_catalog WHERE user_id=? AND podcast_id=?",
            (user_id, podcast_id),
        ).fetchone()
    ):
        raise HTTPException(404, "podcast_not_found")
    if not db.execute("SELECT 1 FROM podcasts WHERE id=?", (podcast_id,)).fetchone():
        raise HTTPException(404, "podcast_not_found")


def require_episode(db, user_id, episode_id):
    row = db.execute("SELECT podcast_id FROM podcast_episodes WHERE id=?", (episode_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "episode_not_found")
    require_programme(db, user_id, row[0])
    return row[0]


def admit(db, user_id, podcast_id):
    db.execute(
        "INSERT OR IGNORE INTO podcast_user_catalog(user_id,podcast_id) VALUES (?,?)",
        (user_id, podcast_id),
    )
