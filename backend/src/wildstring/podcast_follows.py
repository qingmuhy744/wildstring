"""Personal follows over the shared programme and episode catalog."""

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field


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


def follow(database, user_id, podcast_id, followed):
    with database.connect(write=True) as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT id FROM podcasts WHERE id=?", (podcast_id,)).fetchone() is None:
            raise HTTPException(404, "播客未找到")
        if followed:
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


def cache_no_longer_needed(connection, episode_id):
    return bool(
        connection.execute(
            """SELECT
        EXISTS(SELECT 1 FROM podcast_follows f JOIN users u ON u.id=f.user_id AND u.enabled=1
          WHERE f.podcast_id=e.podcast_id)
        AND NOT EXISTS(SELECT 1 FROM podcast_follows f JOIN users u ON u.id=f.user_id AND u.enabled=1
          LEFT JOIN podcast_progress pr ON pr.user_id=f.user_id AND pr.episode_id=e.id
          WHERE f.podcast_id=e.podcast_id AND COALESCE(pr.completed,0)=0)
        AND NOT EXISTS(SELECT 1 FROM podcast_progress pr JOIN users u ON u.id=pr.user_id AND u.enabled=1
          WHERE pr.episode_id=e.id AND pr.completed=0)
        FROM podcast_episodes e WHERE e.id=?""",
            (episode_id,),
        ).fetchone()[0]
    )
