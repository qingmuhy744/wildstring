"""Personal follows over the shared programme and episode catalog."""

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.podcast_access import admit, require_programme


class FollowUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    followed: bool = Field(strict=True)


def followed_ids(database, user_id):
    with database.connect() as db:
        return {
            r[0]
            for r in db.execute(
                "SELECT podcast_id FROM podcast_follows WHERE user_id=?", (user_id,)
            )
        }


def follow(database, user_id, podcast_id, followed, *, admitted=False):
    with database.connect(write=True) as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT id FROM podcasts WHERE id=?", (podcast_id,)).fetchone() is None:
            raise HTTPException(404, "播客未找到")
        if not admitted:
            require_programme(db, user_id, podcast_id)
        if followed:
            admit(db, user_id, podcast_id)
            db.execute(
                "INSERT OR IGNORE INTO podcast_follows(user_id,podcast_id) VALUES (?,?)",
                (user_id, podcast_id),
            )
        else:
            db.execute(
                "DELETE FROM podcast_follows WHERE user_id=? AND podcast_id=?",
                (user_id, podcast_id),
            )
    return {"podcast_id": podcast_id, "followed": followed}
