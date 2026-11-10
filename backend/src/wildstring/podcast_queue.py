"""Personal podcast inbox, ordered play queue and per-show new-episode delivery.

See contracts/podcast-queue.md. This is an independent channel: the music
playback snapshot (playback_states) and its track validation are untouched.
"""

import json
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from wildstring.podcast_access import require_programme

ACTION_PATTERN = "^(inbox|queue_last|queue_next|ignore)$"
ORDER_PATTERN = "^(follow|asc|desc|off)$"
GLOBAL_SHOW = ""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _episode_podcast(connection, user_id: str, episode_id: str) -> str | None:
    """Return the episode's show when the user may access it, else None."""
    row = connection.execute(
        "SELECT podcast_id FROM podcast_episodes WHERE id=?", (episode_id,)
    ).fetchone()
    if row is None:
        return None
    try:
        require_programme(connection, user_id, row["podcast_id"])
    except HTTPException:
        return None
    return row["podcast_id"]


def _add_inbox(connection, user_id, episode_id, podcast_id, source) -> None:
    connection.execute(
        """INSERT OR IGNORE INTO podcast_inbox
           (user_id, episode_id, podcast_id, source, added_at) VALUES (?,?,?,?,?)""",
        (user_id, episode_id, podcast_id, source, _now()),
    )


def _queue_rows(connection, user_id):
    row = connection.execute(
        "SELECT items_json, version, device_id, updated_at FROM podcast_queue_state WHERE user_id=?",
        (user_id,),
    ).fetchone()
    if row is None:
        return [], 0, "", None
    try:
        items = json.loads(row["items_json"])
    except (TypeError, ValueError):
        items = []
    return items, row["version"], row["device_id"], row["updated_at"]


def _save_queue(connection, user_id, items, device_id, version) -> None:
    connection.execute(
        """INSERT INTO podcast_queue_state
           (user_id, items_json, version, device_id, updated_at) VALUES (?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET
             items_json=excluded.items_json,
             version=excluded.version,
             device_id=excluded.device_id,
             updated_at=excluded.updated_at""",
        (user_id, json.dumps(items, separators=(",", ":")), version, device_id, _now()),
    )


def _prefs(connection, user_id, podcast_id):
    row = connection.execute(
        """SELECT action, auto_limit, episode_order, skip_completed, auto_continue
           FROM podcast_queue_prefs WHERE user_id=? AND podcast_id=?""",
        (user_id, podcast_id),
    ).fetchone()
    if row is None:
        row = connection.execute(
            """SELECT action, auto_limit, episode_order, skip_completed, auto_continue
               FROM podcast_queue_prefs WHERE user_id=? AND podcast_id=?""",
            (user_id, GLOBAL_SHOW),
        ).fetchone()
    if row is None:
        return {
            "action": "inbox",
            "auto_limit": 3,
            "order": "follow",
            "skip_completed": True,
            "auto_continue": True,
        }
    return {
        "action": row["action"],
        "auto_limit": row["auto_limit"],
        "order": row["episode_order"],
        "skip_completed": bool(row["skip_completed"]),
        "auto_continue": bool(row["auto_continue"]),
    }


def ensure_baseline(connection, user_id, podcast_id) -> None:
    """Mark every episode existing at follow time as historical for this user."""
    connection.execute(
        """INSERT OR IGNORE INTO podcast_inbox_baseline
           (user_id, podcast_id, completed_at) VALUES (?,?,?)""",
        (user_id, podcast_id, _now()),
    )


def distribute_new_episodes(connection, podcast_id, episode_ids) -> int:
    """Deliver freshly inserted episodes to followers according to their show settings.

    Called inside the RSS refresh transaction. Episode identity, not publication
    date, decides what counts as new; see the baseline rule in the contract.
    """
    if not episode_ids:
        return 0
    followers = [
        row["user_id"]
        for row in connection.execute(
            "SELECT user_id FROM podcast_follows WHERE podcast_id=?", (podcast_id,)
        )
    ]
    delivered = 0
    for user_id in followers:
        baseline = connection.execute(
            "SELECT 1 FROM podcast_inbox_baseline WHERE user_id=? AND podcast_id=?",
            (user_id, podcast_id),
        ).fetchone()
        if baseline is None:
            continue
        preference = _prefs(connection, user_id, podcast_id)
        action = preference["action"]
        if action == "ignore":
            continue
        if action == "inbox":
            for episode_id in episode_ids:
                _add_inbox(connection, user_id, episode_id, podcast_id, "rule")
            delivered += 1
            continue
        items, version, device_id, _ = _queue_rows(connection, user_id)
        for episode_id in episode_ids:
            entry = {"episode_id": episode_id, "origin": "rule", "added_at": _now()}
            if action == "queue_next":
                items.insert(min(1, len(items)), entry)
            else:
                items.append(entry)
        rule_positions = []
        for index, item in enumerate(items):
            if item.get("origin") != "rule":
                continue
            row = connection.execute(
                "SELECT podcast_id FROM podcast_episodes WHERE id=?", (item["episode_id"],)
            ).fetchone()
            if row is not None and row["podcast_id"] == podcast_id:
                rule_positions.append(index)
        overflow = len(rule_positions) - max(0, preference["auto_limit"])
        if overflow > 0:
            for index in reversed(rule_positions[:overflow]):
                moved = items.pop(index)
                _add_inbox(connection, user_id, moved["episode_id"], podcast_id, "rule")
        _save_queue(connection, user_id, items, device_id, version + 1)
        delivered += 1
    return delivered


class QueueItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    episode_id: str = Field(min_length=1, max_length=128)
    origin: str = Field(default="manual", pattern="^(manual|rule)$")
    # Preserved across rewrites so the unified pending list can sort by join time.
    added_at: str = Field(default="", max_length=64)


class QueueUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0)
    device_id: str = Field(default="", max_length=128)
    items: list[QueueItem] = Field(default_factory=list, max_length=5000)


class ShowPreference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(default="inbox", pattern=ACTION_PATTERN)
    auto_limit: int = Field(default=3, ge=0, le=100)
    order: str = Field(default="follow", pattern=ORDER_PATTERN)
    skip_completed: bool = True
    auto_continue: bool = True


class PreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    default_action: str = Field(default="inbox", pattern=ACTION_PATTERN)
    auto_limit: int = Field(default=3, ge=0, le=100)
    # Account-wide playback default. Show rows may override auto_continue.
    auto_continue: bool = True
    shows: dict[str, ShowPreference] = Field(default_factory=dict)


def _write_pref(connection, user_id, podcast_id, preference) -> None:
    connection.execute(
        """INSERT INTO podcast_queue_prefs
           (user_id, podcast_id, action, auto_limit, episode_order, skip_completed, auto_continue)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(user_id, podcast_id) DO UPDATE SET
             action=excluded.action,
             auto_limit=excluded.auto_limit,
             episode_order=excluded.episode_order,
             skip_completed=excluded.skip_completed,
             auto_continue=excluded.auto_continue""",
        (
            user_id,
            podcast_id,
            preference.action,
            preference.auto_limit,
            preference.order,
            int(preference.skip_completed),
            int(preference.auto_continue),
        ),
    )


def _read_prefs(connection, user_id):
    global_row = connection.execute(
        """SELECT action, auto_limit, auto_continue FROM podcast_queue_prefs
           WHERE user_id=? AND podcast_id=?""",
        (user_id, GLOBAL_SHOW),
    ).fetchone()
    shows = {}
    for row in connection.execute(
        """SELECT podcast_id, action, auto_limit, episode_order, skip_completed, auto_continue
           FROM podcast_queue_prefs WHERE user_id=? AND podcast_id<>?""",
        (user_id, GLOBAL_SHOW),
    ):
        shows[row["podcast_id"]] = {
            "action": row["action"],
            "auto_limit": row["auto_limit"],
            "order": row["episode_order"],
            "skip_completed": bool(row["skip_completed"]),
            "auto_continue": bool(row["auto_continue"]),
        }
    return {
        "default_action": global_row["action"] if global_row else "inbox",
        "auto_limit": global_row["auto_limit"] if global_row else 3,
        "auto_continue": bool(global_row["auto_continue"]) if global_row else True,
        "shows": shows,
    }


def routes(router: APIRouter, auth: Any, database: Any) -> None:
    session = auth.require_session

    @router.get("/inbox")
    def get_inbox(user: Annotated[dict, Depends(session)]):
        with database.connect() as connection:
            rows = connection.execute(
                """SELECT episode_id, podcast_id, source, added_at FROM podcast_inbox
                   WHERE user_id=? ORDER BY added_at DESC""",
                (user["id"],),
            ).fetchall()
            _, version, _, _ = _queue_rows(connection, user["id"])
        return {"version": version, "items": [dict(row) for row in rows]}

    @router.put("/inbox/items/{episode_id}", dependencies=[Depends(auth.require_client)])
    def add_inbox_item(episode_id: str, user: Annotated[dict, Depends(session)]):
        with database.connect(write=True) as connection:
            podcast_id = _episode_podcast(connection, user["id"], episode_id)
            if podcast_id is None:
                raise HTTPException(422, "episode_unavailable")
            _add_inbox(connection, user["id"], episode_id, podcast_id, "manual")
        return {"episode_id": episode_id, "saved": True}

    @router.delete("/inbox/items/{episode_id}", dependencies=[Depends(auth.require_client)])
    def remove_inbox_item(episode_id: str, user: Annotated[dict, Depends(session)]):
        with database.connect(write=True) as connection:
            connection.execute(
                "DELETE FROM podcast_inbox WHERE user_id=? AND episode_id=?",
                (user["id"], episode_id),
            )
        return {"episode_id": episode_id, "saved": False}

    @router.get("/queue")
    def get_queue(user: Annotated[dict, Depends(session)]):
        with database.connect() as connection:
            items, version, device_id, updated_at = _queue_rows(connection, user["id"])
        return {
            "version": version,
            "device_id": device_id,
            "items": items,
            "updated_at": updated_at,
        }

    @router.put("/queue", dependencies=[Depends(auth.require_client)])
    def put_queue(body: QueueUpdate, user: Annotated[dict, Depends(session)]):
        with database.connect(write=True) as connection:
            connection.execute("BEGIN IMMEDIATE")
            items, version, _, updated_at = _queue_rows(connection, user["id"])
            if body.version != version:
                raise HTTPException(
                    409,
                    {
                        "code": "podcast_queue_conflict",
                        "current": {"version": version, "items": items},
                    },
                )
            previous = {
                entry.get("episode_id"): entry.get("added_at", "")
                for entry in items
                if isinstance(entry, dict)
            }
            # Legacy entries carry no timestamp; keep them ahead of newly joined ones.
            fallback = updated_at or _now()
            clean = []
            for item in body.items:
                if _episode_podcast(connection, user["id"], item.episode_id) is None:
                    raise HTTPException(422, "episode_unavailable")
                clean.append(
                    {
                        "episode_id": item.episode_id,
                        "origin": item.origin,
                        "added_at": item.added_at or previous.get(item.episode_id) or fallback,
                    }
                )
            _save_queue(connection, user["id"], clean, body.device_id, version + 1)
            connection.executemany(
                "DELETE FROM podcast_inbox WHERE user_id=? AND episode_id=?",
                [(user["id"], entry["episode_id"]) for entry in clean],
            )
        return {"version": version + 1, "items": clean}

    @router.get("/queue/preferences")
    def get_preferences(user: Annotated[dict, Depends(session)]):
        with database.connect() as connection:
            return _read_prefs(connection, user["id"])

    @router.put("/queue/preferences", dependencies=[Depends(auth.require_client)])
    def put_preferences(body: PreferencesUpdate, user: Annotated[dict, Depends(session)]):
        with database.connect(write=True) as connection:
            valid_shows: list[tuple[str, ShowPreference]] = []
            for podcast_id, preference in body.shows.items():
                if not podcast_id:
                    continue
                try:
                    require_programme(connection, user["id"], podcast_id)
                except HTTPException as error:
                    raise HTTPException(422, "podcast_unavailable") from error
                valid_shows.append((podcast_id, preference))
            connection.execute(
                "DELETE FROM podcast_queue_prefs WHERE user_id=? AND podcast_id<>?",
                (user["id"], GLOBAL_SHOW),
            )
            _write_pref(
                connection,
                user["id"],
                GLOBAL_SHOW,
                ShowPreference(
                    action=body.default_action,
                    auto_limit=body.auto_limit,
                    auto_continue=body.auto_continue,
                ),
            )
            for podcast_id, preference in valid_shows:
                _write_pref(connection, user["id"], podcast_id, preference)
            return _read_prefs(connection, user["id"])
